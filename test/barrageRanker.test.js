// barrageRanker.js 单元测试：归一化、质量惩罚、相似判定、发射器禁发/连发/取消
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BarrageEmitter,
  normalizeText,
  textsAreSimilar,
  barrageQualityPenalty,
} = require("../src/service/perception/barrageRanker.js");

test("normalizeText：小写化并去掉标点、空白与下划线", () => {
  assert.equal(normalizeText("Hello, 世界!"), "hello世界");
  assert.equal(normalizeText("ABC_def 123"), "abcdef123");
  assert.equal(normalizeText(""), "");
  assert.equal(normalizeText(null), "");
});

test("barrageQualityPenalty：提问 +6", () => {
  assert.equal(barrageQualityPenalty("这一把到底能不能赢？"), 6);
});

test("barrageQualityPenalty：不确定表述 +3", () => {
  assert.equal(barrageQualityPenalty("看起来这波团战要赢了"), 3);
});

test("barrageQualityPenalty：元叙述 +5", () => {
  assert.equal(barrageQualityPenalty("根据画面这波打得很稳"), 5);
});

test("barrageQualityPenalty：过短 +2", () => {
  assert.equal(barrageQualityPenalty("漂亮"), 2);
});

test("barrageQualityPenalty：干净弹幕 0 惩罚", () => {
  assert.equal(barrageQualityPenalty("这波团战打得漂亮"), 0);
});

test("barrageQualityPenalty：多种问题叠加", () => {
  // 提问 +6、不确定 +3、元叙述 +5，长度 ≥6 不另加
  assert.equal(barrageQualityPenalty("根据画面看起来这波能赢吗？"), 14);
});

test("textsAreSimilar：归一化后完全相同即相似", () => {
  assert.equal(textsAreSimilar("这波漂亮！", "这波漂亮"), true);
});

test("textsAreSimilar：ratio ≥ 0.78 判定相似", () => {
  // 8 字 vs 9 字，仅末尾多一字 → 最长匹配 8 字，ratio ≈ 0.94
  assert.equal(textsAreSimilar("这波团战打得漂亮", "这波团战打得漂亮了"), true);
});

test("textsAreSimilar：差异大不相似", () => {
  assert.equal(textsAreSimilar("这波团战打得漂亮", "下路塔被推掉了啊"), false);
});

test("textsAreSimilar：归一化后短于 4 的非相同串不判相似", () => {
  assert.equal(textsAreSimilar("abc", "abd"), false);
  assert.equal(textsAreSimilar("ab", "ab"), true); // 完全相同仍相似
  assert.equal(textsAreSimilar("", "任意文本"), false);
});

// —— BarrageEmitter：注入时钟与定时器，不做真实等待 ——
// 假定时器：setTimeoutFn 登记回调返回 id，clearTimeoutFn 按 id 撤销（对齐真实语义）
function makeEmitter({ emit } = {}) {
  const state = { now: 0, timers: [], nextId: 0 };
  const emitted = [];
  const emitter = new BarrageEmitter(emit || ((text) => emitted.push(text)), {
    now: () => state.now,
    setTimeoutFn: (fn) => {
      const id = ++state.nextId;
      state.timers.push({ id, fn });
      return id;
    },
    clearTimeoutFn: (id) => {
      const i = state.timers.findIndex((t) => t.id === id);
      if (i >= 0) state.timers.splice(i, 1);
    },
  });
  return {
    emitter,
    emitted,
    state,
    advance(ms) {
      state.now += ms;
    },
    fireNextTimer() {
      const entry = state.timers.shift();
      assert.ok(entry, "应有待触发的定时器");
      entry.fn();
    },
  };
}

test("BarrageEmitter：完全相同的弹幕 20s 内禁发", () => {
  const { emitter, emitted, advance } = makeEmitter();
  emitter.offerCandidates(["打得漂亮啊这波操作"]);
  assert.deepEqual(emitted, ["打得漂亮啊这波操作"]);

  advance(15000); // 15s < 20s，相同弹幕被过滤
  emitter.offerCandidates(["打得漂亮啊这波操作"]);
  assert.equal(emitted.length, 1);

  advance(6000); // 累计 21s > 20s，允许重发
  emitter.offerCandidates(["打得漂亮啊这波操作"]);
  assert.equal(emitted.length, 2);
});

test("BarrageEmitter：相似弹幕 4s 内禁发", () => {
  const { emitter, emitted, advance } = makeEmitter();
  emitter.offerCandidates(["这波团战打得漂亮"]);
  assert.equal(emitted.length, 1);

  advance(3000); // 3s < 4s，相似弹幕被过滤
  emitter.offerCandidates(["这波团战打得漂亮啦"]);
  assert.equal(emitted.length, 1);

  advance(2000); // 累计 5s > 4s，相似弹幕放行
  emitter.offerCandidates(["这波团战打得漂亮啦"]);
  assert.equal(emitted.length, 2);
});

test("BarrageEmitter：按质量排序后立即发一条，其余每 2.5s 连发", () => {
  const { emitter, emitted, state, fireNextTimer } = makeEmitter();
  // 干净弹幕（惩罚 0）应排在提问弹幕（+6）之前
  emitter.offerCandidates([
    "这波打得怎么样？", // +6
    "打得真漂亮啊这波", // 0
    "稳住我们能赢啊", // 0
  ]);
  // 立即发第一条（惩罚最低、索引靠前）
  assert.deepEqual(emitted, ["打得真漂亮啊这波"]);
  assert.equal(state.timers.length, 1);

  fireNextTimer(); // 第一个 2.5s 间隔
  assert.deepEqual(emitted, ["打得真漂亮啊这波", "稳住我们能赢啊"]);
  assert.equal(state.timers.length, 1);

  fireNextTimer(); // 第二个 2.5s 间隔，序列发完
  assert.deepEqual(emitted, [
    "打得真漂亮啊这波",
    "稳住我们能赢啊",
    "这波打得怎么样？",
  ]);
  assert.equal(state.timers.length, 0);
});

test("BarrageEmitter：cancel 取消未发的连发序列", () => {
  const { emitter, emitted, state } = makeEmitter();
  emitter.offerCandidates(["打得真漂亮啊这波", "稳住我们能赢啊"]);
  assert.deepEqual(emitted, ["打得真漂亮啊这波"]);
  assert.equal(state.timers.length, 1);

  emitter.cancel();
  assert.equal(state.timers.length, 0); // 定时器已撤销，第二条不会再发
  assert.deepEqual(emitted, ["打得真漂亮啊这波"]);
});

test("BarrageEmitter：cancel 后再 offer 从头开始新序列", () => {
  const { emitter, emitted, state, fireNextTimer } = makeEmitter();
  emitter.offerCandidates(["第一条弹幕内容啊", "第二条弹幕内容啊"]);
  emitter.cancel();
  emitter.offerCandidates(["完全不同的新弹幕呀", "再补一条新弹幕呀"]);
  assert.deepEqual(emitted, ["第一条弹幕内容啊", "完全不同的新弹幕呀"]);
  fireNextTimer();
  assert.deepEqual(emitted, [
    "第一条弹幕内容啊",
    "完全不同的新弹幕呀",
    "再补一条新弹幕呀",
  ]);
  assert.equal(state.timers.length, 0);
});

test("BarrageEmitter：shouldEmit 门控返回 false 时中止发射", () => {
  let allow = false;
  const emitted = [];
  const emitter = new BarrageEmitter((text) => emitted.push(text), {
    shouldEmit: () => allow,
    now: () => 0,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  emitter.offerCandidates(["打得真漂亮啊这波"]);
  assert.equal(emitted.length, 0);
});
