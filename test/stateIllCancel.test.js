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

// ================================================================================
// cancelTravel 必须无条件执行（不能藏在 work/study/trip 的 if-else 链里）
//
// ill/dead 分支的形状是 `o.work ? … : o.study ? … : o.trip && …`，而 cancelTravel
// 原先写在 trip 那一支里。档案里**同时**有 work 与 trip 时只会走 work 分支 →
// cancelTravel 不被调用 → travel.js 的 finishTimer 还挂着、主窗口还是隐藏的 →
// 桌面上宠物凭空消失，得等回家定时器到点才恢复。
// （work 与 trip 理论互斥，但互斥校验只在 travel.startTravel 一侧；State.doActive 开工时
//  并不清 trip，所以这个组合可达。）
//
// 档案侧的清空（trip: r，r 恒为 null）本来就是无条件的，缺的只是通知 travelService
// 收窗口与定时器 —— 所以下面用**真实 TravelService**（不是桩）与 State 共用一份档案，
// 断言的是真实副作用（窗口恢复、不结算），而不是"某个 mock 被调用过"。
// ================================================================================

const { createTravelService } = require(
  path.join(__dirname, "..", "src", "service", "travel.js")
);

// 真实旅游服务挂到 global.travelService（State.js 就是从这里取的），共用上面的 petInfo。
function attachRealTravelService() {
  const timers = [];
  const winCalls = [];
  const speaks = [];
  let now = 1e6;
  const svc = createTravelService({
    now: () => now,
    random: () => 0, // 固定选第一个未收集省份、最短时长（8 分钟）
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false, fired: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
    // 现读 petInfo：State 的 global.setPetInfo 会整体替换 activeOption 对象，不能缓存引用
    getPetInfo: () => petInfo,
    setPetInfo: (payload) => {
      for (const g of Object.keys(payload)) {
        petInfo[g] = { ...(petInfo[g] || {}), ...payload[g] };
      }
    },
    openSpeak: (o) => speaks.push(o.data.data),
    mainWindow: {
      show: true,
      window: {
        webContents: { send: (ch, d) => winCalls.push("active:" + d.active) },
        hide: () => winCalls.push("hide"),
        show: () => winCalls.push("show"),
      },
    },
    store: { getItem: () => undefined, setItem: () => {} },
    achievementService: { check: () => {} },
  });
  global.travelService = svc;
  return {
    svc,
    timers,
    winCalls,
    speaks,
    advance: (ms) => {
      now += ms;
    },
    // 触发所有未清除、未触发的定时器（回家结算就挂在这里）
    runTimers: () => {
      for (const t of timers) {
        if (!t.cleared && !t.fired) {
          t.fired = true;
          t.fn();
        }
      }
    },
  };
}

function captureConsoleError() {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.map((x) => String(x)).join(" "));
  return {
    errors,
    restore() {
      console.error = orig;
    },
  };
}

test("同时有 work 和 trip 时生病：旅行也必须被取消（主窗口恢复、回家定时器不再结算）", (t) => {
  const { state } = makeWorld();
  const w = attachRealTravelService();
  t.after(() => {
    delete global.travelService;
  });

  const trip = w.svc.startTravel();
  assert.equal(trip.ok, true, "前置：应能出发");
  // 只跑 exit 动画那个短定时器，让主窗口进入隐藏态；回家定时器留着
  const hideTimer = w.timers.find((x) => x.ms < trip.duration);
  hideTimer.fired = true;
  hideTimer.fn();
  assert.deepEqual(w.winCalls.slice(-1), ["hide"], "前置：旅游期间主窗口应已隐藏");

  // 打工与旅行同时在档案里（doActive 开工不清 trip，故该组合可达）
  petInfo.activeOption.work = DUE_WORK();
  assert.ok(petInfo.activeOption.trip, "前置：档案里应同时有 work 和 trip");
  w.winCalls.length = 0;
  w.speaks.length = 0;

  state.doActive({ type: "ill", val: COLD(), activeOption: petInfo.activeOption });

  assert.equal(petInfo.activeOption.trip, null, "ill 分支必须清空 trip");
  assert.equal(petInfo.activeOption.work, null, "ill 分支同时清空 work");
  assert.deepEqual(
    w.winCalls,
    ["show", "active:enter"],
    "走 work 分支时也必须通知 travelService：主窗口要被恢复出来，宠物不能凭空消失"
  );
  assert.deepEqual(w.speaks, [], "silent:true 时不得播「旅行取消啦」，免得盖掉「我生病了」");
  assert.equal(w.svc.getStatus().traveling, false, "服务侧也应认为旅行已结束");

  // 回家定时器已被清除：到点也不结算（不发 yb/mood、不收集省份）
  w.advance(trip.duration + 1);
  w.runTimers();
  assert.equal(petInfo.info.yb, 1000, "被取消的旅行不得照发元宝");
  assert.equal(petInfo.info.mood, 500, "也不得照加心情");
  assert.deepEqual(w.svc.getStatus().collected, [], "不得收集省份");
});

test("同时有 study 和 trip 时生病：旅行同样被取消", (t) => {
  const { state } = makeWorld();
  const w = attachRealTravelService();
  t.after(() => {
    delete global.travelService;
  });
  const trip = w.svc.startTravel();
  petInfo.activeOption.study = DUE_STUDY();
  w.winCalls.length = 0;

  state.doActive({ type: "ill", val: COLD(), activeOption: petInfo.activeOption });

  assert.equal(petInfo.activeOption.trip, null);
  assert.equal(petInfo.activeOption.study, null);
  assert.ok(w.winCalls.includes("show"), "走 study 分支时也要恢复主窗口");
  w.advance(trip.duration + 1);
  w.runTimers();
  assert.equal(petInfo.info.yb, 1000, "被取消的旅行不得照发元宝");
});

