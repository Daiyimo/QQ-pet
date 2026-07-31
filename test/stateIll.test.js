// State.js 状态机回归测试：病树下标、doActive 不越权覆盖状态位、死亡类型、心情上限。
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// ---- 全局桩 ----
let petInfo;
let writes;
let randomQueue = [];
let randomCalls = [];

global.getPetInfo = () => JSON.parse(JSON.stringify(petInfo));
global.setPetInfo = (d) => {
  writes.push(JSON.parse(JSON.stringify(d)));
  for (const g of Object.keys(d)) {
    petInfo[g] = { ...(petInfo[g] || {}), ...d[g] };
  }
};
global.isNumber = (e) => (+e == +e && +e) || 0;
// getRandom 桩：**尊重区间**。编排值当成「区间内的偏移」而不是直接返回值 ——
// 若直接 `return queue.shift()`，实现取 getRandom(1,2) 还是 getRandom(0,1) 对结果
// 毫无影响，用例就退化成在验证桩自己（病树随机区间会完全裸奔）。
// 同时记录调用参数，供用例直接钉住区间。
global.getRandom = (a, b) => {
  randomCalls.push([a, b]);
  if (b === undefined) return a; // 单参语义是 [0,a]，本测试未用到
  const offset = randomQueue.length ? randomQueue.shift() : 0;
  return Math.min(Math.max(a + offset, a), b);
};
global.getRatio = () => true; // 让 illsPower 计数稳定推进
global.$test = false;

const { State } = require(
  path.join(__dirname, "..", "src", "windows", "util", "pet", "State.js")
);

function basePetInfo(over = {}) {
  return {
    info: { hunger: 3000, clean: 3000, mood: 500, health: 5, ...(over.info || {}) },
    maxInfo: { hunger: 3300, clean: 3300, mood: 1000, health: 5, ...(over.maxInfo || {}) },
    activeOption: {
      work: null,
      study: null,
      trip: null,
      ill: null,
      background: null,
      ...(over.activeOption || {}),
    },
  };
}

function makeState(over) {
  petInfo = basePetInfo(over);
  writes = [];
  randomQueue = [];
  randomCalls = [];
  const events = [];
  const s = new State({ callBackState: (e) => events.push(e) });
  writes = [];
  events.length = 0;
  randomCalls = []; // 丢弃构造期（firstDetermineHealth）的调用记录
  return { s, events };
}

// 把 illsPower 顶到触发阈值（>4）后再跑一次 determineHealth
function forceIll(s, kind) {
  s.illsPower = { [kind]: 5 };
  s.determineHealth();
}

// ------------------------------------------------ 病树下标

test("吃太饱触发的是「肚子胀」病树而不是空对象", () => {
  const { s } = makeState({ info: { hunger: 3300 } }); // hunger > maxInfo.hunger-260
  forceIll(s, "full");
  const w = writes.find((x) => x.activeOption && x.activeOption.ill);
  assert.ok(w, "旧实现取 s[3]（undefined），整条「吃太饱致病」路径静默失效");
  assert.equal(w.activeOption.ill.name, "肚子胀");
  assert.equal(w.activeOption.ill.type, "ill");
});

test("脏/饿触发的病树覆盖「咳嗽」与「感冒」两棵（含旧实现不可达的咳嗽）", () => {
  const names = new Set();
  const intervals = [];
  for (const offset of [0, 1]) {
    const { s } = makeState({ info: { clean: 100 } });
    randomQueue = [offset]; // 区间内偏移，桩会钳到 [a,b]
    forceIll(s, "dirty");
    const w = writes.find((x) => x.activeOption && x.activeOption.ill);
    assert.ok(w, `offset=${offset} 应生成疾病`);
    names.add(w.activeOption.ill.name);
    intervals.push(randomCalls[randomCalls.length - 1]);
  }
  assert.deepEqual(
    [...names].sort(),
    ["咳嗽", "感冒"],
    "旧实现 getRandom(1,2) 取到的是 s[1]/s[2]（感冒/肚子胀），「咳嗽」永不可达"
  );
  // 直接钉住随机区间：两次调用都必须是 [0,1]
  for (const iv of intervals) {
    assert.deepEqual(iv, [0, 1], "病树随机必须在 [0,1] 上取，[1,2] 会让 s[0]「咳嗽」不可达");
  }
});

