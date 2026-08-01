// llm.js 台词链回归测试：请求预算（超时/max_tokens）、tolk/submitText 字段类型与长度归一、
// 连续失败退避与日志节流。providers 层整体打桩，不发真实请求、不需要 Electron。
const test = require("node:test");
const assert = require("node:assert/strict");

// llm.js 顶层持有 providers 模块引用，先 require providers 并就地替换方法再加载 llm.js
const providers = require("../src/service/llm/providers.js");
providers.getChatProvider = () => ({
  id: "stub",
  type: "openai",
  baseUrl: "http://stub.invalid/v1",
  apiKey: "stub-key",
  model: "stub-model",
});

global.getSys = (k) => (k === "llmEnabled" ? true : undefined);

const {
  __LLMService: LLMService,
  __TIMEOUT_MS: TIMEOUT_MS,
  __MAX_TOLK_LEN: MAX_TOLK_LEN,
  __MAX_SUBMIT_LEN: MAX_SUBMIT_LEN,
  __FAILURE_THRESHOLD: FAILURE_THRESHOLD,
  __FAILURE_COOLDOWN_MS: FAILURE_COOLDOWN_MS,
} = require("../src/service/llm.js");

// 让 providers.chat 返回指定的模型原文（字符串），并记录收到的参数
function stubChatText(text) {
  const calls = [];
  providers.chat = async (args) => {
    calls.push(args);
    return typeof text === "function" ? text(calls.length) : text;
  };
  return calls;
}

function stubChatReject(err) {
  const calls = [];
  providers.chat = async (args) => {
    calls.push(args);
    throw err instanceof Error ? err : new Error(String(err));
  };
  return calls;
}

function captureErrors() {
  const orig = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.map(String).join(" "));
  return {
    errors,
    restore() {
      console.error = orig;
    },
  };
}

// —— 请求预算 ——

test("台词请求的超时与 max_tokens 匹配：30s 超时配 512 输出额度（推理模型能出完）", async () => {
  const calls = stubChatText('{"tolk":"主人好呀","submitText":"嗯"}');
  const cap = captureErrors();
  try {
    const r = await new LLMService().generateOnce("smallTalk", null, null);
    assert.equal(r.tolk, "主人好呀");
    assert.equal(calls.length, 1);
    assert.equal(TIMEOUT_MS, 30000);
    assert.equal(calls[0].timeoutMs, 30000);
    assert.equal(calls[0].maxTokens, 512);
    assert.deepEqual(cap.errors, []);
  } finally {
    cap.restore();
  }
});

// —— 字段类型归一（[object Object] 上屏防线）——

test("tolk 是对象时视为解析失败，返回 null 而不是把 [object Object] 塞进气泡", async () => {
  stubChatText('{"tolk":{"text":"主人好呀"},"submitText":"嗯"}');
  const cap = captureErrors();
  try {
    const r = await new LLMService().generateOnce("smallTalk", null, null);
    assert.equal(r, null);
    assert.equal(cap.errors.length, 1);
    assert.match(cap.errors[0], /tolk 字段不是非空字符串/);
  } finally {
    cap.restore();
  }
});

test("tolk 是数组时同样视为解析失败", async () => {
  stubChatText('{"tolk":["主人好呀"],"submitText":"嗯"}');
  const cap = captureErrors();
  try {
    assert.equal(await new LLMService().generateOnce("smallTalk", null, null), null);
    assert.equal(cap.errors.length, 1);
  } finally {
    cap.restore();
  }
});

test("tolk 只有空白字符时视为解析失败（不弹空气泡）", async () => {
  stubChatText('{"tolk":"   ","submitText":"嗯"}');
  const cap = captureErrors();
  try {
    assert.equal(await new LLMService().generateOnce("smallTalk", null, null), null);
  } finally {
    cap.restore();
  }
});

test("submitText 是对象时归一为空串，台词本身照常返回（调用方有默认按钮文案）", async () => {
  stubChatText('{"tolk":"主人抱抱我","submitText":{"text":"好的"}}');
  const cap = captureErrors();
  try {
    const r = await new LLMService().generateOnce("smallTalk", null, null);
    assert.equal(r.tolk, "主人抱抱我");
    assert.equal(r.submitText, "");
    assert.deepEqual(cap.errors, []);
  } finally {
    cap.restore();
  }
});

