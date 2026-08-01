// aiWiring.js 桥接回归测试：
//   感知 "activity" 事件 → memoryService.handlePerceptionActivity 必须转发 course_title
//   （perception/loop.js 发出的 payload 含 course_title，memory/activity.js 在 course 场景
//    observation 为空时靠它兜底"正在学习课程：{title}"）；
//   非 course 场景 → courseManager.handleNonCourse 计数。
const test = require("node:test");
const assert = require("node:assert/strict");

const { perceptionLoop } = require("../src/service/perception/index.js");

// 在 require aiWiring 之前装好全局桩（其 wireKeyframeCapture 等引导逻辑依赖这些全局）
const activities = [];
const nonCourseCalls = [];
global.memoryService = {
  handlePerceptionActivity: (p) => activities.push(p),
};
global.courseManager = {
  handleNonCourse: () => nonCourseCalls.push(Date.now()),
  handleCoursePerception: () => {},
  on: () => {},
  currentSession: null,
};

const aiWiring = require("../src/service/aiWiring.js");
// 模块加载时会自己起一条真实的 2s 引导轮询。本文件用注入的手动时钟驱动引导逻辑，
// 先把这条真表停掉，避免它在测试中途 tick 到，污染下面的桩与计数。
clearInterval(aiWiring.bootTimer);

// 手动时钟：只实现 setInterval/clearInterval 两个 aiWiring 用到的能力。
// 用它替掉真实定时器，既去掉套件里 2.3s 的真实等待，也让"第几次 tick 放弃"可精确断言。
const makeClock = () => {
  const timers = new Map();
  let nextId = 1;
  return {
    setIntervalFn: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearIntervalFn: (id) => timers.delete(id),
    tick(times = 1) {
      for (let i = 0; i < times; i++) {
        for (const [, fn] of [...timers]) fn();
      }
    },
    get pendingCount() {
      return timers.size;
    },
  };
};

// 统一收集 console.error，并在结束后还原
const captureErrors = () => {
  const calls = [];
  const orig = console.error;
  console.error = (...args) => calls.push(args);
  return { calls, restore: () => (console.error = orig) };
};

// boot() 里 startPerception() 会 require 弹幕窗口（Electron 依赖），桩掉 Module._load
const stubBarrage = () => {
  const Module = require("node:module");
  const origLoad = Module._load;
  const state = { ensured: 0 };
  Module._load = function (request, ...rest) {
    if (request.includes("barrage")) return { ensure: () => state.ensured++ };
    return origLoad.apply(this, [request, ...rest]);
  };
  state.restore = () => (Module._load = origLoad);
  return state;
};

test("activity 桥接：course_title 被转发给记忆系统", () => {
  perceptionLoop.emit("activity", {
    scene: "course",
    confidence: 0.9,
    text: "",
    course_title: "高等数学 第3讲",
    timestamp: "2026-07-29T10:00:00.000Z",
  });
  assert.equal(activities.length, 1);
  assert.deepEqual(activities[0], {
    scene: "course",
    confidence: 0.9,
    observation: "",
    course_title: "高等数学 第3讲",
    timestamp: "2026-07-29T10:00:00.000Z",
  });
  // course 场景不计入非课程退出判定
  assert.equal(nonCourseCalls.length, 0);
});

test("activity 桥接：非 course 场景喂给课程自动退出判定", () => {
  perceptionLoop.emit("activity", {
    scene: "other",
    confidence: 0.8,
    text: "主人在浏览网页",
    timestamp: "2026-07-29T10:01:00.000Z",
  });
  assert.equal(activities.length, 2);
  assert.equal(activities[1].course_title, undefined); // 无标题时字段存在但为空
  assert.equal(nonCourseCalls.length, 1);
});

test("sys 未就绪时启动引导绝不写 sys（回归：默认设置整体覆盖用户存档、API Key 丢失）", () => {
  const setSysCalls = [];
  const log = captureErrors();
  delete global.__sysReady;
  // 模拟未就绪：内存里还是 pet.js 的默认字面量，barrageEnabled 这个键根本不存在
  global.getSys = () => undefined;
  global.setSys = (arg) => setSysCalls.push(arg);
  try {
    const result = aiWiring.boot();
    assert.equal(result, false, "未就绪时 boot 必须拒绝执行");
    assert.deepEqual(setSysCalls, [], "未就绪时一次 setSys 都不许发生");
    assert.equal(log.calls.length, 1, "拒绝执行必须留下线索，不能静默返回");
    assert.match(String(log.calls[0][0]), /^\[aiWiring\] /);
    assert.match(String(log.calls[0][0]), /未就绪/);
  } finally {
    log.restore();
    delete global.getSys;
    delete global.setSys;
  }
});

