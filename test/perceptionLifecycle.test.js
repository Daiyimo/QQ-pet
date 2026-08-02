// 感知循环生命周期回归测试（此前仓库零 start()/stop() 覆盖）。
// 覆盖两个实测到的并发缺陷：
//   ① stop() 后在途的感知结果仍被派发 → 桌宠被 hide 且再无 pet-show（永久隐藏）；
//   ② stop()+start() 让旧 tick 的 finally 又排一条 timer → 定时链叠加、截屏成倍。
// 全部走依赖注入（captureFn / chatFn），不 require 任何三方包、不碰 Electron。
const test = require("node:test");
const assert = require("node:assert");

const {
  PerceptionLoop,
  buildPerceptionResult,
  classifyPerceptionError,
  PERCEPTION_FAILURE_LOG_EVERY,
  PERCEPTION_FAILURE_NOTIFY_THRESHOLD,
  PERCEPTION_CONFIG_FAILURE_LIMIT,
} = require("../src/service/perception/loop.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一帧假截屏；每次内容都变，保证 FrameChangeDetector 判定"画面变化"从而触发感知
function fakeFrame(seq) {
  return {
    bitmap: Buffer.alloc(400, (seq * 61) % 255),
    width: 10,
    height: 10,
    pngBuffer: Buffer.from("png"),
  };
}

// 一份能让稳定器切到 game 的感知响应
const GAME_RESPONSE = JSON.stringify({
  scene: "game",
  confidence: 0.95,
  scene_evidence: { game_surface: true, interactive_gameplay: true },
  barrage: "血量见底了",
  observation: "玩家正在操作角色躲避攻击并回血",
});

test("stop() 后在途的感知结果不再派发：不 emit pet-hide、不上屏弹幕、场景不切换", async () => {
  let seq = 0;
  let resolveChat = null;
  const loop = new PerceptionLoop({
    intervalMs: 20,
    captureFn: async () => fakeFrame(++seq),
    chatFn: () => new Promise((resolve) => (resolveChat = resolve)),
  });

  const petHide = [];
  const barrages = [];
  loop.on("pet-hide", () => petHide.push(Date.now()));
  loop._showBarrage = (text) => barrages.push(text);

  loop.start();
  await sleep(60);
  assert.ok(resolveChat, "第一轮感知请求应已发出");
  resolveChat(GAME_RESPONSE); // 第 1 个 game 样本：稳定器 streak=1，还没切场景
  await sleep(60);
  assert.strictEqual(loop.stabilizer.current, "other", "单个样本不应切场景");
  assert.ok(resolveChat, "第二轮感知请求应已发出");

  // 用户此刻在设置页关闭屏幕感知
  loop.stop();
  // 关闭之后云端才把第 2 个 game 样本返回来
  resolveChat(GAME_RESPONSE);
  await sleep(120);

  assert.deepStrictEqual(petHide, [], "感知已停止，不得再 emit pet-hide（否则桌宠被永久隐藏）");
  assert.deepStrictEqual(barrages, [], "感知已停止，不得再上屏弹幕（会重建刚销毁的弹幕窗）");
  assert.strictEqual(loop._petHidden, false, "桌宠不应处于隐藏态");
  assert.strictEqual(loop.stabilizer.current, "other", "过期结果不得改变稳定场景");
  assert.strictEqual(loop.timer, null, "stop() 后不应残留 timer");
});

test("stop()+start() 不叠加定时链：窗口内只有最新运行周期的 tick 在跑", async () => {
  const CHAT_MS = 120; // 模拟"截屏+大模型"远慢于 interval 的真实情况
  const INTERVAL = 40;
  const WINDOW = 600;

  function makeLoop() {
    let seq = 0;
    const counter = { captures: 0 };
    const loop = new PerceptionLoop({
      intervalMs: INTERVAL,
      captureFn: async () => {
        counter.captures += 1;
        return fakeFrame(++seq);
      },
      chatFn: async () => {
        await sleep(CHAT_MS);
        return JSON.stringify({
          scene: "other",
          confidence: 0.3,
          scene_evidence: {},
          observation: "普通桌面操作，没有课程或游戏",
        });
      },
    });
    // 只读观测：start() 把本轮运行周期号（epoch）作为入参传给 _tick，
    // 这里把每次 tick 的 epoch 记下来，用于判定"是否有被作废的旧链还在跑"。
    // 纯测试侧包装（不改生产代码、不改运行时行为）：旧实现下旧链会带着过期 epoch
    // 继续调用 _tick，于是同一观测窗口内会出现两个不同 epoch。
    const tickEpochs = [];
    const originalTick = loop._tick.bind(loop);
    loop._tick = (epoch) => {
      tickEpochs.push(epoch);
      return originalTick(epoch);
    };
    return { loop, counter, tickEpochs };
  }

  // A. 基线：只 start 一次，测量 WINDOW 内的截屏次数
  const a = makeLoop();
  a.loop.start();
  await sleep(150);
  const baseStart = a.counter.captures;
  await sleep(WINDOW);
  const baseline = a.counter.captures - baseStart;
  a.loop.stop();
  assert.ok(baseline > 0, "基线应至少截屏一次");

  // B. 在感知请求进行中关闭再立刻打开（设置页开关的真实操作序列），重复 3 次
  const b = makeLoop();
  for (let i = 0; i < 3; i++) {
    b.loop.start();
    await sleep(60); // 此刻第一轮 tick 正卡在 chatFn 里
    b.loop.stop();
    await sleep(5);
  }
  b.loop.start();
  const liveEpoch = b.loop._epoch; // 最后一次 start() 建立的运行周期（stop() 会再自增，故先存下来）
  await sleep(300); // 留足时间让被作废的在途 tick 走完它的 finally
  const tickMark = b.tickEpochs.length;
  const toggledStart = b.counter.captures;
  await sleep(WINDOW);
  const toggled = b.counter.captures - toggledStart;
  const epochsInWindow = b.tickEpochs.slice(tickMark);

  // 主防线（确定性，不依赖时序比值）：观测窗口内跑过的 tick 必须全部属于最新运行周期。
  // 旧实现下"停止期间在途的 tick"会在重开后又排一条 timer，那条旧链带着过期 epoch
  // 继续 tick，这里就会看到两个 epoch。
  assert.ok(
    epochsInWindow.length > 0,
    "观测窗口内应至少跑过一次 tick，否则断言无意义"
  );
  assert.ok(
    epochsInWindow.every((e) => typeof e === "number"),
    "tick 应携带运行周期号（epoch 机制若被移除，这条会先红）"
  );
  assert.deepStrictEqual(
    [...new Set(epochsInWindow)],
    [liveEpoch],
    `窗口内出现了多个运行周期的 tick（${[...new Set(epochsInWindow)].join(",")}）——` +
      "说明被作废的旧定时链仍在运行，即定时链叠加"
  );

  // 辅助证据（时序比值）：修复前实测基线 4 次/600ms → 切换后 17 次/600ms（约 4~5 倍）。
  // 留 2 倍余量吸收定时器抖动；它不再是唯一防线，只用于兜住"epoch 判定被绕过"的意外情形。
  assert.ok(
    toggled <= baseline * 2,
    `切换后截屏次数（${toggled}）不应显著超过基线（${baseline}）——定时链疑似叠加`
  );

  b.loop.stop();

  // 收尾结构性断言：stop() 后不留 timer、不再截屏
  assert.strictEqual(b.loop.timer, null, "stop() 后不应残留 timer");
  const afterStop = b.counter.captures;
  await sleep(200);
  assert.strictEqual(
    b.counter.captures,
    afterStop,
    "stop() 之后不得再有任何截屏"
  );
});

test("stop() 会中断在途的感知请求（AbortSignal 被 abort）", async () => {
  let seenSignal = null;
  const loop = new PerceptionLoop({
    intervalMs: 20,
    captureFn: async () => fakeFrame(1),
    chatFn: ({ signal }) =>
      new Promise((resolve, reject) => {
        seenSignal = signal;
        if (!signal) return resolve(GAME_RESPONSE);
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
      }),
  });
  const failures = [];
  loop.on("perception-failed", (e) => failures.push(e));

  loop.start();
  await sleep(60);
  assert.ok(seenSignal, "感知请求应带上 AbortSignal");
  assert.strictEqual(seenSignal.aborted, false);

  loop.stop();
  await sleep(60);
  assert.strictEqual(seenSignal.aborted, true, "stop() 应 abort 在途请求");
  assert.strictEqual(loop.inFlight, false, "in-flight 标志应复位");
  assert.deepStrictEqual(
    failures,
    [],
    "由 stop() 主动中断造成的失败不应对外上报 perception-failed"
  );
});

test("免打扰开启时不上屏弹幕（弹幕不走 openSpeak，需自带门禁）", () => {
  const loop = new PerceptionLoop({ intervalMs: 1000 });
  const shown = [];
  const prevGetSys = global.getSys;
  const prevWindow = global.barrageWindow;
  global.barrageWindow = { show: (t) => shown.push(t) };
  try {
    loop.running = true; // 模拟感知运行中

    global.getSys = (key) => ({ doNotDisturb: true }[key]);
    loop._showBarrage("免打扰期间的弹幕");
    assert.deepStrictEqual(shown, [], "免打扰开启时不得上屏弹幕");

    global.getSys = (key) => ({ doNotDisturb: false }[key]);
    loop._showBarrage("正常弹幕");
    assert.deepStrictEqual(shown, ["正常弹幕"], "关闭免打扰后应正常上屏");

    loop.running = false;
    loop._showBarrage("停止后的弹幕");
    assert.deepStrictEqual(shown, ["正常弹幕"], "感知已停止时不得重建/使用弹幕窗");
  } finally {
    if (prevGetSys === undefined) delete global.getSys;
    else global.getSys = prevGetSys;
    if (prevWindow === undefined) delete global.barrageWindow;
    else global.barrageWindow = prevWindow;
  }
});

test("barrage_candidates 里的非字符串元素不会变成 [object Object] 弹幕", () => {
  const result = buildPerceptionResult({
    scene: "game",
    confidence: 0.9,
    scene_evidence: { game_surface: true, interactive_gameplay: true },
    observation: "玩家正在操作角色躲避攻击",
    barrage_candidates: [{ note: "结构不对的候选" }, "血量见底了", { text: "对象里带 text" }, 42],
  });
  assert.ok(
    !result.barrage_candidates.includes("[object Object]"),
    "对象候选不得被 String() 成 [object Object]"
  );
  assert.ok(result.barrage_candidates.includes("血量见底了"), "正常字符串候选应保留");
  assert.ok(
    result.barrage_candidates.includes("对象里带 text"),
    "{text} 形式的候选应取其 text 字段"
  );
});

test("正文字段被模型写成对象时按空值处理，不落 [object Object]", () => {
  const result = buildPerceptionResult({
    scene: "other",
    confidence: 0.9,
    scene_evidence: { ordinary_browsing: true },
    observation: { text: "结构不对的观察" },
    assistant_message: ["也不该是数组"],
  });
  assert.strictEqual(result.observation, "");
  assert.strictEqual(result.assistant_message, "");
});

// —— 感知失败可诊断性回归 ——
// 修复前：失败只经 this.emit("perception-failed") 外传，而全仓无任何生产监听者，
// EventEmitter 对无监听的非 error 事件静默返回 false → 用户开着屏幕感知、每轮截屏、
// 每轮失败，控制台一行日志都没有，且完全无从察觉。

// 轮询等待，避免依赖固定 sleep 时长（退避使失败间隔逐轮翻倍）
async function waitUntil(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`超时未满足条件：${label}`);
}

