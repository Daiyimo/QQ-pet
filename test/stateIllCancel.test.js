// 生病/死亡中止「打工 / 上学」后不得照发奖励。
//
// 背景：State.js 的 ill/dead 分支把 activeOption.work / study / trip 一起置 null。
// trip 曾有真缺陷 —— travel.js 有**进程内的 finishTimer + 内存 currentTrip 缓存**，
// 档案被清了定时器照样到点结算（可刷），修法是让 travel._trip() 以档案为唯一权威，
// 并让 State.js 的 ill 分支显式 cancelTravel({silent:true}) 收掉窗口与定时器。
//
// work / study 的结算机制**不同**：唯一结算点是 GrowUp.countdownActiveTime，
// 它由 GrowUpMain 每个 tick 用 `JSONto(getPetInfo().activeOption)` 现读档案驱动，
// 既没有进程内定时器、也没有内存缓存，且被 `activeOption.ill || ...` 二次拦住。
// 也就是说 work/study 天然就是「以档案为权威」，清空即不结算 —— 没有同构缺陷。
//
// 本文件把这个性质钉死：一旦有人给 work/study 加内存缓存 / 独立定时器，
// 或者把 ill 分支的清空改掉，下面的用例会红。
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// ---- 全局桩（State.js 与 GrowUp.js 共用同一份宠物档案，模拟真实主进程）----
let petInfo;
let writes;

global.getPetInfo = () => JSON.parse(JSON.stringify(petInfo));
global.setPetInfo = (d) => {
  writes.push(JSON.parse(JSON.stringify(d)));
  for (const g of Object.keys(d)) {
    petInfo[g] = { ...(petInfo[g] || {}), ...d[g] };
  }
};
global.JSONto = (e) => JSON.parse(JSON.stringify(e));
global.isNumber = (e) => (+e == +e && +e) || 0;
global.getRandom = (a, b) => (b === undefined ? a : a);
global.getRatio = () => false;
global.isStudyUpLevel = () => false;
// 与生产一致：addGoods 异步拿到一件道具后回调，回调里才发「下班/放学」气泡
global.addGoods = (type, cb) => cb("food*_10001");
global.$test = false;
global.getInterval = (e, t) => {
  let r = 0;
  for (const a in t) {
    if (typeof t[a] !== "object") {
      if (t[a]) {
        r = a;
        break;
      }
    } else if (+e <= t[a][1] && +e >= t[a][0]) {
      r = a;
      break;
    }
  }
  return r;
};
global.tool = {
  getTime: () => "2026-08-01",
  getDayHourTime: () => new Date(2026, 7, 1, 6, 0).getTime(),
};

const { State } = require(
  path.join(__dirname, "..", "src", "windows", "util", "pet", "State.js")
);
const { GrowUp } = require(
  path.join(__dirname, "..", "src", "windows", "util", "pet", "GrowUp.js")
);

// 一份「下一 tick 就该结算」的打工：stateTime+1 > overTime
const DUE_WORK = () => ({
  type: "work",
  name: "搬砖",
  key: "_w0001",
  overTime: 1,
  stateTime: 1,
  obtain: { yb: 100, charm: 0, intel: 0, strong: 0 },
  startTime: 0,
});
// 一份「下一 tick 就该放学」的上学
const DUE_STUDY = () => ({
  type: "study",
  name: "科目：数学",
  key: "_s0001",
  value: "mathematics",
  object: "数学",
  overTime: 1,
  stateTime: 1,
  obtain: {},
  startTime: 0,
});
const COLD = () => ({
  type: "ill",
  name: "感冒",
  health: 4,
  cure: { icon: "10001", name: "板蓝根" },
  tolk: "鼻子塞",
  errTolk: "吃错了",
  successTolk: "舒服多了",
});

function makeWorld(activeOption = {}) {
  petInfo = {
    info: {
      growth: 1000,
      hunger: 3000,
      clean: 3000,
      mood: 500,
      health: 5,
      yb: 1000,
      charm: 0,
      intel: 0,
      strong: 0,
      onLineTime: 0,
      onlineDataTime: 0,
      lastLoginTime: 0,
    },
    maxInfo: {
      stopGrowth: false,
      growthRate: 260,
      hunger: 3300,
      clean: 3300,
      mood: 1000,
      health: 5,
    },
    activeOption: {
      work: null,
      study: null,
      trip: null,
      ill: null,
      background: null,
      ...activeOption,
    },
    activeValue: { work: {}, study: { mathematics: 0 } },
    otherOptions: {
      pinkDiamond: false,
      growth: 0,
      growthValue: 0,
      pinkDiamondLevel: 0,
      pinkDiamondBeginDate: 0,
      pinkDiamondExpirationDate: 0,
      sweetHeart: false,
    },
    fishing: { allvipcnt: 0, canusecnt: 0, harvestfish: 0, fishes: [] },
  };
  writes = [];
  const events = [];
  const state = new State({ callBackState: (e) => events.push(e) });
  const growUp = new GrowUp({
    petInfo: JSON.parse(JSON.stringify(petInfo)),
    growTime: 6e4,
    callBackState: (e) => events.push(e),
  });
  writes = [];
  events.length = 0;
  return { state, growUp, events };
}

// 跑一个成长 tick（unGrow 跳过饥饿/成长衰减，只保留活动倒计时结算这条链路）
function tick(growUp) {
  growUp.GrowUpMain({ unGrow: true });
}

const overEvents = (events, name) =>
  events.filter((e) => Array.isArray(e.communication) && e.communication[1] === name);

// ------------------------------------------------ 阳性对照：没生病就该结算