test("只有 sys 就绪标志置上后才执行启动引导（默认值落盘 + 感知自启）", () => {
  const clock = makeClock();
  const barrage = stubBarrage();
  const log = captureErrors();
  const setSysCalls = [];
  const started = [];
  const origStart = perceptionLoop.start;
  perceptionLoop.start = () => started.push(1);
  delete global.__sysReady;
  global.getSys = (key) => ({ perceptionEnabled: true })[key]; // barrageEnabled 未设置
  global.setSys = (arg) => setSysCalls.push(arg);
  try {
    aiWiring.startBootWatcher(clock);

    clock.tick(3); // 标志未置：连续 3 轮都不许动
    assert.deepEqual(setSysCalls, [], "未就绪期间不得写盘");
    assert.equal(started.length, 0, "未就绪期间不得启动感知");
    assert.equal(clock.pendingCount, 1, "未就绪时应继续等待，表不能停");

    global.__sysReady = true;
    clock.tick(1);
    assert.deepEqual(setSysCalls, [{ name: "barrageEnabled", value: true }]);
    assert.equal(started.length, 1, "就绪后应自启感知");
    assert.equal(barrage.ensured, 1, "应初始化弹幕覆盖层窗口");
    assert.equal(clock.pendingCount, 0, "引导执行后必须停表");

    clock.tick(3);
    assert.equal(started.length, 1, "引导只跑一次，不得重复启动感知");
  } finally {
    log.restore();
    barrage.restore();
    perceptionLoop.start = origStart;
    delete global.__sysReady;
    delete global.getSys;
    delete global.setSys;
  }
});

test("启动引导抛错时记录带堆栈的 error，不静默失效（回归：空体 catch 吞掉窗口创建异常）", () => {
  const clock = makeClock();
  const log = captureErrors();
  global.__sysReady = true;
  global.getSys = () => {
    throw new Error("弹幕 BrowserWindow 创建失败");
  };
  global.setSys = () => {};
  try {
    aiWiring.startBootWatcher(clock);
    clock.tick(1);
    assert.equal(log.calls.length, 1, "抛错必须记一条 error，不能被吞掉");
    assert.match(String(log.calls[0][0]), /^\[aiWiring\] /);
    const detail = String(log.calls[0][1]);
    assert.match(detail, /弹幕 BrowserWindow 创建失败/);
    assert.match(detail, /\n\s+at /, "必须带调用堆栈，否则定位不到抛出点");
    assert.equal(clock.pendingCount, 0);
  } finally {
    log.restore();
    delete global.__sysReady;
    delete global.getSys;
    delete global.setSys;
  }
});

test("等不到 sys 就绪时放弃轮询并记 error，不无限空转", () => {
  const clock = makeClock();
  const log = captureErrors();
  const setSysCalls = [];
  delete global.__sysReady;
  global.getSys = () => undefined;
  global.setSys = (arg) => setSysCalls.push(arg);
  try {
    aiWiring.startBootWatcher(clock);

    clock.tick(aiWiring.SYS_READY_MAX_ATTEMPTS - 1);
    assert.equal(log.calls.length, 0, "未到上限前不应提前放弃");
    assert.equal(clock.pendingCount, 1);

    clock.tick(1); // 第 SYS_READY_MAX_ATTEMPTS 次
    assert.equal(clock.pendingCount, 0, "达到上限必须停表，不能无限轮询");
    assert.equal(log.calls.length, 1);
    const msg = String(log.calls[0][0]);
    assert.match(msg, /^\[aiWiring\] /);
    assert.ok(
      msg.includes(
        String(aiWiring.SYS_READY_MAX_ATTEMPTS * aiWiring.SYS_READY_POLL_MS)
      ),
      "错误信息应说明等了多久"
    );
    assert.match(msg, /放弃/);

    clock.tick(5);
    assert.equal(log.calls.length, 1, "停表后不得继续刷日志");
    assert.deepEqual(setSysCalls, [], "放弃路径全程不得写 sys");
  } finally {
    log.restore();
    delete global.getSys;
    delete global.setSys;
  }
});