// 捕获 console.warn / console.error 的真实输出（拼成字符串，e.stack 会原样带进来）
function hookConsole() {
  const warns = [];
  const errors = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => warns.push(args.map((a) => String(a)).join(" "));
  console.error = (...args) => errors.push(args.map((a) => String(a)).join(" "));
  return {
    warns,
    errors,
    ours(list) {
      return list.filter((line) => line.includes("[perception/loop]"));
    },
    // 只取"单轮感知失败"那条日志（含 _logFailure 的固定尾巴），从而与 start() 时的
    // 视觉提供商预检日志区分开：两者都带 [perception/loop] 前缀，但断言的是不同行为。
    failures(list) {
      return this.ours(list).filter((line) => line.includes("本轮感知跳过"));
    },
    restore() {
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

function failingLoop(error, intervalMs = 10) {
  let seq = 0;
  return new PerceptionLoop({
    intervalMs,
    captureFn: async () => fakeFrame(++seq),
    chatFn: async () => {
      throw error();
    },
  });
}

test("未配置提供商时的感知失败会留下 warn 日志并写明降级行为（此前 100% 静默）", async () => {
  const spy = hookConsole();
  const loop = failingLoop(() => new Error("未配置 LLM 提供商"));
  try {
    loop.start();
    await waitUntil(() => loop._failures >= 1, "首轮感知失败");
  } finally {
    loop.stop();
    spy.restore();
  }
  const warns = spy.failures(spy.warns);
  assert.strictEqual(
    warns.length,
    1,
    `失败必须留日志（首次恰好一条），实际：${JSON.stringify(spy.warns)}`
  );
  assert.ok(
    warns[0].includes("未配置 LLM 提供商"),
    `日志必须带上原始错误信息，实际：${warns[0]}`
  );
  assert.ok(
    warns[0].includes("本轮感知跳过") && warns[0].includes("退避后重试"),
    `日志必须写明降级后的行为，实际：${warns[0]}`
  );
  assert.deepStrictEqual(
    spy.ours(spy.errors),
    [],
    "未配置提供商属可预期业务错误，不应记 error"
  );
});

test("意料外的感知异常记 error 且带完整堆栈", async () => {
  const spy = hookConsole();
  const loop = failingLoop(() => new Error("socket hang up"));
  try {
    loop.start();
    await waitUntil(() => loop._failures >= 1, "首轮感知失败");
  } finally {
    loop.stop();
    spy.restore();
  }
  const errors = spy.failures(spy.errors);
  assert.strictEqual(
    errors.length,
    1,
    `意料外异常必须留 error 日志，实际：${JSON.stringify(spy.errors)}`
  );
  assert.ok(
    errors[0].includes("Error: socket hang up"),
    `日志应含错误信息，实际：${errors[0]}`
  );
  assert.ok(
    errors[0].includes("\n    at "),
    `意料外异常必须记完整堆栈（含调用帧），实际：${errors[0]}`
  );
  assert.ok(errors[0].includes("本轮感知跳过"), "日志必须写明降级后的行为");
  assert.deepStrictEqual(
    spy.failures(spy.warns),
    [],
    "意料外异常不应降级成 warn"
  );
});

test("失败日志按固定次数节流，不是每轮都刷屏", () => {
  const loop = new PerceptionLoop({ intervalMs: 1000 });
  const spy = hookConsole();
  const loggedAt = [];
  const rounds = 2 * PERCEPTION_FAILURE_LOG_EVERY + 3;
  try {
    for (let n = 1; n <= rounds; n++) {
      loop._failures = n;
      const before = spy.warns.length + spy.errors.length;
      loop._logFailure(new Error("未配置 LLM 提供商"));
      if (spy.warns.length + spy.errors.length > before) loggedAt.push(n);
    }
  } finally {
    spy.restore();
  }
  assert.deepStrictEqual(
    loggedAt,
    [1, PERCEPTION_FAILURE_LOG_EVERY, 2 * PERCEPTION_FAILURE_LOG_EVERY],
    `${rounds} 轮失败只应在首次与每 ${PERCEPTION_FAILURE_LOG_EVERY} 次各记一条`
  );
});

test("瞬时失败（5xx）连续超阈值时经气泡告知恰好一次且继续重试，不每轮弹", async () => {
  const spy = hookConsole();
  const prevSpeak = global.openSpeak;
  const spoken = [];
  global.openSpeak = (payload) => spoken.push(payload && payload.data && payload.data.data);
  // 云端 5xx：瞬时故障，等一等可能恢复 → 只告知一次，循环必须继续跑
  const loop = failingLoop(() => new Error("openai HTTP 503: upstream unavailable"));
  try {
    // 未达阈值前不得打扰用户
    loop._failures = PERCEPTION_FAILURE_NOTIFY_THRESHOLD - 1;
    loop._maybeNotifyFailure();
    assert.deepStrictEqual(spoken, [], "未达连续失败阈值不得弹气泡");

    loop.start(); // start() 会把 _failures / _failureNotified 复位
    await waitUntil(
      () => loop._failures >= PERCEPTION_FAILURE_NOTIFY_THRESHOLD + 2,
      "连续失败超过阈值若干轮"
    );
    assert.strictEqual(loop.running, true, "瞬时失败不得停用感知，必须继续退避重试");
  } finally {
    loop.stop();
    spy.restore();
    if (prevSpeak === undefined) delete global.openSpeak;
    else global.openSpeak = prevSpeak;
  }
  assert.strictEqual(
    spoken.length,
    1,
    `连续失败应恰好告知用户一次，实际 ${spoken.length} 次：${JSON.stringify(spoken)}`
  );
  assert.ok(
    spoken[0].includes("屏幕感知"),
    `气泡文案应指明是屏幕感知失效，实际：${spoken[0]}`
  );
  assert.strictEqual(loop._configFailures, 0, "5xx 不该被记成配置性失败");
});

// —— 配置性失败的根因消除（此前：视觉模型不支持图片 → 每轮截屏 + 每轮 400，无限重试）——

test("模型不支持图片（HTTP 400）连续达阈值后自动停用感知，并只告知一次", async () => {
  const spy = hookConsole();
  const prevSpeak = global.openSpeak;
  const spoken = [];
  global.openSpeak = (payload) => spoken.push(payload && payload.data && payload.data.data);
  const loop = failingLoop(() => new Error("openai HTTP 400: image input not supported"));
  const captured = [];
  const origCapture = loop.captureFn;
  loop.captureFn = async (...args) => {
    captured.push(1);
    return origCapture(...args);
  };
  try {
    loop.start();
    await waitUntil(() => loop.running === false, "配置性失败达阈值后应自动停用");
    assert.strictEqual(
      loop._configFailures,
      PERCEPTION_CONFIG_FAILURE_LIMIT,
      "应恰好在连续第 N 次配置性失败时停用，不多浪费一轮"
    );
    assert.strictEqual(loop.timer, null, "停用后不得残留 timer");
    const capturesAtStop = captured.length;
    await sleep(150);
    assert.strictEqual(
      captured.length,
      capturesAtStop,
      "停用后不得再截屏（这正是每轮浪费一次截屏 + 一次出网的根因）"
    );
  } finally {
    loop.stop();
    spy.restore();
    if (prevSpeak === undefined) delete global.openSpeak;
    else global.openSpeak = prevSpeak;
  }
  assert.strictEqual(
    spoken.length,
    1,
    `停用只应告知一次（不叠加"一直失败"气泡），实际：${JSON.stringify(spoken)}`
  );
  assert.ok(
    spoken[0].includes("停") && spoken[0].includes("设置"),
    `气泡必须告知已停用并指向设置页，实际：${spoken[0]}`
  );
  const stopLog = spy.ours(spy.warns).filter((l) => l.includes("已自动停用"));
  assert.strictEqual(stopLog.length, 1, `停用必须留一条 warn，实际：${JSON.stringify(spy.warns)}`);
  assert.ok(
    stopLog[0].includes("image input not supported"),
    `停用日志要带上真实原因，实际：${stopLog[0]}`
  );
});

test("配置性失败与瞬时失败的判定：4xx（除 408/425/429）与未配置属配置性，其余可重试", () => {
  const cases = [
    ["openai HTTP 400: image input not supported", "config"],
    ["anthropic HTTP 401: invalid x-api-key", "config"],
    ["openai HTTP 402: 余额不足", "config"],
    ["openai HTTP 403: forbidden", "config"],
    ["openai HTTP 404: model not found", "config"],
    ["未配置 LLM 提供商", "config"],
    ["提供商「default」缺少 API Key", "config"],
    ["API 地址无效（空），请在设置页检查服务商配置", "config"],
    ["openai HTTP 408: request timeout", "transient"],
    ["openai HTTP 429: rate limit", "transient"],
    ["openai HTTP 500: internal error", "transient"],
    ["openai HTTP 503: upstream unavailable", "transient"],
    ["socket hang up", "transient"],
    ["timeout", "transient"],
    ["perception response is not valid JSON: 我看不清", "transient"],
  ];
  for (const [message, expected] of cases) {
    assert.strictEqual(
      classifyPerceptionError(new Error(message)),
      expected,
      `「${message}」应判为 ${expected}`
    );
  }
});

test("单次配置性失败不会停用感知（阈值前必须继续重试，滤掉偶发 400）", async () => {
  const spy = hookConsole();
  const loop = failingLoop(() => new Error("openai HTTP 400: bad request"));
  try {
    loop.start();
    await waitUntil(() => loop._configFailures >= 1, "首轮配置性失败");
    assert.strictEqual(
      loop.running,
      true,
      "第一次配置性失败就停用会把网络抖动误判成配置错"
    );
  } finally {
    loop.stop();
    spy.restore();
  }
});

// —— 缺陷 2：HTTP 200 + body 带 error 的失败 ——
// 不少 OpenAI 兼容网关用「200 + body.error」报"模型不支持图片"，providers.js 对这类响应
// 抛的是不含状态码的裸文案 → 此前只认 /HTTP \d{3}/ 的判定把它当瞬时错误 → 无限退避重试，
// 自动停用永不触发，对这些网关整条修复等于没做。

test("模型不支持图片但服务商回 200（错误信息不含状态码）时，同样在阈值后自动停用并告知一次", async () => {
  const spy = hookConsole();
  const prevSpeak = global.openSpeak;
  const spoken = [];
  global.openSpeak = (payload) => spoken.push(payload && payload.data && payload.data.data);
  // providers.js 对 200 + body.error 抛的就是这样一条裸文案（无 "HTTP xxx"）
  const message = "model does not support image input";
  assert.ok(!/HTTP \d{3}/.test(message), "这条用例的前提就是错误信息里没有状态码");
  const loop = failingLoop(() => new Error(message));
  const captured = [];
  const origCapture = loop.captureFn;
  loop.captureFn = async (...args) => {
    captured.push(1);
    return origCapture(...args);
  };
  try {
    loop.start();
    await waitUntil(
      () => loop.running === false,
      "200 + body error 的图片能力失败也必须在阈值后自动停用"
    );
    assert.strictEqual(
      loop._configFailures,
      PERCEPTION_CONFIG_FAILURE_LIMIT,
      "应恰好在连续第 N 次配置性失败时停用"
    );
    assert.strictEqual(loop.timer, null, "停用后不得残留 timer");
    const capturesAtStop = captured.length;
    await sleep(150);
    assert.strictEqual(
      captured.length,
      capturesAtStop,
      "停用后不得再截屏（此前这类网关会被无限重试）"
    );
  } finally {
    loop.stop();
    spy.restore();
    if (prevSpeak === undefined) delete global.openSpeak;
    else global.openSpeak = prevSpeak;
  }
  assert.strictEqual(
    spoken.length,
    1,
    `停用只应告知一次（不叠加"一直失败"气泡），实际：${JSON.stringify(spoken)}`
  );
  assert.ok(
    spoken[0].includes("停") && spoken[0].includes("设置"),
    `气泡必须告知已停用并指向设置页，实际：${spoken[0]}`
  );
});

test("图片能力关键词不得误伤瞬时失败：模型没吐 JSON / 超时 / 5xx 一律继续重试", () => {
  const cases = [
    // —— 该判 config 的图片能力失败（均为 200 + body.error 的裸文案形态）——
    ["model does not support image input", "config"],
    ["This model doesn't support vision", "config"],
    ["模型 glm-x 不支持图片输入，请更换模型", "config"],
    ["multimodal input is not allowed for this endpoint", "config"],
    ["invalid_image_url: failed to process the provided image", "config"],
    ["Invalid content type image_url for model deepseek-chat", "config"],
    // —— 必须仍判 transient（正则改宽就会在这里变红）——
    // 解析失败的错误信息后半截是**模型原文**：模型用英文描述屏幕时会带 image/vision，
    // 若拿去做关键词判定，"这轮没吐 JSON"会被误判成配置错并停用感知。
    [
      "perception response is not valid JSON: The image shows a browser; multimodal is not supported by me",
      "transient",
    ],
    ["perception response is not valid JSON: 画面里是一张图片，我不支持描述细节", "transient"],
    // 与"模型不会看图"无关的瞬时故障，即使句子里出现 image/图片
    ["failed to download image: socket hang up", "transient"],
    ["图片上传超时，请重试", "transient"],
    ["openai HTTP 502: bad gateway", "transient"],
    ["request to https://api.example.com timed out after 30000ms", "transient"],
    ["openai 响应缺少文本内容", "transient"],
  ];
  for (const [message, expected] of cases) {
    assert.strictEqual(
      classifyPerceptionError(new Error(message)),
      expected,
      `「${message}」应判为 ${expected}`
    );
  }
});

test("非配置性的持续失败（网络超时）不停用感知，继续退避重试", async () => {
  const spy = hookConsole();
  const prevSpeak = global.openSpeak;
  global.openSpeak = () => {};
  const loop = failingLoop(() => new Error("request timed out after 30000ms"));
  try {
    loop.start();
    await waitUntil(
      () => loop._failures >= PERCEPTION_CONFIG_FAILURE_LIMIT + 2,
      "连续超过停用阈值若干轮"
    );
    assert.strictEqual(
      loop.running,
      true,
      "瞬时失败被误判成配置性会让感知在网络抖动时被错误停用"
    );
    assert.strictEqual(loop._configFailures, 0, "超时不该被记成配置性失败");
  } finally {
    loop.stop();
    spy.restore();
    if (prevSpeak === undefined) delete global.openSpeak;
    else global.openSpeak = prevSpeak;
  }
});

// —— 缺陷 3：自动停用后弹幕窗泄漏 ——
// stop() 只 hide 弹幕窗，销毁在 perception/index.js 的 stopPerception() 里。自动停用走的是
// loop 内部的 stop()，那个全屏透明、backgroundThrottling:false 的 BrowserWindow 连同渲染
// 进程会活到进程结束，而设置页开关此时显示"开"，用户点它只会走关闭分支——已无回收途径。

test("配置性失败自动停用时销毁弹幕覆盖层（只 hide 会让全屏透明窗与其渲染进程残留到退出）", async () => {
  const spy = hookConsole();
  const prevSpeak = global.openSpeak;
  const prevWindow = global.barrageWindow;
  const calls = [];
  global.openSpeak = () => {};
  global.barrageWindow = {
    show: () => calls.push("show"),
    hide: () => calls.push("hide"),
    destroy: () => calls.push("destroy"),
  };
  const loop = failingLoop(() => new Error("openai HTTP 400: image input not supported"));
  try {
    loop.start();
    await waitUntil(() => loop.running === false, "配置性失败达阈值后应自动停用");
  } finally {
    loop.stop();
    spy.restore();
    if (prevSpeak === undefined) delete global.openSpeak;
    else global.openSpeak = prevSpeak;
    if (prevWindow === undefined) delete global.barrageWindow;
    else global.barrageWindow = prevWindow;
  }
  assert.ok(
    calls.includes("destroy"),
    `自动停用必须销毁弹幕窗，实际只调用了：${JSON.stringify(calls)}`
  );
});

test("stopPerception() 与自动停用共用同一份销毁实现（两条停止路径不得分叉）", () => {
  const prevWindow = global.barrageWindow;
  const calls = [];
  global.barrageWindow = {
    hide: () => calls.push("hide"),
    destroy: () => calls.push("destroy"),
  };
  try {
    const perception = require("../src/service/perception/index.js");
    perception.stopPerception();
    assert.ok(
      typeof perception.perceptionLoop.destroyBarrageWindow === "function",
      "销毁实现应挂在 loop 上，供 index.js 与自动停用共用"
    );
    assert.ok(
      calls.includes("destroy"),
      `stopPerception() 必须销毁弹幕窗，实际：${JSON.stringify(calls)}`
    );
  } finally {
    if (prevWindow === undefined) delete global.barrageWindow;
    else global.barrageWindow = prevWindow;
  }
});

test("弹幕窗销毁抛错时留 error 日志且不影响停用流程（不得静默吞）", () => {
  const prevWindow = global.barrageWindow;
  const spy = hookConsole();
  const loop = new PerceptionLoop({ intervalMs: 100000 });
  global.barrageWindow = {
    destroy: () => {
      throw new Error("window already destroyed");
    },
  };
  try {
    loop.destroyBarrageWindow(); // 不得抛出
  } finally {
    spy.restore();
    if (prevWindow === undefined) delete global.barrageWindow;
    else global.barrageWindow = prevWindow;
  }
  const errors = spy.ours(spy.errors).filter((l) => l.includes("销毁弹幕覆盖层失败"));
  assert.strictEqual(errors.length, 1, `销毁失败必须留 error，实际：${JSON.stringify(spy.errors)}`);
  assert.ok(errors[0].includes("\n    at "), "意外异常必须记完整堆栈");
});

test("感知看图用的就是对话提供商：启动处（而非每轮）warn + 每进程一次气泡，且气泡指向真实存在的设置项", () => {
  const prevGetSys = global.getSys;
  const prevSpeak = global.openSpeak;
  const spoken = [];
  const spy = hookConsole();
  const loop = new PerceptionLoop({ intervalMs: 100000 });
  try {
    global.openSpeak = (p) => spoken.push(p && p.data && p.data.data);
    // 设置页唯一能写出来的形态：saveProviders([{id:"default"}]) + llmActiveProvider
    global.getSys = (key) =>
      ({
        llmActiveProvider: "default",
        llmProviders: [
          {
            id: "default",
            type: "openai",
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-plain-not-migrated",
            model: "chat-only-model",
          },
        ],
      }[key]);
    loop._precheckVisionProvider();
    loop._precheckVisionProvider(); // 第二次（模拟再次开关感知）不得重复弹
  } finally {
    spy.restore();
    if (prevGetSys === undefined) delete global.getSys;
    else global.getSys = prevGetSys;
    if (prevSpeak === undefined) delete global.openSpeak;
    else global.openSpeak = prevSpeak;
  }
  const warns = spy.ours(spy.warns).filter((l) => l.includes("使用对话提供商看图"));
  assert.strictEqual(warns.length, 2, "每次启动都要留一条可诊断的 warn");
  assert.ok(
    warns[0].includes("chat-only-model"),
    `warn 要写明实际会用哪个模型看图，实际：${warns[0]}`
  );
  assert.strictEqual(
    spoken.length,
    1,
    `看图模型提示气泡每进程只弹一次，实际：${JSON.stringify(spoken)}`
  );
  // 缺陷 1 的核心：气泡曾指向一个用户根本无法配置的"视觉模型"设置项
  // （sys.visionProvider 全仓无写入点），现在必须指向真实存在的入口——对话模型那一栏。
  assert.ok(
    spoken[0].includes("设置") &&
      /(?:对话模型换成|换成支持看图|换个支持看图)/.test(spoken[0]),
    `气泡必须指向真实存在的入口（把对话模型换成支持看图的型号），实际：${spoken[0]}`
  );
  assert.ok(
    !/配(?:置)?一个|视觉模型|视觉提供商/.test(spoken[0]),
    `气泡不得再指向那个用户根本配不出来的独立视觉模型设置项，实际：${spoken[0]}`
  );
  assert.deepStrictEqual(spy.ours(spy.errors), [], "预检本身不该报 error");
});

// 缺陷 1 的结构性防线：sys.visionProvider 是个"读得到、写不进"的死键
// （resolveVisionProvider 读它，全仓无任何写入点），已随本次修复删除。
// 这条断言防止这个键名以字符串字面量的形式（sysGet/setSys/UI 表单项）复活；
// 只查带引号的字面量，源码注释里追述这段历史不算命中。
test("死配置 sys.visionProvider 已从全仓消失（没有写入点的配置键不得被读写）", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  // 只扫我方源码与测试：三方压缩产物（windows/lib、windows/js）不在治理范围内
  const skipDirs = new Set([
    "node_modules",
    ".git",
    "lib",
    "js",
    "out",
    "dist",
    "release",
  ]);
  const KEY_LITERAL_RE = /["'`]visionProvider["'`]/;
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(js|json|html|md)$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (full === __filename) continue; // 本文件自身带着这个正则，不算命中
      if (KEY_LITERAL_RE.test(fs.readFileSync(full, "utf8"))) {
        hits.push(path.relative(root, full));
      }
    }
  };
  walk(path.join(root, "src"));
  walk(path.join(root, "test"));
  assert.deepStrictEqual(
    hits,
    [],
    `sys.visionProvider 没有任何写入点，不得再被读写，命中：${hits.join(", ")}`
  );
});

test("完全没有可用提供商时，启动预检留 warn 但不弹气泡（告知交给自动停用那条）", () => {
  const prevGetSys = global.getSys;
  const prevSpeak = global.openSpeak;
  const spoken = [];
  const spy = hookConsole();
  const loop = new PerceptionLoop({ intervalMs: 100000 });
  try {
    global.openSpeak = (p) => spoken.push(p);
    global.getSys = () => undefined; // 一个提供商都没配
    loop._precheckVisionProvider();
  } finally {
    spy.restore();
    if (prevGetSys === undefined) delete global.getSys;
    else global.getSys = prevGetSys;
    if (prevSpeak === undefined) delete global.openSpeak;
    else global.openSpeak = prevSpeak;
  }
  const warns = spy.ours(spy.warns).filter((l) => l.includes("没有可用的对话提供商"));
  assert.strictEqual(warns.length, 1, `应恰好一条 warn，实际：${JSON.stringify(spy.warns)}`);
  assert.ok(warns[0].includes("no-provider"), `warn 要带上判定原因，实际：${warns[0]}`);
  assert.deepStrictEqual(spoken, [], "启动预检此时不弹气泡，避免与停用告知重复");
});

test("stop() 造成的中断不计失败、不留日志、不弹气泡（epoch 语义未被日志改动破坏）", async () => {
  const spy = hookConsole();
  const prevSpeak = global.openSpeak;
  const spoken = [];
  global.openSpeak = (payload) => spoken.push(payload);
  let seenSignal = null;
  const loop = new PerceptionLoop({
    intervalMs: 20,
    captureFn: async () => fakeFrame(1),
    chatFn: ({ signal }) =>
      new Promise((resolve, reject) => {
        seenSignal = signal;
        if (!signal) return resolve(GAME_RESPONSE);
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
      }),
  });
  const failures = [];
  loop.on("perception-failed", (e) => failures.push(e));
  try {
    loop.start();
    await waitUntil(() => !!seenSignal, "感知请求应已发出");
    loop.stop();
    await sleep(80); // 让 abort 造成的 reject 走完 catch/finally
  } finally {
    spy.restore();
    if (prevSpeak === undefined) delete global.openSpeak;
    else global.openSpeak = prevSpeak;
  }
  assert.strictEqual(seenSignal.aborted, true, "stop() 应 abort 在途请求");
  assert.strictEqual(
    loop._failures,
    0,
    "stop() 造成的失败不得计入 _failures（否则会污染下一个运行周期的退避）"
  );
  assert.deepStrictEqual(failures, [], "stop() 造成的失败不应上报 perception-failed");
  assert.deepStrictEqual(spy.failures(spy.warns), [], "stop() 造成的中断不应记 warn");
  assert.deepStrictEqual(spy.failures(spy.errors), [], "stop() 造成的中断不应记 error");
  assert.deepStrictEqual(spoken, [], "stop() 造成的中断不应弹故障气泡");
  assert.strictEqual(loop._configFailures, 0, "stop() 造成的失败不得计入配置性失败");
});

test("稳定切换到 game 场景时会 emit pet-hide（此前仅有负向断言，删掉这行 emit 也全绿）", async () => {
  let seq = 0;
  const loop = new PerceptionLoop({
    intervalMs: 10,
    captureFn: async () => fakeFrame(++seq),
    chatFn: async () => GAME_RESPONSE,
  });
  const petHide = [];
  const petShow = [];
  loop.on("pet-hide", (p) => petHide.push(p));
  loop.on("pet-show", (p) => petShow.push(p));
  loop._showBarrage = () => {};
  try {
    loop.start();
    await waitUntil(
      () => loop.stabilizer.current === "game",
      "连续两个 game 样本后稳定器应切到 game"
    );
    await waitUntil(() => petHide.length > 0, "切到 game 应 emit pet-hide");
  } finally {
    loop.stop();
  }
  assert.strictEqual(petHide.length, 1, "进入 game 只应 emit 一次 pet-hide");
  assert.deepStrictEqual(petHide[0], { scene: "game" }, "pet-hide 应携带目标场景");
  assert.deepStrictEqual(
    petShow,
    [{ scene: "game" }],
    "stop() 收尾必须补一次 pet-show，否则桌宠永久隐藏"
  );
  assert.strictEqual(loop._petHidden, false, "stop() 后隐藏态应已复位");
});

// —— 被丢弃的 tick 不该做 PNG 编码 ——
// 修复前：captureScreen() 无条件 image.toPNG()（1280×720 约 10~30ms CPU），
// 而"画面未变 / 上一轮在途 / 未到心跳"的判定发生在截屏**之后** ——
// 默认 2000ms 间隔、12 小时约 21600 次截屏，绝大多数编码结果被直接丢掉。
// 现在 pngBuffer 是惰性 getter，loop.js 只在真的要发给多模态模型时才读它。

// 一帧"内容恒定"的假截屏：FrameChangeDetector 除首帧外一律判定"未变化"。
// pngBuffer 用 getter 计数，从而能证明"这一帧到底有没有被编码"。
function countingFrame(counter, seq = 0) {
  return {
    bitmap: Buffer.alloc(400, seq),
    width: 10,
    height: 10,
    get pngBuffer() {
      counter.png += 1;
      return Buffer.from("png");
    },
  };
}

test("画面未变化的 tick 不触发 PNG 编码（只有真要发给模型的那一帧才编码）", async () => {
  const counter = { png: 0, chats: 0 };
  let frames = 0;
  const loop = new PerceptionLoop({
    intervalMs: 10,
    // 恒定内容：首帧后 detector 一律判定未变化 → 后续 tick 都该被丢弃
    captureFn: async () => {
      frames += 1;
      return countingFrame(counter, 7);
    },
    chatFn: async () => {
      counter.chats += 1;
      return JSON.stringify({
        scene: "other",
        confidence: 0.3,
        scene_evidence: {},
        observation: "普通桌面操作，没有课程或游戏",
      });
    },
  });
  try {
    loop.start();
    await waitUntil(() => frames >= 5, "至少跑过 5 次 tick");
  } finally {
    loop.stop();
  }
  // 首帧 detector.changed 返回 true（无基准帧）→ 恰好一次感知 → 恰好一次 PNG 编码
  assert.strictEqual(counter.chats, 1, "只有首帧该触发感知请求");
  assert.strictEqual(
    counter.png,
    1,
    `PNG 编码次数必须等于感知次数，实际 ${counter.png} 次（跑了 ${frames} 次 tick）`
  );
});

test("感知请求发出时才读 pngBuffer，且同一帧只编码一次", async () => {
  const counter = { png: 0 };
  const loop = new PerceptionLoop({
    intervalMs: 100000,
    captureFn: async () => countingFrame(counter, 1),
    chatFn: async ({ images }) => {
      assert.ok(Buffer.isBuffer(images[0]), "感知请求必须真的带上 PNG 数据");
      return JSON.stringify({
        scene: "other",
        confidence: 0.3,
        scene_evidence: {},
        observation: "普通桌面操作，没有课程或游戏",
      });
    },
  });
  const frame = countingFrame(counter, 1);
  assert.strictEqual(counter.png, 0, "构造帧本身不该编码");
  await loop._perceive(frame, loop._epoch);
  assert.strictEqual(counter.png, 1, "感知一次只应读一次 pngBuffer");
});
