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

test("stop()+start() 不叠加定时链：切换后截屏频率不超过单链基线", async () => {
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
    return { loop, counter };
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
  await sleep(300); // 留足时间让被作废的在途 tick 走完它的 finally
  const toggledStart = b.counter.captures;
  await sleep(WINDOW);
  const toggled = b.counter.captures - toggledStart;
  b.loop.stop();

  // 修复前实测：基线 3 次/秒 → 切换后 17 次/秒（约 5~6 倍）。
  // 这里留 2 倍余量吸收定时器抖动，仍能稳定抓住"叠加定时链"的回归。
  assert.ok(
    toggled <= baseline * 2,
    `切换后截屏次数（${toggled}）不应显著超过基线（${baseline}）——定时链疑似叠加`
  );

  // 结构性断言：只应有一条链，即"停止期间在途的 tick"不再排下一次
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
