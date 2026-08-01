// 感知循环生命周期回归测试（此前仓库零 start()/stop() 覆盖）。
// 覆盖两个实测到的并发缺陷：
//   ① stop() 后在途的感知结果仍被派发 → 桌宠被 hide 且再无 pet-show（永久隐藏）；
//   ② stop()+start() 让旧 tick 的 finally 又排一条 timer → 定时链叠加、截屏成倍。
// 全部走依赖注入（captureFn / chatFn），不 require 任何三方包、不碰 Electron。
const test = require("node:test");
const assert = require("node:assert");

const {
  PerceptionLoop,
  buildPerceptionResult,
  PERCEPTION_FAILURE_LOG_EVERY,
  PERCEPTION_FAILURE_NOTIFY_THRESHOLD,
} = require("../src/service/perception/loop.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一帧假截屏；每次内容都变，保证 FrameChangeDetector 判定"画面变化"从而触发感知
function fakeFrame(seq) {
  return {
    bitmap: Buffer.alloc(400, (seq * 61) % 255),
    width: 10,
    height: 10,
    pngBuffer: Buffer.from("png"),
  };
}

// 一份能让稳定器切到 game 的感知响应
const GAME_RESPONSE = JSON.stringify({
  scene: "game",
  confidence: 0.95,
  scene_evidence: { game_surface: true, interactive_gameplay: true },
  barrage: "血量见底了",
  observation: "玩家正在操作角色躲避攻击并回血",
});

test("stop() 后在途的感知结果不再派发：不 emit pet-hide、不上屏弹幕、场景不切换", async () => {
  let seq = 0;
  let resolveChat = null;
  const loop = new PerceptionLoop({
    intervalMs: 20,
    captureFn: async () => fakeFrame(++seq),
    chatFn: () => new Promise((resolve) => (resolveChat = resolve)),
  });

  const petHide = [];
  const barrages = [];
  loop.on("pet-hide", () => petHide.push(Date.now()));
  loop._showBarrage = (text) => barrages.push(text);

  loop.start();
  await sleep(60);
  assert.ok(resolveChat, "第一轮感知请求应已发出");
  resolveChat(GAME_RESPONSE); // 第 1 个 game 样本：稳定器 streak=1，还没切场景
  await sleep(60);
  assert.strictEqual(loop.stabilizer.current, "other", "单个样本不应切场景");
  assert.ok(resolveChat, "第二轮感知请求应已发出");

  // 用户此刻在设置页关闭屏幕感知
  loop.stop();
  // 关闭之后云端才把第 2 个 game 样本返回来
  resolveChat(GAME_RESPONSE);
  await sleep(120);

  assert.deepStrictEqual(petHide, [], "感知已停止，不得再 emit pet-hide（否则桌宠被永久隐藏）");
  assert.deepStrictEqual(barrages, [], "感知已停止，不得再上屏弹幕（会重建刚销毁的弹幕窗）");
  assert.strictEqual(loop._petHidden, false, "桌宠不应处于隐藏态");
  assert.strictEqual(loop.stabilizer.current, "other", "过期结果不得改变稳定场景");
  assert.strictEqual(loop.timer, null, "stop() 后不应残留 timer");
});

test("stop()+start() 不叠加定时链：窗口内只有最新运行周期的 tick 在跑", async () => {
  const CHAT_MS = 120; // 模拟"截屏+大模型"远慢于 interval 的真实情况
  const INTERVAL = 40;
  const WINDOW = 600;

  function makeLoop() {
    let seq = 0;
    const counter = { captures: 0 };
    const loop = new PerceptionLoop({
      intervalMs: INTERVAL,
      captureFn: async () => {
        counter.captures += 1;
        return fakeFrame(++seq);
      },
      chatFn: async () => {
        await sleep(CHAT_MS);
        return JSON.stringify({
          scene: "other",
          confidence: 0.3,
          scene_evidence: {},
          observation: "普通桌面操作，没有课程或游戏",
        });
      },
    });
    // 只读观测：start() 把本轮运行周期号（epoch）作为入参传给 _tick，
    // 这里把每次 tick 的 epoch 记下来，用于判定"是否有被作废的旧链还在跑"。
    // 纯测试侧包装（不改生产代码、不改运行时行为）：旧实现下旧链会带着过期 epoch
    // 继续调用 _tick，于是同一观测窗口内会出现两个不同 epoch。
    const tickEpochs = [];
    const originalTick = loop._tick.bind(loop);
    loop._tick = (epoch) => {
      tickEpochs.push(epoch);
      return originalTick(epoch);
    };
    return { loop, counter, tickEpochs };
  }

  // A. 基线：只 start 一次，测量 WINDOW 内的截屏次数
  const a = makeLoop();
  a.loop.start();
  await sleep(150);
  const baseStart = a.counter.captures;
  await sleep(WINDOW);
  const baseline = a.counter.captures - baseStart;
  a.loop.stop();
  assert.ok(baseline > 0, "基线应至少截屏一次");

  // B. 在感知请求进行中关闭再立刻打开（设置页开关的真实操作序列），重复 3 次
  const b = makeLoop();
  for (let i = 0; i < 3; i++) {
    b.loop.start();
    await sleep(60); // 此刻第一轮 tick 正卡在 chatFn 里
    b.loop.stop();
    await sleep(5);
  }
  b.loop.start();
  const liveEpoch = b.loop._epoch; // 最后一次 start() 建立的运行周期（stop() 会再自增，故先存下来）
  await sleep(300); // 留足时间让被作废的在途 tick 走完它的 finally
  const tickMark = b.tickEpochs.length;
  const toggledStart = b.counter.captures;
  await sleep(WINDOW);
  const toggled = b.counter.captures - toggledStart;
  const epochsInWindow = b.tickEpochs.slice(tickMark);

  // 主防线（确定性，不依赖时序比值）：观测窗口内跑过的 tick 必须全部属于最新运行周期。
  // 旧实现下"停止期间在途的 tick"会在重开后又排一条 timer，那条旧链带着过期 epoch
  // 继续 tick，这里就会看到两个 epoch。
  assert.ok(
    epochsInWindow.length > 0,
    "观测窗口内应至少跑过一次 tick，否则断言无意义"
  );
  assert.ok(
    epochsInWindow.every((e) => typeof e === "number"),
    "tick 应携带运行周期号（epoch 机制若被移除，这条会先红）"
  );
  assert.deepStrictEqual(
    [...new Set(epochsInWindow)],
    [liveEpoch],
    `窗口内出现了多个运行周期的 tick（${[...new Set(epochsInWindow)].join(",")}）——` +
      "说明被作废的旧定时链仍在运行，即定时链叠加"
  );

  // 辅助证据（时序比值）：修复前实测基线 4 次/600ms → 切换后 17 次/600ms（约 4~5 倍）。
  // 留 2 倍余量吸收定时器抖动；它不再是唯一防线，只用于兜住"epoch 判定被绕过"的意外情形。
  assert.ok(
    toggled <= baseline * 2,
    `切换后截屏次数（${toggled}）不应显著超过基线（${baseline}）——定时链疑似叠加`
  );

  b.loop.stop();

  // 收尾结构性断言：stop() 后不留 timer、不再截屏
  assert.strictEqual(b.loop.timer, null, "stop() 后不应残留 timer");
  const afterStop = b.counter.captures;
  await sleep(200);
  assert.strictEqual(
    b.counter.captures,
    afterStop,
    "stop() 之后不得再有任何截屏"
  );
});

test("stop() 会中断在途的感知请求（AbortSignal 被 abort）", async () => {
  let seenSignal = null;
  const loop = new PerceptionLoop({
    intervalMs: 20,
    captureFn: async () => fakeFrame(1),
    chatFn: ({ signal }) =>
      new Promise((resolve, reject) => {
        seenSignal = signal;
        if (!signal) return resolve(GAME_RESPONSE);
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
      }),
  });
  const failures = [];
  loop.on("perception-failed", (e) => failures.push(e));

  loop.start();
  await sleep(60);
  assert.ok(seenSignal, "感知请求应带上 AbortSignal");
  assert.strictEqual(seenSignal.aborted, false);

  loop.stop();
  await sleep(60);
  assert.strictEqual(seenSignal.aborted, true, "stop() 应 abort 在途请求");
  assert.strictEqual(loop.inFlight, false, "in-flight 标志应复位");
  assert.deepStrictEqual(
    failures,
    [],
    "由 stop() 主动中断造成的失败不应对外上报 perception-failed"
  );
});

test("免打扰开启时不上屏弹幕（弹幕不走 openSpeak，需自带门禁）", () => {
  const loop = new PerceptionLoop({ intervalMs: 1000 });
  const shown = [];
  const prevGetSys = global.getSys;
  const prevWindow = global.barrageWindow;
  global.barrageWindow = { show: (t) => shown.push(t) };
  try {
    loop.running = true; // 模拟感知运行中

    global.getSys = (key) => ({ doNotDisturb: true }[key]);
    loop._showBarrage("免打扰期间的弹幕");
    assert.deepStrictEqual(shown, [], "免打扰开启时不得上屏弹幕");

    global.getSys = (key) => ({ doNotDisturb: false }[key]);
    loop._showBarrage("正常弹幕");
    assert.deepStrictEqual(shown, ["正常弹幕"], "关闭免打扰后应正常上屏");

    loop.running = false;
    loop._showBarrage("停止后的弹幕");
    assert.deepStrictEqual(shown, ["正常弹幕"], "感知已停止时不得重建/使用弹幕窗");
  } finally {
    if (prevGetSys === undefined) delete global.getSys;
    else global.getSys = prevGetSys;
    if (prevWindow === undefined) delete global.barrageWindow;
    else global.barrageWindow = prevWindow;
  }
});

test("barrage_candidates 里的非字符串元素不会变成 [object Object] 弹幕", () => {
  const result = buildPerceptionResult({
    scene: "game",
    confidence: 0.9,
    scene_evidence: { game_surface: true, interactive_gameplay: true },
    observation: "玩家正在操作角色躲避攻击",
    barrage_candidates: [{ note: "结构不对的候选" }, "血量见底了", { text: "对象里带 text" }, 42],
  });
  assert.ok(
    !result.barrage_candidates.includes("[object Object]"),
    "对象候选不得被 String() 成 [object Object]"
  );
  assert.ok(result.barrage_candidates.includes("血量见底了"), "正常字符串候选应保留");
  assert.ok(
    result.barrage_candidates.includes("对象里带 text"),
    "{text} 形式的候选应取其 text 字段"
  );
});

test("正文字段被模型写成对象时按空值处理，不落 [object Object]", () => {
  const result = buildPerceptionResult({
    scene: "other",
    confidence: 0.9,
    scene_evidence: { ordinary_browsing: true },
    observation: { text: "结构不对的观察" },
    assistant_message: ["也不该是数组"],
  });
  assert.strictEqual(result.observation, "");
  assert.strictEqual(result.assistant_message, "");
});

// —— 感知失败可诊断性回归 ——
// 修复前：失败只经 this.emit("perception-failed") 外传，而全仓无任何生产监听者，
// EventEmitter 对无监听的非 error 事件静默返回 false → 用户开着屏幕感知、每轮截屏、
// 每轮失败，控制台一行日志都没有，且完全无从察觉。

// 轮询等待，避免依赖固定 sleep 时长（退避使失败间隔逐轮翻倍）
async function waitUntil(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`超时未满足条件：${label}`);
}

