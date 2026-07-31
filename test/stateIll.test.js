// State.js 状态机回归测试：病树下标、doActive 不越权覆盖状态位、死亡类型、心情上限。
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// ---- 全局桩 ----
let petInfo;
let writes;
let randomQueue = [];

global.getPetInfo = () => JSON.parse(JSON.stringify(petInfo));
global.setPetInfo = (d) => {
  writes.push(JSON.parse(JSON.stringify(d)));
  for (const g of Object.keys(d)) {
    petInfo[g] = { ...(petInfo[g] || {}), ...d[g] };
  }
};
global.isNumber = (e) => (+e == +e && +e) || 0;
// getRandom 可编排：病树随机二选一要能确定性覆盖两个分支
global.getRandom = (a, b) => (randomQueue.length ? randomQueue.shift() : a);
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
  const events = [];
  const s = new State({ callBackState: (e) => events.push(e) });
  writes = [];
  events.length = 0;
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
  for (const pick of [0, 1]) {
    const { s } = makeState({ info: { clean: 100 } });
    randomQueue = [pick];
    forceIll(s, "dirty");
    const w = writes.find((x) => x.activeOption && x.activeOption.ill);
    assert.ok(w, `pick=${pick} 应生成疾病`);
    names.add(w.activeOption.ill.name);
  }
  assert.deepEqual([...names].sort(), ["咳嗽", "感冒"], "旧实现 getRandom(1,2) 让「咳嗽」永不可达");
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
