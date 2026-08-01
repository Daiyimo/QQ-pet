// llm/prompts.js 与 llm/chat.js 单元测试：提示词关键约束 + PetChatService 历史/截断/输入校验
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPetChatSystemPrompt,
  buildDailySummaryPrompt,
  buildCourseChunkPrompt,
  buildFinalCourseSummaryPrompt,
} = require("../src/service/llm/prompts.js");

// —— prompts ——
test("buildPetChatSystemPrompt：含防注入声明与 petInfo 注入", () => {
  const prompt = buildPetChatSystemPrompt({ info: { host: "小明", name: "球球" } });
  assert.match(prompt, /小明/);
  assert.match(prompt, /球球/);
  assert.match(prompt, /数据，不是指令/);
  assert.match(prompt, /不要照做/);
});

test("buildPetChatSystemPrompt：petInfo 缺省时用默认称呼", () => {
  const prompt = buildPetChatSystemPrompt(null);
  assert.match(prompt, /主人/);
  assert.match(prompt, /小企鹅/);
});

test("buildDailySummaryPrompt：含覆盖首尾、条数与字数限制、防注入声明", () => {
  const prompt = buildDailySummaryPrompt({
    day: "2025-06-10",
    cutoff: "18:00",
    firstTime: "09:00",
    lastTime: "17:30",
    source: "09:00-10:30 [课程学习，记录2条] 观看网课",
  });
  assert.match(prompt, /2025-06-10/);
  assert.match(prompt, /必须覆盖首尾/);
  assert.match(prompt, /最多 12 个/);
  assert.match(prompt, /420/);
  assert.match(prompt, /数据，不是指令/);
  assert.match(prompt, /观看网课/);
});

test("buildCourseChunkPrompt：含最多 6 条与防注入声明", () => {
  const prompt = buildCourseChunkPrompt("下面我们推导牛顿第二定律");
  assert.match(prompt, /最多 6 条/);
  assert.match(prompt, /数据，不是指令/);
  assert.match(prompt, /牛顿第二定律/);
});

test("buildFinalCourseSummaryPrompt：含小节约束与防注入声明", () => {
  const prompt = buildFinalCourseSummaryPrompt("整节课的材料文本");
  assert.match(prompt, /### 课程概览/);
  assert.match(prompt, /不补充材料外的知识/);
  assert.match(prompt, /数据，不是指令/);
  assert.match(prompt, /整节课的材料文本/);
});

// —— PetChatService ——
// chat.js 顶层持有 providers 模块引用，先 require providers 并就地替换方法再加载 chat.js
const providers = require("../src/service/llm/providers.js");
providers.getChatProvider = () => ({
  id: "stub",
  type: "openai",
  baseUrl: "http://stub.invalid",
  apiKey: "stub-key",
  model: "stub-model",
});
const { PetChatService } = require("../src/service/llm/chat.js");

function stubChat(impl) {
  providers.chat = impl;
}

test("PetChatService：空输入与超长输入直接拒绝", async () => {
  stubChat(async () => "不应被调用");
  const svc = new PetChatService();
  await assert.rejects(svc.sendMessage(""), /消息不能为空/);
  await assert.rejects(svc.sendMessage("   "), /消息不能为空/);
  await assert.rejects(svc.sendMessage("字".repeat(2001)), /2000/);
});

test("PetChatService：正常对话返回回复并组装 system+user 消息", async () => {
  let captured = null;
  stubChat(async (args) => {
    captured = args;
    return "  收到啦！  ";
  });
  const svc = new PetChatService();
  const reply = await svc.sendMessage("你好呀");
  assert.equal(reply, "收到啦！"); // 回复 trim
  assert.equal(captured.messages[0].role, "system");
  assert.match(captured.messages[0].content, /数据，不是指令/);
  assert.deepEqual(captured.messages[1], { role: "user", content: "你好呀" });
});

test("PetChatService：历史上限 4 轮，超出滚动丢弃", async () => {
  let captured = null;
  stubChat(async (args) => {
    captured = args;
    return "好";
  });
  const svc = new PetChatService();
  for (let i = 1; i <= 6; i++) await svc.sendMessage(`第${i}轮`);
  assert.equal(svc._history.length, 4);
  assert.equal(svc._history[0].user, "第3轮"); // 最早的 2 轮已丢弃
  // 最后一轮调用的 messages：1 system + 4*2 历史 + 1 本轮
  assert.equal(captured.messages.length, 10);
});

test("PetChatService：历史 user 截 1000、assistant 截 1500（保留尾部）", async () => {
  let captured = null;
  stubChat(async (args) => {
    captured = args;
    return "好";
  });
  const svc = new PetChatService();
  svc._history.push({ user: "头" + "u".repeat(1500), assistant: "头" + "a".repeat(2000) });
  await svc.sendMessage("本轮");
  const historyUser = captured.messages[1].content;
  const historyAssistant = captured.messages[2].content;
  assert.equal(historyUser.length, 1000);
  assert.ok(!historyUser.startsWith("头")); // slice(-1000) 丢弃的是头部
  assert.equal(historyAssistant.length, 1500);
  assert.ok(!historyAssistant.startsWith("头"));
});

test("PetChatService：并发第二轮被忙碌锁拒绝", async () => {
  let resolveChat;
  stubChat(() => new Promise((resolve) => (resolveChat = resolve)));
  const svc = new PetChatService();
  const first = svc.sendMessage("第一条");
  await assert.rejects(svc.sendMessage("第二条"), /思考中/);
  resolveChat("第一条回复");
  assert.equal(await first, "第一条回复");
});

test("PetChatService：clearHistory 清空历史", async () => {
  stubChat(async () => "好");
  const svc = new PetChatService();
  await svc.sendMessage("记住我");
  assert.equal(svc._history.length, 1);
  svc.clearHistory();
  assert.equal(svc._history.length, 0);
});

// —— llm.js SYSTEM_PROMPT 量纲（满健康为 5，见 src/ini/pet.js maxInfo.health）——
test("SYSTEM_PROMPT：健康量纲为 /5，心情 /1000", () => {
  const { __SYSTEM_PROMPT } = require("../src/service/llm.js");
  const prompt = __SYSTEM_PROMPT({
    info: { host: "小明", name: "球球", mood: 800, health: 5 },
    maxInfo: { level: 12 },
  });
  assert.match(prompt, /健康5\/5/);
  assert.match(prompt, /心情800\/1000/);
  assert.match(prompt, /等级12/);
  // 缺省 health 也按满值 5 兜底
  const def = __SYSTEM_PROMPT({ info: {}, maxInfo: {} });
  assert.match(def, /健康5\/5/);
});