// 捕获 console.warn / console.error 的真实输出（拼成字符串，e.stack 会原样带进来）
function hookConsole() {
  const warns = [];
  const errors = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => warns.push(args.map((a) => String(a)).join(" "));
  console.error = (...args) => errors.push(args.map((a) => String(a)).join(" "));
  return {
    warns,
    errors,
    ours(list) {
      return list.filter((line) => line.includes("[perception/loop]"));
    },
    restore() {
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

function failingLoop(error, intervalMs = 10) {
  let seq = 0;
  return new PerceptionLoop({
    intervalMs,
    captureFn: async () => fakeFrame(++seq),
    chatFn: async () => {
      throw error();
    },
  });
}

test("未配置视觉提供商时的感知失败会留下 warn 日志并写明降级行为（此前 100% 静默）", async () => {
  const spy = hookConsole();
  const loop = failingLoop(() => new Error("未配置 LLM 提供商"));
  try {
    loop.start();
    await waitUntil(() => loop._failures >= 1, "首轮感知失败");
  } finally {
    loop.stop();
    spy.restore();
  }
  const warns = spy.ours(spy.warns);
  assert.strictEqual(
    warns.length,
    1,
    `失败必须留日志（首次恰好一条），实际：${JSON.stringify(spy.warns)}`
  );
  assert.ok(
    warns[0].includes("未配置 LLM 提供商"),
    `日志必须带上原始错误信息，实际：${warns[0]}`
  );
  assert.ok(
    warns[0].includes("本轮感知跳过") && warns[0].includes("退避后重试"),
    `日志必须写明降级后的行为，实际：${warns[0]}`
  );
  assert.deepStrictEqual(
    spy.ours(spy.errors),
    [],
    "未配置提供商属可预期业务错误，不应记 error"
  );
});

test("意料外的感知异常记 error 且带完整堆栈", async () => {
  const spy = hookConsole();
  const loop = failingLoop(() => new Error("socket hang up"));
  try {
    loop.start();
    await waitUntil(() => loop._failures >= 1, "首轮感知失败");
  } finally {
    loop.stop();
    spy.restore();
  }
  const errors = spy.ours(spy.errors);
  assert.strictEqual(
    errors.length,
    1,
    `意料外异常必须留 error 日志，实际：${JSON.stringify(spy.errors)}`
  );
  assert.ok(
    errors[0].includes("Error: socket hang up"),
    `日志应含错误信息，实际：${errors[0]}`
  );
  assert.ok(
    errors[0].includes("\n    at "),
    `意料外异常必须记完整堆栈（含调用帧），实际：${errors[0]}`
  );
  assert.ok(errors[0].includes("本轮感知跳过"), "日志必须写明降级后的行为");
  assert.deepStrictEqual(
    spy.ours(spy.warns),
    [],
    "意料外异常不应降级成 warn"
  );
});

test("失败日志按固定次数节流，不是每轮都刷屏", () => {
  const loop = new PerceptionLoop({ intervalMs: 1000 });
  const spy = hookConsole();
  const loggedAt = [];
  const rounds = 2 * PERCEPTION_FAILURE_LOG_EVERY + 3;
  try {
    for (let n = 1; n <= rounds; n++) {
      loop._failures = n;
      const before = spy.warns.length + spy.errors.length;
      loop._logFailure(new Error("未配置 LLM 提供商"));
      if (spy.warns.length + spy.errors.length > before) loggedAt.push(n);
    }
  } finally {
    spy.restore();
  }
  assert.deepStrictEqual(
    loggedAt,
    [1, PERCEPTION_FAILURE_LOG_EVERY, 2 * PERCEPTION_FAILURE_LOG_EVERY],
    `${rounds} 轮失败只应在首次与每 ${PERCEPTION_FAILURE_LOG_EVERY} 次各记一条`
  );
});

test("连续失败超阈值时经气泡告知用户恰好一次，不每轮弹", async () => {
  const spy = hookConsole();
  const prevSpeak = global.openSpeak;
  const spoken = [];
  global.openSpeak = (payload) => spoken.push(payload && payload.data && payload.data.data);
  // 模型不支持图片时的 400 —— README 承认的"视觉未单独配置回退到对话服务商"路径
  const loop = failingLoop(() => new Error("openai HTTP 400: image input not supported"));
  try {
    // 未达阈值前不得打扰用户
    loop._failures = PERCEPTION_FAILURE_NOTIFY_THRESHOLD - 1;
    loop._maybeNotifyFailure();
    assert.deepStrictEqual(spoken, [], "未达连续失败阈值不得弹气泡");

    loop.start(); // start() 会把 _failures / _failureNotified 复位
    await waitUntil(
      () => loop._failures >= PERCEPTION_FAILURE_NOTIFY_THRESHOLD + 2,
      "连续失败超过阈值若干轮"
    );
  } finally {
    loop.stop();
    spy.restore();
    if (prevSpeak === undefined) delete global.openSpeak;
    else global.openSpeak = prevSpeak;
  }
  assert.strictEqual(
    spoken.length,
    1,
    `连续失败应恰好告知用户一次，实际 ${spoken.length} 次：${JSON.stringify(spoken)}`
  );
  assert.ok(
    spoken[0].includes("屏幕感知"),
    `气泡文案应指明是屏幕感知失效，实际：${spoken[0]}`
  );
});

test("stop() 造成的中断不计失败、不留日志、不弹气泡（epoch 语义未被日志改动破坏）", async () => {
  const spy = hookConsole();
  const prevSpeak = global.openSpeak;
  const spoken = [];
  global.openSpeak = (payload) => spoken.push(payload);
  let seenSignal = null;
  const loop = new PerceptionLoop({
    intervalMs: 20,
    captureFn: async () => fakeFrame(1),
    chatFn: ({ signal }) =>
      new Promise((resolve, reject) => {
        seenSignal = signal;
        if (!signal) return resolve(GAME_RESPONSE);
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
      }),
  });
  const failures = [];
  loop.on("perception-failed", (e) => failures.push(e));
  try {
    loop.start();
    await waitUntil(() => !!seenSignal, "感知请求应已发出");
    loop.stop();
    await sleep(80); // 让 abort 造成的 reject 走完 catch/finally
  } finally {
    spy.restore();
    if (prevSpeak === undefined) delete global.openSpeak;
    else global.openSpeak = prevSpeak;
  }
  assert.strictEqual(seenSignal.aborted, true, "stop() 应 abort 在途请求");
  assert.strictEqual(
    loop._failures,
    0,
    "stop() 造成的失败不得计入 _failures（否则会污染下一个运行周期的退避）"
  );
  assert.deepStrictEqual(failures, [], "stop() 造成的失败不应上报 perception-failed");
  assert.deepStrictEqual(spy.ours(spy.warns), [], "stop() 造成的中断不应记 warn");
  assert.deepStrictEqual(spy.ours(spy.errors), [], "stop() 造成的中断不应记 error");
  assert.deepStrictEqual(spoken, [], "stop() 造成的中断不应弹故障气泡");
});

test("稳定切换到 game 场景时会 emit pet-hide（此前仅有负向断言，删掉这行 emit 也全绿）", async () => {
  let seq = 0;
  const loop = new PerceptionLoop({
    intervalMs: 10,
    captureFn: async () => fakeFrame(++seq),
    chatFn: async () => GAME_RESPONSE,
  });
  const petHide = [];
  const petShow = [];
  loop.on("pet-hide", (p) => petHide.push(p));
  loop.on("pet-show", (p) => petShow.push(p));
  loop._showBarrage = () => {};
  try {
    loop.start();
    await waitUntil(
      () => loop.stabilizer.current === "game",
      "连续两个 game 样本后稳定器应切到 game"
    );
    await waitUntil(() => petHide.length > 0, "切到 game 应 emit pet-hide");
  } finally {
    loop.stop();
  }
  assert.strictEqual(petHide.length, 1, "进入 game 只应 emit 一次 pet-hide");
  assert.deepStrictEqual(petHide[0], { scene: "game" }, "pet-hide 应携带目标场景");
  assert.deepStrictEqual(
    petShow,
    [{ scene: "game" }],
    "stop() 收尾必须补一次 pet-show，否则桌宠永久隐藏"
  );
  assert.strictEqual(loop._petHidden, false, "stop() 后隐藏态应已复位");
});