test("生病时保留已装备的背景", () => {
  const { s } = makeState({
    info: { clean: 100 },
    activeOption: { background: "_b0000001" },
  });
  randomQueue = [0];
  forceIll(s, "dirty");
  const w = writes.find((x) => x.activeOption && x.activeOption.ill);
  assert.equal(w.activeOption.background, "_b0000001", "生病不该把背景擦成 undefined");
});

test("生病会中断打工/学习/旅游", () => {
  const { s } = makeState({
    info: { clean: 100 },
    activeOption: { work: { name: "搬砖" }, background: "_b0000001" },
  });
  randomQueue = [0];
  forceIll(s, "dirty");
  const w = writes.find((x) => x.activeOption && x.activeOption.ill);
  assert.equal(w.activeOption.work, null);
  assert.equal(w.activeOption.study, null);
  assert.equal(w.activeOption.trip, null);
});

// ------------------------------------------------ 死亡类型

test("病死时状态回调的 type 为 dead 而不是 ill", () => {
  const { s, events } = makeState({ info: { clean: 100 } });
  // 直接以死亡对象走 doActive：模拟病情链末端 children 指向死亡节点
  const dead = { type: "dead", name: "死亡", health: 0, tolk: "走了" };
  s.doActive({ type: "ill", val: dead, activeOption: petInfo.activeOption });
  const ev = events.find((e) => e.type === "dead");
  assert.ok(ev, "旧实现写死 type:'ill'，导致播 sick 动画而不是 die");
  assert.equal(ev.active, "die", "包装层应据 type 映射到 die 动作");
});

test("普通生病时状态回调的 type 仍为 ill", () => {
  const { s, events } = makeState();
  const ill = { type: "ill", name: "感冒", health: 4, tolk: "鼻子塞" };
  s.doActive({ type: "ill", val: ill, activeOption: petInfo.activeOption });
  const ev = events.find((e) => e.type === "ill");
  assert.ok(ev);
  assert.equal(ev.active, "sick");
});

// ------------------------------------------------ doActive 不越权覆盖

test("开始打工不清除生病状态", () => {
  const ill = { type: "ill", name: "感冒", health: 4, cure: { name: "板蓝根" } };
  const { s } = makeState({ info: { health: 4 }, activeOption: { ill } });
  s.doActive({ type: "work", val: { name: "搬砖", useTime: 10 }, activeOption: petInfo.activeOption });
  const w = writes.find((x) => x.activeOption);
  assert.ok(w, "应写入 activeOption");
  assert.ok(w.activeOption.ill, "旧实现把 ill 无条件置 null，等于确认打工就免费治病/复活");
  assert.equal(w.activeOption.ill.name, "感冒");
  assert.ok(w.activeOption.work, "同时应写入 work");
});

test("开始打工不清除已装备的背景，也不误伤旅行状态", () => {
  const trip = { place: "北京", provinceId: 1 };
  const { s } = makeState({ activeOption: { background: "_b0000001", trip } });
  s.doActive({ type: "work", val: { name: "搬砖" }, activeOption: petInfo.activeOption });
  const w = writes.find((x) => x.activeOption);
  assert.equal(w.activeOption.background, "_b0000001");
  assert.deepEqual(w.activeOption.trip, trip, "打工不该顺手把 trip 擦掉（旅行定时器仍会到点发奖）");
});

test("开始学习不清除生病状态与背景", () => {
  const ill = { type: "ill", name: "感冒", health: 4 };
  const { s } = makeState({
    info: { health: 4 },
    activeOption: { ill, background: "_b0000001" },
  });
  s.doActive({
    type: "study",
    val: { object: "数学", classTime: 5 },
    activeOption: petInfo.activeOption,
  });
  const w = writes.find((x) => x.activeOption);
  assert.ok(w.activeOption.ill);
  assert.equal(w.activeOption.background, "_b0000001");
  assert.ok(w.activeOption.study);
});

// ------------------------------------------------ 心情上限