test("超长 tolk/submitText 被截到上限（模型跑飞时气泡不被撑爆）", async () => {
  stubChatText(
    JSON.stringify({ tolk: "长".repeat(200), submitText: "答".repeat(50) })
  );
  const cap = captureErrors();
  try {
    const r = await new LLMService().generateOnce("smallTalk", null, null);
    assert.equal(MAX_TOLK_LEN, 60);
    assert.equal(MAX_SUBMIT_LEN, 10);
    assert.equal(r.tolk.length, MAX_TOLK_LEN);
    assert.equal(r.submitText.length, MAX_SUBMIT_LEN);
  } finally {
    cap.restore();
  }
});

test("正常短台词不受归一影响，两端空白被 trim", async () => {
  stubChatText('{"tolk":"  主人我饿了  ","submitText":" 好 "}');
  const cap = captureErrors();
  try {
    const r = await new LLMService().generateOnce("stateEat", { percent: 15, value: 3, max: 20 }, null);
    assert.equal(r.tolk, "主人我饿了");
    assert.equal(r.submitText, "好");
  } finally {
    cap.restore();
  }
});

// —— 连续失败退避 + 日志节流 ——

test("连续失败达阈值后进入冷却：后续调用不再发请求，直接走离线台词", async () => {
  const calls = stubChatReject(new Error("HTTP 401: invalid api key"));
  const cap = captureErrors();
  try {
    const svc = new LLMService();
    const total = FAILURE_THRESHOLD + 4;
    for (let i = 0; i < total; i++) {
      assert.equal(await svc.generateOnce("smallTalk", null, null), null);
    }
    assert.equal(FAILURE_THRESHOLD, 3);
    assert.equal(
      calls.length,
      FAILURE_THRESHOLD,
      "阈值之后不应再发请求（原实现每个触发点都重打一次）"
    );
    // 日志节流：首次一条 + 进入冷却一条，其余静默
    assert.equal(cap.errors.length, 2);
    assert.match(cap.errors[0], /连续第 1 次/);
    assert.match(cap.errors[1], /已进入 5 分钟冷却/);
    assert.match(cap.errors[1], /invalid api key/);
  } finally {
    cap.restore();
  }
});

test("冷却期内 prefetch 不发请求也不入队", async () => {
  const calls = stubChatReject(new Error("boom"));
  const cap = captureErrors();
  try {
    const svc = new LLMService();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await svc.generateOnce("smallTalk", null, null);
    }
    assert.equal(calls.length, FAILURE_THRESHOLD);
    svc.prefetch("smallTalk", null);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, FAILURE_THRESHOLD, "冷却期内不应再发预取请求");
    assert.equal(svc.dequeue("smallTalk"), null);
  } finally {
    cap.restore();
  }
});

test("一次成功即清零失败计数，偶发抖动不会累积到冷却", async () => {
  const cap = captureErrors();
  try {
    const svc = new LLMService();
    const calls = [];
    providers.chat = async (args) => {
      calls.push(args);
      // 第 3 次成功，其余失败：2 失败 + 1 成功 + 2 失败 = 全程不该进冷却
      if (calls.length === 3) return '{"tolk":"我回来啦","submitText":"嗯"}';
      throw new Error("网络抖动");
    };
    for (let i = 0; i < 5; i++) await svc.generateOnce("smallTalk", null, null);
    assert.equal(calls.length, 5, "没进冷却时每次调用都应真的发出请求");
    assert.equal(svc._failCount, 2);
    assert.equal(svc._cooldownUntil, 0);
  } finally {
    cap.restore();
  }
});

test("冷却到期后放一次探活请求，成功即完全恢复", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const cap = captureErrors();
  try {
    const svc = new LLMService();
    const calls = [];
    let shouldFail = true;
    providers.chat = async (args) => {
      calls.push(args);
      if (shouldFail) throw new Error("HTTP 402: 余额不足");
      return '{"tolk":"充值成功啦","submitText":"嗯"}';
    };
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await svc.generateOnce("smallTalk", null, null);
    }
    assert.equal(calls.length, FAILURE_THRESHOLD);
    // 冷却未到期：不发请求
    t.mock.timers.tick(FAILURE_COOLDOWN_MS - 1000);
    assert.equal(await svc.generateOnce("smallTalk", null, null), null);
    assert.equal(calls.length, FAILURE_THRESHOLD);
    // 冷却到期：放一次探活，用户此时已充值 → 成功并复位
    t.mock.timers.tick(2000);
    shouldFail = false;
    const r = await svc.generateOnce("smallTalk", null, null);
    assert.equal(r.tolk, "充值成功啦");
    assert.equal(calls.length, FAILURE_THRESHOLD + 1);
    assert.equal(svc._failCount, 0);
    assert.equal(svc._cooldownUntil, 0);
  } finally {
    cap.restore();
  }
});