test("只有 trip 时生病：原有行为不回退（清 trip、恢复主窗口、不结算）", (t) => {
  const { state } = makeWorld();
  const w = attachRealTravelService();
  t.after(() => {
    delete global.travelService;
  });
  const trip = w.svc.startTravel();
  w.winCalls.length = 0;

  state.doActive({ type: "ill", val: COLD(), activeOption: petInfo.activeOption });

  assert.equal(petInfo.activeOption.trip, null);
  assert.ok(w.winCalls.includes("show"));
  w.advance(trip.duration + 1);
  w.runTimers();
  assert.equal(petInfo.info.yb, 1000);
});

test("病死（dead）中止时同样取消旅行", (t) => {
  const dead = { type: "dead", name: "死亡", health: 0, cure: { name: "还魂丹" }, tolk: "走了" };
  const { state } = makeWorld();
  const w = attachRealTravelService();
  t.after(() => {
    delete global.travelService;
  });
  w.svc.startTravel();
  petInfo.activeOption.work = DUE_WORK();
  w.winCalls.length = 0;

  state.doActive({ type: "ill", val: dead, activeOption: petInfo.activeOption });

  assert.equal(petInfo.activeOption.trip, null);
  assert.ok(w.winCalls.includes("show"), "死亡中止旅行也要把主窗口交回来");
});

test("cancelTravel 必须在写档之前调用：调用瞬间档案里还看得见 trip", (t) => {
  // travel._trip() 以档案为唯一权威。若把调用挪到 setPetInfo 之后，档案里的 trip 已是 null，
  // cancelTravel 只会拿到 not_traveling 直接返回 —— 定时器与隐藏的主窗口仍然没人收。
  const { state } = makeWorld({ work: DUE_WORK(), trip: { place: "云南", provinceId: 1 } });
  const seen = [];
  global.travelService = {
    cancelTravel(opt) {
      seen.push({
        tripInArchive: getPetInfo().activeOption.trip,
        silent: opt && opt.silent,
      });
      return { ok: true };
    },
  };
  t.after(() => {
    delete global.travelService;
  });

  state.doActive({ type: "ill", val: COLD(), activeOption: petInfo.activeOption });

  assert.equal(seen.length, 1, "应恰好调用一次 cancelTravel");
  assert.equal(seen[0].silent, true, "必须传 silent:true");
  assert.deepEqual(
    seen[0].tripInArchive,
    { place: "云南", provinceId: 1 },
    "调用时档案里必须仍有 trip，否则 travel 侧只会返回 not_traveling"
  );
});

test("本来没在旅行时，无条件调用 cancelTravel 是安全空操作（not_traveling、窗口不动、无异常日志）", (t) => {
  const { state } = makeWorld({ work: DUE_WORK() });
  const w = attachRealTravelService(); // 从未 startTravel
  const results = [];
  const real = w.svc.cancelTravel.bind(w.svc);
  global.travelService = {
    cancelTravel: (opt) => {
      const r = real(opt); // 真实实现，只是把返回值截下来看
      results.push(r);
      return r;
    },
  };
  const hook = captureConsoleError();
  t.after(() => {
    hook.restore();
    delete global.travelService;
  });

  state.doActive({ type: "ill", val: COLD(), activeOption: petInfo.activeOption });

  assert.deepEqual(
    results,
    [{ ok: false, reason: "not_traveling" }],
    "无旅行时真实 cancelTravel 应原样返回 not_traveling"
  );
  assert.deepEqual(w.winCalls, [], "不得顺手 show/hide 主窗口");
  assert.deepEqual(w.speaks, [], "不得多播气泡");
  assert.deepEqual(hook.errors, [], "空操作不该留异常日志");
  assert.equal(petInfo.activeOption.work, null, "生病中止打工的既有行为不受影响");
});

test("travelService.cancelTravel 抛错时：生病流程照走完，且异常留完整堆栈", (t) => {
  const { state, events } = makeWorld({ work: DUE_WORK(), trip: { place: "云南" } });
  global.travelService = {
    cancelTravel() {
      throw new Error("窗口已销毁");
    },
  };
  const hook = captureConsoleError();
  t.after(() => {
    hook.restore();
    delete global.travelService;
  });

  state.doActive({ type: "ill", val: COLD(), activeOption: petInfo.activeOption });

  assert.equal(petInfo.activeOption.work, null, "取消旅行失败不得连清档一起黄掉");
  assert.equal(petInfo.activeOption.trip, null);
  assert.equal(petInfo.info.health, 4, "病情仍要写进档案");
  assert.equal(events.filter((e) => e.type === "ill").length, 1, "气泡照播一次");
  assert.equal(hook.errors.length, 1, "必须恰好留一条错误日志（不是裸吞）");
  assert.match(hook.errors[0], /^\[State\]/, "日志前缀");
  assert.match(hook.errors[0], /Error: 窗口已销毁/, "必须带堆栈，而不是只有一句话");
  assert.match(
    hook.errors[0],
    /主窗口可能仍处隐藏态/,
    "必须写清降级后的行为"
  );
});
