// travel.js 旅游系统单元测试：前置校验、收集去重、全收集随机、回家奖励与清状态、重启恢复。
// 时钟 / 随机数 / 定时器全部注入，主窗口与 petInfo 用桩。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTravelService,
  PROVINCES,
  MAIN_WINDOW_POLL_MS,
  MAIN_WINDOW_WAIT_MS,
  MAX_TIMEOUT_MS,
} = require("../src/service/travel.js");

// console.warn / console.error 捕获（断言"必须留日志"，并避免污染测试输出）
function hookConsole() {
  const warns = [];
  const errors = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...a) => warns.push(a.map((x) => String(x)).join(" "));
  console.error = (...a) => errors.push(a.map((x) => String(x)).join(" "));
  return {
    warns,
    errors,
    restore() {
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

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
    deps,
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

// ---- 缺陷 1：生病清 trip 与 travelService 的状态分叉（可刷元宝/省份）----
// 真实触发序列：开始旅游（8~15 分钟）→ 旅游期间饥饿/清洁跌破阈值**自动**生病 →
// State.js 的 ill 分支把 activeOption.trip 清空、播"我不能旅游了~" → 到点 finishTimer
// 仍触发 finishTravel → 旧 _trip() 内存优先，从 currentTrip 拿到行程 →
// 收集省份 + mood+50 + yb+15。取消被撤销。

test("档案 trip 被外部清除（生病/停止状态）后，回家定时器到点不再收集省份也不发奖励", () => {
  const w = makeWorld({ randoms: [0, 0] });
  w.svc.startTravel();
  assert.equal(w.pet.activeOption.trip.place, "北京");
  // 模拟 State.js 的 ill/dead 分支：只清档案，不经 travelService
  w.pet.activeOption.trip = null;
  const spy = hookConsole();
  try {
    w.runTimers(); // hide + finish 都到点
  } finally {
    spy.restore();
  }
  assert.deepEqual(w.svc.collected, [], "档案里已无 trip，不得收集省份");
  assert.equal(w.pet.info.yb, 300, "不得发放元宝奖励");
  assert.equal(w.pet.info.mood, 500, "不得发放心情奖励");
  assert.equal(
    w.speaks.filter((s) => s.includes("回来啦")).length,
    0,
    "不得播回家文案"
  );
  assert.equal(w.svc.currentTrip, null, "内存缓存应随档案作废");
  assert.equal(w.svc.getStatus().traveling, false, "状态查询应显示不在旅游");
  assert.ok(
    spy.warns.some(
      (s) => s.includes("[travel]") && s.includes("已被外部清除")
    ),
    `档案与内存分叉必须留 warn 日志，实际：${JSON.stringify(spy.warns)}`
  );
});

test("生病中止旅行：State.js 的 ill 分支会通知 travelService，宠物回到桌面且奖励不再发放", () => {
  // 端到端跑真实的 State.js（webpack 压缩产物）：它的病情分支在清 trip 前必须
  // 通知 travelService，否则主窗口会一直隐藏（宠物凭空消失）且定时器照发奖励。
  const w = makeWorld({ randoms: [0, 0] });
  const prev = {
    getPetInfo: global.getPetInfo,
    setPetInfo: global.setPetInfo,
    getRatio: global.getRatio,
    getRandom: global.getRandom,
    travelService: global.travelService,
  };
  global.getPetInfo = w.deps.getPetInfo;
  global.setPetInfo = w.deps.setPetInfo;
  global.getRatio = () => false;
  global.getRandom = (a) => a;
  global.travelService = w.svc; // 生产侧 travel.js 就是这样挂 global 的
  const spy = hookConsole();
  try {
    const { State } = require("../src/windows/util/pet/State.js");
    w.svc.startTravel();
    w.timers[0].fired = true;
    w.timers[0].fn(); // exit 动画播完 → 主窗口隐藏
    assert.equal(w.mainWindow.show, false, "旅游期间主窗口应隐藏");
    const state = new State({});
    // 病情链首级（咳嗽 health 4），与 determineHealth 走到的 doActive 调用形态一致
    state.doActive({
      type: "ill",
      val: { type: "ill", tolk: "咳咳！咳咳咳！", health: 4 },
      activeOption: w.pet.activeOption,
    });
  } finally {
    spy.restore();
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete global[k];
      else global[k] = prev[k];
    }
  }
  assert.deepEqual(spy.errors, [], "通知链不应抛错");
  assert.equal(w.pet.activeOption.trip, null, "生病应清掉档案里的 trip");
  assert.equal(w.svc.currentTrip, null, "travelService 的内存缓存也应作废");
  assert.equal(
    w.mainWindow.show,
    true,
    "宠物必须回到桌面（否则旅游中生病 = 宠物永久隐藏）"
  );
  assert.ok(
    w.timers.every((t) => t.cleared || t.fired),
    "旅行定时器必须全部清除"
  );
  w.runTimers();
  assert.deepEqual(w.svc.collected, [], "生病中止的旅行不得收集省份");
  assert.equal(w.pet.info.yb, 300, "不得发放元宝奖励");
  assert.equal(w.pet.info.mood, 500, "不得发放心情奖励");
  assert.equal(
    w.speaks.filter((s) => s.includes("旅行取消啦")).length,
    0,
    "silent 调用不应再弹取消气泡（会覆盖生病文案）"
  );
});

// ---- 缺陷 1 加重版：startTravel 不清旧定时器 → 旧计时器结算新行程（秒完成，可循环）----
test("startTravel 先清残留定时器：旧行程的回家定时器不会提前结算新行程", () => {
  const w = makeWorld({ randoms: [0, 0, 0.5, 0.5] });
  const r1 = w.svc.startTravel(); // 北京，8 分钟
  assert.equal(w.timers.length, 2);
  // 生病：只清档案（State.js 的通知链若失效即是此形态），旧定时器仍挂着
  w.pet.activeOption.trip = null;
  const spy = hookConsole();
  let r2;
  try {
    r2 = w.svc.startTravel(); // 病好后立刻再出发，12 分钟
  } finally {
    spy.restore();
  }
  assert.equal(r2.ok, true);
  assert.ok(r2.duration > r1.duration, "两趟行程时长应不同，才能区分是谁结算的");
  const live = w.timers.filter((t) => !t.cleared);
  assert.equal(live.length, 2, "旧 hide/finish 必须已清除，只剩新行程的两个定时器");
  assert.equal(
    live.filter((t) => t.ms === r2.duration).length,
    1,
    "新行程应恰好一个回家定时器"
  );
  assert.equal(
    live.some((t) => t.ms === r1.duration),
    false,
    "旧行程的回家定时器若残留，会在新行程未到点时就结算它（秒完成刷省份与元宝）"
  );
  w.runTimers();
  assert.equal(w.svc.collected.length, 1, "只应结算一次");
  assert.equal(w.pet.info.yb, 315, "元宝只应 +15 一次");
});

// ---- 缺陷 2：remainingMs 无上界钳制（时钟回拨）----
test("init：存档 startTime 晚于当前时间（时钟被回拨）时立即结算，不挂 24 小时定时器", () => {
  const w = makeWorld();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  w.pet.activeOption.trip = {
    place: "云南",
    provinceId: 23,
    startTime: w.now() + ONE_DAY, // 系统时间被回拨一天
    duration: 10 * 60 * 1000,
  };
  const spy = hookConsole();
  let r;
  try {
    r = w.svc.init();
  } finally {
    spy.restore();
  }
  assert.equal(r.resumed, true);
  assert.equal(r.finished, true, "存档时间异常应立即结算，不能让宠物一天不回家");
  assert.deepEqual(w.svc.collected, [23]);
  assert.equal(w.pet.activeOption.trip, null);
  assert.equal(
    w.timers.filter((t) => t.ms > 10 * 60 * 1000).length,
    0,
    "不得挂超过行程总时长的定时器（主窗口会一直隐藏，用户以为程序坏了）"
  );
  assert.ok(
    spy.warns.some((s) => s.includes("[travel]") && s.includes("时钟被回拨")),
    `存档时间异常必须留 warn 日志，实际：${JSON.stringify(spy.warns)}`
  );
});

test("init：存档 duration 被改坏（40 天）时定时器延迟钳在 setTimeout 上限内", () => {
  const w = makeWorld();
  const FORTY_DAYS = 40 * 24 * 60 * 60 * 1000; // > 2^31-1 ms，Node 会坍缩成 1ms 立即触发
  w.pet.activeOption.trip = {
    place: "西藏",
    provinceId: 30,
    startTime: w.now() - 1000,
    duration: FORTY_DAYS,
  };
  const r = w.svc.init();
  assert.equal(r.resumed, true);
  assert.equal(
    r.remainingMs,
    MAX_TIMEOUT_MS,
    "剩余时间应钳到 setTimeout 上限，而不是原样传给 setTimeout"
  );
  assert.equal(
    w.timers.filter((t) => t.ms > MAX_TIMEOUT_MS).length,
    0,
    "不得出现会溢出的延迟（Node 打 TimeoutOverflowWarning 并坍缩成 1ms → 立即白拿奖励）"
  );
  assert.deepEqual(w.svc.collected, [], "行程还没到点，不应结算");
});

// ---- 缺陷 3：主窗口可见性仲裁（旅游 > 感知）----
test("主窗口显隐统一入口：旅游期间拒绝感知的显示请求，且 show 标志与窗口状态同进同退", () => {
  const w = makeWorld({ randoms: [0, 0] });
  w.svc.startTravel();
  w.timers[0].fired = true;
  w.timers[0].fn(); // exit 动画播完 → 隐藏主窗口
  assert.equal(w.mainWindow.show, false, "旅游期间窗口隐藏且 show 标志为 false");

  const spy = hookConsole();
  let granted;
  try {
    granted = w.svc.setMainWindowVisible(true, "感知退出 game 场景");
  } finally {
    spy.restore();
  }
  assert.equal(granted, false, "旅游态优先：旅游期间的显示请求必须被拒绝");
  assert.equal(
    w.winCalls.filter((c) => c === "show").length,
    0,
    "旅游期间不得把宠物放回桌面"
  );
  assert.equal(w.mainWindow.show, false);
  assert.ok(
    spy.warns.some(
      (s) => s.includes("[travel]") && s.includes("旅游期间拒绝显示主窗口")
    ),
    `被仲裁拒绝必须留 warn 日志，实际：${JSON.stringify(spy.warns)}`
  );

  // 召回之后同一请求应放行，并且 show 标志同步更新
  w.svc.cancelTravel();
  const showsAfterCancel = w.winCalls.filter((c) => c === "show").length;
  assert.equal(w.svc.setMainWindowVisible(true, "感知退出 game 场景"), true);
  assert.equal(
    w.winCalls.filter((c) => c === "show").length,
    showsAfterCancel + 1,
    "非旅游期间的显示请求应真正调用 window.show()"
  );
  assert.equal(w.mainWindow.show, true, "显示后必须同时把 show 标志置真");

  // 隐藏路径同样维护标志（原先 aiWiring 直接 window.hide() 不改标志）
  const hidesBefore = w.winCalls.filter((c) => c === "hide").length;
  assert.equal(w.svc.setMainWindowVisible(false, "感知进入 game 场景"), true);
  assert.equal(w.winCalls.filter((c) => c === "hide").length, hidesBefore + 1);
  assert.equal(w.mainWindow.show, false, "隐藏后必须同时把 show 标志置假");
});