test("使用道具时心情按 maxInfo.mood 钳制，而不是硬编码 1000", () => {
  const { s } = makeState({ info: { mood: 480, hunger: 3000, clean: 3000 }, maxInfo: { mood: 500 } });
  const r = s.useConsumables({ type: "food", name: "苹果", starve: 10 });
  assert.ok(r);
  const w = writes.find((x) => x.info && x.info.mood !== undefined);
  assert.equal(w.info.mood, 500, "上限被改成 500 时不能钳到 1000");
});

test("玩具提升心情同样按 maxInfo.mood 钳制", () => {
  const { s } = makeState({ info: { mood: 480 }, maxInfo: { mood: 500 } });
  s.useConsumables({ type: "toy", name: "皮球", mood: 300 });
  const w = writes.find((x) => x.info && x.info.mood !== undefined);
  assert.equal(w.info.mood, 500);
});

test("心情未到上限时正常累加", () => {
  const { s } = makeState({ info: { mood: 100 }, maxInfo: { mood: 1000 } });
  s.useConsumables({ type: "toy", name: "皮球", mood: 300 });
  const w = writes.find((x) => x.info && x.info.mood !== undefined);
  assert.equal(w.info.mood, 400);
});

test("maxInfo.mood 缺失时回落到 1000 上限", () => {
  const { s } = makeState({ info: { mood: 990 }, maxInfo: { mood: undefined } });
  s.useConsumables({ type: "toy", name: "皮球", mood: 300 });
  const w = writes.find((x) => x.info && x.info.mood !== undefined);
  assert.equal(w.info.mood, 1000);
});

// 接管原 toy125.test.js 里那条「toy 使用后应与 food/commodity 同走状态回调」的
// 源码文本快照断言，改成真实行为断言（压缩产物重新打包不会误红）。
// 说明：构造函数的 callBackState 包装层按 e.type 去重（oldEvent），所以每次调用前
// 手动把 oldEvent 清空，才能观察到这一次的回调。
test("使用玩具后与食物一样触发状态回调", () => {
  const { s, events } = makeState({ info: { hunger: 3000, clean: 3000, mood: 100 } });
  s.oldEvent = null;
  s.useConsumables({ type: "toy", name: "皮球", mood: 100 });
  const ev = events.find((e) => e.val && e.val.type === "toy");
  assert.ok(ev, "toy 必须走 food/commodity 同一条状态回调");
  assert.equal(ev.type, "normal", "饥饿/清洁都健康时应回调 normal");
});

test("使用食物同样触发状态回调（对照）", () => {
  const { s, events } = makeState({ info: { hunger: 3000, clean: 3000 } });
  s.oldEvent = null;
  s.useConsumables({ type: "food", name: "苹果", starve: 10 });
  const ev = events.find((e) => e.val && e.val.type === "food");
  assert.ok(ev);
  assert.equal(ev.type, "normal");
});

test("非消耗类（background）使用后不触发该状态回调（反向对照）", () => {
  // 证明上面两条不是「任何类型都会回调」的空断言
  const { s, events } = makeState({ info: { hunger: 3000, clean: 3000 } });
  s.oldEvent = null;
  s.useConsumables({ type: "background", name: "某背景" });
  assert.equal(
    events.filter((e) => e.val && e.val.type === "background").length,
    0,
    "background 不在 food/commodity/toy 白名单里，不应走这条回调"
  );
});

// ------------------------------------------------ 死亡后不可喂食（原有行为不回退）

test("死亡状态下喂食仍被拒绝", () => {
  const dead = { type: "dead", name: "死亡", health: 0, cure: { name: "还魂丹" }, errTolk: "已死亡" };
  const { s } = makeState({ info: { health: 0 }, activeOption: { ill: dead } });
  const r = s.useConsumables({ type: "food", name: "苹果", starve: 10 });
  assert.equal(r.overType, "dead");
});

test("还魂丹可复活并保留背景", () => {
  const dead = { type: "dead", name: "死亡", health: 0, cure: { name: "还魂丹" }, successTolk: "又见到你" };
  const { s } = makeState({
    info: { health: 0 },
    activeOption: { ill: dead, background: "_b0000001" },
  });
  const r = s.useConsumables({ type: "medicine", name: "还魂丹" });
  assert.ok(r && !r.overType, "还魂丹应能复活");
  const w = writes.find((x) => x.info && x.info.health !== undefined);
  assert.equal(w.info.health, 5);
});
