// travel.js 旅游系统单元测试：前置校验、收集去重、全收集随机、回家奖励与清状态、重启恢复。
// 时钟 / 随机数 / 定时器全部注入，主窗口与 petInfo 用桩。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTravelService,
  PROVINCES,
  MAIN_WINDOW_POLL_MS,
  MAIN_WINDOW_WAIT_MS,
} = require("../src/service/travel.js");

// ---- 测试脚手架 ----
function makeWorld(opt = {}) {
  let now = opt.now || 1000000;
  const randoms = opt.randoms || [];
  let ri = 0;
  const timers = [];
  let tid = 0;

  const pet = {
    info: { mood: 500, yb: 300, health: 5 },
    maxInfo: { mood: 1000 },
    activeOption: { work: null, study: null, trip: null, ill: null, die: null },
  };
  const speaks = [];
  const plays = [];
  const winCalls = [];
  const mainWindow = {
    show: true,
    window: {
      webContents: { send: (ch, data) => plays.push(data.active) },
      hide: () => winCalls.push("hide"),
      show: () => winCalls.push("show"),
    },
  };
  const storeData = opt.storeData || {};
  const store = {
    getItem: (k) => storeData[k],
    setItem: (k, v) => {
      storeData[k] = v;
    },
  };
  const achCalls = [];
  const deps = {
    now: () => now,
    random: () => (ri < randoms.length ? randoms[ri++] : 0),
    setTimeout: (fn, ms) => {
      const t = { id: ++tid, fn, ms, cleared: false, fired: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
    getPetInfo: () => pet,
    setPetInfo: (payload) => {
      if (payload.info) Object.assign(pet.info, payload.info);
      if (payload.activeOption) Object.assign(pet.activeOption, payload.activeOption);
    },
    openSpeak: (o) => speaks.push(o.data.data),
    mainWindow,
    store,
  };
  if (opt.withAchievement) {
    deps.achievementService = { check: (name) => achCalls.push(name) };
  }
  const svc = createTravelService(deps);
  return {
    svc,
    pet,
    speaks,
    plays,
    winCalls,
    timers,
    storeData,
    achCalls,
    mainWindow,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    // 触发所有未清除、未触发的定时器（按注册顺序）
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

// ---- 前置校验：各拒绝分支 ----
test("startTravel：有 die/ill/work/study/trip 状态时拒绝并气泡提示", () => {
  for (const key of ["die", "ill", "work", "study", "trip"]) {
    const w = makeWorld();
    w.pet.activeOption[key] = { foo: 1 };
    const r = w.svc.startTravel();
    assert.equal(r.ok, false, key);
    assert.equal(r.reason, key);
    assert.equal(w.speaks.length, 1, key + " 应有拒绝气泡");
    // 拒绝后不应写入新的 trip（trip 分支保持原值）
    if (key !== "trip") assert.equal(w.pet.activeOption.trip, null);
    assert.equal(w.timers.length, 0, key + " 不应启动定时器");
  }
});

// ---- 开始旅游 ----
test("startTravel：成功时写入 trip、播 exit 并隐藏主窗口、时长 8~15 分钟", () => {
  const w = makeWorld({ randoms: [0, 0] }); // 选中第 0 个候选=北京，时长=8 分钟
  const r = w.svc.startTravel();
  assert.equal(r.ok, true);
  assert.equal(r.province.name, "北京");
  assert.equal(r.duration, 8 * 60 * 1000);
  const trip = w.pet.activeOption.trip;
  assert.equal(trip.place, "北京");
  assert.equal(trip.provinceId, 1);
  assert.equal(trip.startTime, w.now());
  assert.equal(trip.duration, 480000);
  assert.ok(w.plays.includes("exit"), "应播放 exit 动画");
  assert.equal(w.winCalls.includes("hide"), false, "exit 动画播完前不隐藏");
  assert.equal(w.timers.length, 2, "hide + finish 两个定时器");
  // 触发 hide 定时器后主窗口隐藏
  w.runTimers();
  assert.ok(w.winCalls.includes("hide"));
});

test("startTravel：随机时长落在 8~15 分钟区间", () => {
  for (const rnd of [0, 0.5, 0.99]) {
    const w = makeWorld({ randoms: [0, rnd] });
    const r = w.svc.startTravel();
    assert.ok(r.duration >= 8 * 60000 && r.duration <= 15 * 60000);
  }
});

// ---- 回家结算 ----
test("finishTravel：收集写入、清 trip、奖励 mood+50/yb+15、气泡与成就联动", () => {
  const w = makeWorld({ randoms: [0, 0], withAchievement: true });
  w.svc.startTravel();
  w.runTimers(); // hide + finish
  assert.equal(w.pet.activeOption.trip, null, "trip 应清除");
  assert.deepEqual(w.svc.collected, [1]);
  assert.equal(w.pet.info.travel_china_num, 1);
  assert.equal(w.pet.info.mood, 550, "mood +50");
  assert.equal(w.pet.info.yb, 315, "yb +15");
  assert.ok(w.winCalls.includes("show"), "主窗口应恢复");
  assert.ok(w.plays.includes("enter"), "应播放 enter 动画");
  assert.ok(
    w.speaks.some((s) => s.includes("我从北京回来啦")),
    "应有带回文案",
  );
  assert.deepEqual(w.achCalls, ["travel"], "成就系统应收到 travel 检查");
  assert.deepEqual(w.storeData.travel_china.collected, [1], "$Store 应持久化");
});

test("finishTravel：无成就服务时不报错", () => {
  const w = makeWorld({ randoms: [0, 0] });
  w.svc.startTravel();
  w.runTimers();
  assert.deepEqual(w.svc.collected, [1]);
});

test("finishTravel：mood 奖励按 maxInfo.mood 上限截断", () => {
  const w = makeWorld({ randoms: [0, 0] });
  w.pet.info.mood = 990;
  w.svc.startTravel();
  w.runTimers();
  assert.equal(w.pet.info.mood, 1000);
});

test("finishTravel：无旅行时返回 not_traveling", () => {
  const w = makeWorld();
  const r = w.svc.finishTravel();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_traveling");
});

// ---- 收集去重 ----
test("收集去重：同一省份重复带回只记一次", () => {
  const storeData = {};
  // 第一次：旅游北京并回家
  const w1 = makeWorld({ randoms: [0, 0], storeData });
  w1.svc.startTravel();
  w1.runTimers();
  assert.deepEqual(w1.svc.collected, [1]);
  // 第二次：档案里又是一个去北京的 trip（同 store 恢复后 finish）
  const w2 = makeWorld({ storeData });
  w2.pet.activeOption.trip = {
    place: "北京",
    provinceId: 1,
    startTime: w2.now() - 1000,
    duration: 500,
  };
  w2.svc.init(); // 已过期 -> 直接 finish
  assert.deepEqual(w2.svc.collected, [1], "北京不应重复收集");
  assert.equal(w2.pet.info.travel_china_num, 1);
});

// ---- 全收集后随机任意 ----
test("startTravel：34 省全收集后仍可随机任意省份出发", () => {
  const w = makeWorld({ randoms: [0.9, 0.2] });
  w.svc.collected = PROVINCES.map((p) => p.id);
  const r = w.svc.startTravel();
  assert.equal(r.ok, true);
  assert.equal(r.province.id, PROVINCES[Math.floor(0.9 * 34)].id);
  assert.equal(r.duration, 9 * 60 * 1000); // 8 + floor(0.2*8) = 9 分钟
});

// ---- 提前召回 ----
test("cancelTravel：清 trip、窗口恢复、无奖励、不收集", () => {
  const w = makeWorld({ randoms: [0, 0] });
  w.svc.startTravel();
  const r = w.svc.cancelTravel();
  assert.equal(r.ok, true);
  assert.equal(w.pet.activeOption.trip, null);
  assert.ok(w.winCalls.includes("show"));
  assert.deepEqual(w.svc.collected, []);
  assert.equal(w.pet.info.mood, 500, "召回无 mood 奖励");
  assert.equal(w.pet.info.yb, 300, "召回无 yb 奖励");
  assert.ok(w.timers.every((t) => t.cleared), "定时器应全部清除");
  // 定时器再触发也不应结算
  w.runTimers();
  assert.deepEqual(w.svc.collected, []);
});

test("cancelTravel：无旅行时返回 not_traveling", () => {
  const w = makeWorld();
  const r = w.svc.cancelTravel();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_traveling");
});

// ---- getStatus ----
test("getStatus：空闲与旅游中两种形态", () => {
  const w = makeWorld({ randoms: [0, 0] });
  let s = w.svc.getStatus();
  assert.deepEqual(s, { traveling: false, collected: [], total: 34 });
  w.svc.startTravel();
  w.advance(60000); // 过了 1 分钟
  s = w.svc.getStatus();
  assert.equal(s.traveling, true);
  assert.equal(s.province.name, "北京");
  assert.equal(s.remainingMs, 7 * 60000);
  assert.equal(s.total, 34);
});

// ---- 重启恢复 ----
test("init：剩余时间>0 时保持隐藏并继续倒计时", () => {
  const w = makeWorld();
  w.pet.activeOption.trip = {
    place: "四川",
    provinceId: 21,
    startTime: w.now() - 1000,
    duration: 60000,
  };
  const r = w.svc.init();
  assert.equal(r.resumed, true);
  assert.equal(r.remainingMs, 59000);
  assert.ok(w.winCalls.includes("hide"), "宠物仍在外，窗口保持隐藏");
  const finishTimers = w.timers.filter((t) => t.ms === 59000);
  assert.equal(finishTimers.length, 1, "应按剩余时间续设定时器");
  // 走到到期：自动回家并收集四川
  w.runTimers();
  assert.deepEqual(w.svc.collected, [21]);
  assert.equal(w.pet.activeOption.trip, null);
});

test("init：旅行已过期时直接 finishTravel 结算", () => {
  const w = makeWorld();
  w.pet.activeOption.trip = {
    place: "云南",
    provinceId: 23,
    startTime: w.now() - 120000,
    duration: 60000,
  };
  const r = w.svc.init();
  assert.equal(r.resumed, true);
  assert.equal(r.finished, true);
  assert.deepEqual(w.svc.collected, [23]);
  assert.equal(w.pet.activeOption.trip, null);
  assert.ok(w.speaks.some((s) => s.includes("我从云南回来啦")));
});

test("init：从 $Store 恢复历史收集进度", () => {
  const storeData = { travel_china: { collected: [1, 5, 999] } }; // 999 为非法 id，应被过滤
  const w = makeWorld({ storeData });
  const r = w.svc.init();
  assert.equal(r.resumed, false);
  assert.deepEqual(w.svc.collected, [1, 5]);
});

// ---- init 与主窗口创建竞态（doMain 在 main.cleate() 完成前同步调 init）----
// makeWorld 的 mainWindow 桩默认 window 已就绪；竞态用例把 window 置 null 模拟窗口尚未创建
test("init：主窗口未就绪时延迟隐藏，就绪后补隐藏（旅行中的宠物不再留在桌面）", () => {
  const w = makeWorld();
  w.pet.activeOption.trip = {
    place: "四川",
    provinceId: 21,
    startTime: w.now() - 1000,
    duration: 60000,
  };
  w.mainWindow.window = null; // 主窗口还在异步创建
  const r = w.svc.init();
  assert.equal(r.resumed, true);
  assert.equal(r.remainingMs, 59000);
  assert.equal(w.winCalls.includes("hide"), false, "窗口未就绪时不应静默 no-op 掉隐藏");
  const pollTimers = w.timers.filter((t) => t.ms === MAIN_WINDOW_POLL_MS);
  assert.equal(pollTimers.length, 1, "应挂一个窗口就绪轮询");
  // 倒计时定时器不依赖窗口，照常续上
  assert.ok(w.timers.some((t) => t.ms === 59000));
  // 窗口创建完成 → 轮询发现就绪 → 补隐藏
  w.mainWindow.window = {
    webContents: { send: (ch, data) => w.plays.push(data.active) },
    hide: () => w.winCalls.push("hide"),
    show: () => w.winCalls.push("show"),
  };
  w.runTimers();
  assert.ok(w.winCalls.includes("hide"), "窗口就绪后应补上隐藏");
});

test("init：窗口未就绪时过期旅行延迟结算，就绪后补 enter 动画与收集", () => {
  const w = makeWorld();
  w.pet.activeOption.trip = {
    place: "云南",
    provinceId: 23,
    startTime: w.now() - 120000,
    duration: 60000,
  };
  w.mainWindow.window = null;
  const r = w.svc.init();
  assert.equal(r.resumed, true);
  assert.equal(r.finished, false);
  assert.equal(r.deferred, true);
  assert.deepEqual(w.svc.collected, [], "窗口就绪前暂不结算");
  w.mainWindow.window = {
    webContents: { send: (ch, data) => w.plays.push(data.active) },
    hide: () => w.winCalls.push("hide"),
    show: () => w.winCalls.push("show"),
  };
  w.runTimers();
  assert.deepEqual(w.svc.collected, [23]);
  assert.equal(w.pet.activeOption.trip, null);
  assert.ok(w.plays.includes("enter"), "应补播 enter 动画");
  assert.ok(w.speaks.some((s) => s.includes("我从云南回来啦")), "应补回家气泡");
});

test("init：延迟隐藏期间旅行被取消（epoch 作废），窗口就绪后不再误隐藏", () => {
  const w = makeWorld();
  w.pet.activeOption.trip = {
    place: "北京",
    provinceId: 1,
    startTime: w.now() - 1000,
    duration: 60000,
  };
  w.mainWindow.window = null;
  w.svc.init();
  w.svc.cancelTravel(); // 用户手动召回：trip 清除，epoch +1
  w.mainWindow.window = {
    webContents: { send: (ch, data) => w.plays.push(data.active) },
    hide: () => w.winCalls.push("hide"),
    show: () => w.winCalls.push("show"),
  };
  w.runTimers();
  assert.equal(w.winCalls.includes("hide"), false, "已取消的旅行不应再隐藏窗口");
});

test("init：窗口始终不就绪时超时兜底，过期旅行仍结算不丢奖励", () => {
  const w = makeWorld();
  w.pet.activeOption.trip = {
    place: "云南",
    provinceId: 23,
    startTime: w.now() - 120000,
    duration: 60000,
  };
  w.mainWindow.window = null; // 永远不就绪
  w.svc.init();
  w.advance(MAIN_WINDOW_WAIT_MS + 1000); // 越过等待上限
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.map((a) => String(a)).join(" "));
  try {
    w.runTimers(); // 第一次轮询即触发超时兜底
  } finally {
    console.error = origError;
  }
  assert.deepEqual(w.svc.collected, [23], "超时降级后仍应完成结算");
  assert.equal(w.pet.activeOption.trip, null);
  assert.ok(
    errors.some((s) => s.includes("[travel]") && s.includes("降级")),
    "超时兜底必须留日志"
  );
});