test("没生病时打工到点会按档案结算：发工资、清空 work、播下班气泡", () => {
  const { growUp, events } = makeWorld({ work: DUE_WORK() });
  tick(growUp);
  assert.equal(petInfo.info.yb, 1100, "obtain.yb 应加到 info.yb 上");
  assert.equal(petInfo.activeOption.work, null, "结算后 work 应被清空");
  assert.equal(overEvents(events, "overWork").length, 1, "应恰好播一次下班气泡");
});

test("没生病时上学到点会按档案结算：课时 +1、清空 study、播放学气泡", () => {
  const { growUp, events } = makeWorld({ study: DUE_STUDY() });
  tick(growUp);
  assert.equal(petInfo.activeValue.study.mathematics, 1, "放学应记 1 节课时");
  assert.equal(petInfo.activeOption.study, null);
  assert.equal(overEvents(events, "overStudy").length, 1, "应恰好播一次放学气泡");
});

// ------------------------------------------------ 生病中止后不得结算

test("生病中止打工后，本该到点的那一轮不发工资也不播下班气泡", () => {
  const { state, growUp, events } = makeWorld({ work: DUE_WORK() });
  state.doActive({ type: "ill", val: COLD(), activeOption: petInfo.activeOption });
  assert.equal(petInfo.activeOption.work, null, "前置：ill 分支必须清空 work");
  events.length = 0;

  tick(growUp);
  assert.equal(petInfo.info.yb, 1000, "被生病中止的打工不得照发工资");
  assert.equal(overEvents(events, "overWork").length, 0, "不得播下班气泡");
});

test("生病中止上学后，本该到点的那一轮不记课时也不播放学气泡", () => {
  const { state, growUp, events } = makeWorld({ study: DUE_STUDY() });
  state.doActive({ type: "ill", val: COLD(), activeOption: petInfo.activeOption });
  assert.equal(petInfo.activeOption.study, null, "前置：ill 分支必须清空 study");
  events.length = 0;

  tick(growUp);
  assert.equal(petInfo.activeValue.study.mathematics, 0, "被生病中止的上学不得记课时");
  assert.equal(overEvents(events, "overStudy").length, 0);
});

test("病死中止打工后同样不发工资", () => {
  const dead = { type: "dead", name: "死亡", health: 0, cure: { name: "还魂丹" }, tolk: "走了" };
  const { state, growUp, events } = makeWorld({ work: DUE_WORK() });
  state.doActive({ type: "ill", val: dead, activeOption: petInfo.activeOption });
  assert.equal(petInfo.activeOption.work, null);
  events.length = 0;

  tick(growUp);
  assert.equal(petInfo.info.yb, 1000);
  assert.equal(overEvents(events, "overWork").length, 0);
});

// ------------------------------------------------ 治好之后也不能补发 / 不能刷

test("生病中止打工后即使被治好，工资也不会补发，连跑多轮也刷不出来", () => {
  const { state, growUp, events } = makeWorld({ work: DUE_WORK() });
  state.doActive({ type: "ill", val: COLD(), activeOption: petInfo.activeOption });
  const cured = state.useConsumables({ type: "medicine", name: "板蓝根" });
  assert.ok(cured && !cured.overType, "前置：板蓝根应能治好感冒");
  assert.equal(petInfo.activeOption.ill, null, "前置：治好后 ill 应为 null");
  assert.equal(petInfo.activeOption.work, null, "治病不得把打工状态复活");
  events.length = 0;
  const ybAfterCure = petInfo.info.yb;

  for (let i = 0; i < 3; i++) tick(growUp);
  assert.equal(petInfo.info.yb, ybAfterCure, "治好后连跑 3 轮都不得补发工资");
  assert.equal(overEvents(events, "overWork").length, 0, "3 轮都不得播下班气泡");
});

// ------------------------------------------------ 两道防线各自独立

test("结算只认档案：外部清掉 activeOption.work 后到点也不结算（GrowUp 不留内存缓存）", () => {
  // 模拟 trip 曾经的故障形态：先让实例见过这份 work，再把档案清掉。
  // 若 GrowUp 像旧 travel.js 那样缓存 currentTrip，这一轮就会照常发钱。
  const { growUp, events } = makeWorld({ work: { ...DUE_WORK(), stateTime: 0, overTime: 5 } });
  tick(growUp); // 未到点，只推进 stateTime
  assert.equal(petInfo.info.yb, 1000, "前置：未到点不该结算");
  petInfo.activeOption.work = null; // 外部取消（生病 / 停止状态 / 重启清档）
  events.length = 0;

  for (let i = 0; i < 6; i++) tick(growUp);
  assert.equal(petInfo.info.yb, 1000, "档案里没有 work 就绝不能结算");
  assert.equal(overEvents(events, "overWork").length, 0);
});

test("第二道防线：activeOption.ill 存在时，即便 work 还在档案里也不结算", () => {
  const { growUp, events } = makeWorld({ work: DUE_WORK(), ill: COLD() });
  tick(growUp);
  assert.equal(petInfo.info.yb, 1000, "生病期间倒计时结算整段被跳过");
  assert.deepEqual(petInfo.activeOption.work, DUE_WORK(), "work 原样留档，等治好后继续");
  assert.equal(overEvents(events, "overWork").length, 0);
});

// ------------------------------------------------ 主动「停止状态」不发奖（对照口径）

test("主动停止打工（stopNow）清空状态但不发工资", () => {
  const { growUp, events } = makeWorld({ work: { ...DUE_WORK(), stopNow: true } });
  tick(growUp);
  assert.equal(petInfo.info.yb, 1000, "提前收工不该拿全额工资");
  assert.equal(petInfo.activeOption.work, null);
  assert.equal(overEvents(events, "overWork").length, 0);
});
