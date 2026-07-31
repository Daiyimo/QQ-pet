// 云端返回 JSON 的健壮解析回归测试。
// 修复前：llm.js 只做 ```json 去围栏 + JSON.parse，模型在 JSON 前带一句解释就抛错，
// 且异常被 .catch(()=>null) 静默吞掉（既没台词也没日志）；
// perception/loop.js 却另有一套健壮解析 —— 现统一到 llm/jsonParse.js。
const test = require("node:test");
const assert = require("node:assert");

const {
  tryExtractJsonObject,
  extractJsonObject,
} = require("../src/service/llm/jsonParse.js");
const { parsePerceptionJson } = require("../src/service/perception/loop.js");

test("JSON 前带解释文字时仍能解析出对象", () => {
  const text = '好的，我来生成台词：\n{"tolk":"主人抱抱","submitText":"好"}';
  assert.deepStrictEqual(extractJsonObject(text), {
    tolk: "主人抱抱",
    submitText: "好",
  });
});

test("markdown 围栏包裹（且前后有说明文字）时仍能解析出对象", () => {
  const text = '思考完毕。\n```json\n{"tolk":"我在这里","submitText":"好"}\n```\n以上就是台词。';
  assert.deepStrictEqual(extractJsonObject(text), {
    tolk: "我在这里",
    submitText: "好",
  });
});

test("尾部被截断（多余残尾）时退到最后一个右括号解析", () => {
  const text = '{"tolk":"主人早上好","submitText":"好"} 还有一点补充说明……';
  assert.deepStrictEqual(extractJsonObject(text), {
    tolk: "主人早上好",
    submitText: "好",
  });
});

test("完全没有 JSON 对象时抛错且错误信息带原文片段", () => {
  assert.throws(() => extractJsonObject("我今天不想说话", "台词模型"), (e) => {
    assert.match(e.message, /台词模型未返回可解析的 JSON 对象/);
    assert.match(e.message, /我今天不想说话/);
    return true;
  });
});

test("解析不出对象时返回 null；被数组包一层的对象仍能取到（沿用感知解析原语义）", () => {
  // 语义与原 parsePerceptionJson 一致：从首个 "{" 起找，所以数组包裹的对象会被取出来
  assert.deepStrictEqual(tryExtractJsonObject('[{"tolk":"x"}]'), { tolk: "x" });
  assert.strictEqual(tryExtractJsonObject("123"), null);
  assert.strictEqual(tryExtractJsonObject("没有任何括号"), null);
  assert.strictEqual(tryExtractJsonObject(""), null);
  assert.strictEqual(tryExtractJsonObject(null), null);
});

test("感知解析改用共用实现后，原有的截断恢复行为不变", () => {
  // 被 max_tokens 掐断的响应：JSON 不闭合，只能靠正则捞回 scene/confidence/证据
  const truncated =
    '{"scene":"course","confidence":0.83,"scene_evidence":{"active_instruction":true,' +
    '"course_surface":true},"course_transcript":"这一节讲的是链式法则的推导过程，先看';
  const parsed = parsePerceptionJson(truncated);
  assert.strictEqual(parsed.scene, "course");
  assert.strictEqual(parsed.confidence, 0.83);
  assert.strictEqual(parsed.scene_evidence.active_instruction, true);
  assert.strictEqual(parsed.scene_evidence.course_surface, true);
});

test("感知解析同样能吃掉前置解释文字与围栏", () => {
  const text =
    '根据画面我判断如下：\n```json\n{"scene":"other","confidence":0.4,"scene_evidence":{},' +
    '"observation":"桌面上打开了文件资源管理器"}\n```';
  const parsed = parsePerceptionJson(text);
  assert.strictEqual(parsed.scene, "other");
  assert.strictEqual(parsed.observation, "桌面上打开了文件资源管理器");
});

test("完全没有 JSON 的感知响应仍抛出原有错误", () => {
  assert.throws(
    () => parsePerceptionJson("我看不清屏幕内容"),
    /perception response contains no JSON object/
  );
});

// —— 端到端：台词生成路径（llm.js）——
// 校验两件事：① 带前缀的模型输出不再让台词生成失败；② 失败时必须落日志（不再静默吞）。
test("台词生成：模型输出带前缀说明时仍能拿到台词", async () => {
  const providers = require("../src/service/llm/providers.js");
  require("../src/service/llm.js"); // 注册 global.llmService

  const prevGetSys = global.getSys;
  const prevChat = providers.chat;
  const prevGetProvider = providers.getChatProvider;
  try {
    global.getSys = (key) => ({ llmEnabled: true }[key]);
    providers.getChatProvider = () => ({
      id: "t",
      type: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-test",
      model: "m",
    });
    providers.chat = async () =>
      '让我想想…\n```json\n{"tolk":"主人抱抱我","submitText":"好"}\n```';

    const r = await global.llmService.generateOnce("smallTalk", {}, {});
    assert.ok(r, "带前缀说明的输出不应再解析失败");
    assert.strictEqual(r.tolk, "主人抱抱我");
  } finally {
    providers.chat = prevChat;
    providers.getChatProvider = prevGetProvider;
    if (prevGetSys === undefined) delete global.getSys;
    else global.getSys = prevGetSys;
  }
});

test("台词生成失败时降级为离线台词但必须记录完整堆栈（不再静默吞）", async () => {
  const providers = require("../src/service/llm/providers.js");
  require("../src/service/llm.js");

  const prevGetSys = global.getSys;
  const prevChat = providers.chat;
  const prevGetProvider = providers.getChatProvider;
  const prevError = console.error;
  const logged = [];
  try {
    global.getSys = (key) => ({ llmEnabled: true }[key]);
    providers.getChatProvider = () => ({
      id: "t",
      type: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-test",
      model: "m",
    });
    providers.chat = async () => {
      throw new Error("HTTP 401: invalid api key");
    };
    console.error = (...args) => logged.push(args.map(String).join(" "));

    const r = await global.llmService.generateOnce("smallTalk", {}, {});
    assert.strictEqual(r, null, "降级行为不变：返回 null 让调用方用离线台词");
    assert.ok(logged.length > 0, "失败必须留日志");
    const joined = logged.join("\n");
    assert.match(joined, /\[llm\]/);
    assert.match(joined, /HTTP 401: invalid api key/);
  } finally {
    console.error = prevError;
    providers.chat = prevChat;
    providers.getChatProvider = prevGetProvider;
    if (prevGetSys === undefined) delete global.getSys;
    else global.getSys = prevGetSys;
  }
});
