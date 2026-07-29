/**
 * ruffleBridge 单元测试（node --test，纯 node，无需 Electron）
 *
 * 覆盖 P0 bug「关闭桌宠必卡 30 秒」的核心契约：
 *   1. 纯逻辑：单帧时长 / 动画时长 / 虚拟帧推进 / finish 判定点
 *   2. 虚拟帧序列必须**逐帧不跳号**地走完 0..numFrames-1，
 *      否则 swfPet.js 里 `总帧 == 当前帧 + cut + 1` 的等值判定会被跨过 → finish 永不触发
 *   3. 真实素材参数（Exit1.swf 91 帧 @12fps）下 finish 判定点会在动画时长内出现，
 *      远早于 main/main.js 的 30s 硬兜底
 *   4. metadata 拿不到时走兜底虚拟时间轴，finish 仍触发，且只告警一次
 *   5. 暂停时虚拟时间轴不推进；异常/缺失 API 一次性告警而非静默吞
 *
 * 运行：cd qq_local && node --test test/ruffleBridge.test.js
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  RuffleBridge,
  frameIntervalMs,
  animationDurationMs,
  nextVirtualFrame,
  isFinishFrame,
} = require("../src/windows/util/pet/ruffleBridge.js");

/** 24fps 轮询间隔（swfPet.js 的 defaultSystem.interval = 1000/24） */
const SAMPLE_INTERVAL_MS = 1000 / 24;

/** 可控时钟：手动推进，测试不依赖真实时间 */
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    tick: (ms) => {
      t += ms;
      return t;
    },
  };
}

/** 记录调用的假日志器 */
function makeLogger() {
  const warns = [];
  const errors = [];
  return { warn: (...a) => warns.push(a), error: (...a) => errors.push(a), warns, errors };
}

/** 假 Ruffle 元素：只实现桥用到的 API 面 */
function makeFakeDom(opt = {}) {
  return {
    metadata: opt.metadata === undefined ? null : opt.metadata,
    isPlaying: opt.isPlaying === undefined ? true : opt.isPlaying,
    PercentLoaded() {
      return this.metadata ? 100 : 0;
    },
    addEventListener() {},
    play() {
      this.isPlaying = true;
    },
    pause() {
      this.isPlaying = false;
    },
    reload() {
      this.reloaded = (this.reloaded || 0) + 1;
    },
  };
}

/**
 * 用 24fps 轮询驱动桥，收集每次采样的状态。
 * @returns {{frames:number[], states:object[], finishAtMs:(number|null)}}
 */
function pollBridge(bridge, clock, { steps, lastTimeCut = 1 }) {
  const frames = [];
  const states = [];
  let finishAtMs = null;
  for (let i = 0; i < steps; i++) {
    clock.tick(SAMPLE_INTERVAL_MS);
    const st = bridge.getState();
    frames.push(st.currentFrame);
    states.push(st);
    // 复刻 swfPet.js setState 的 finish 判定（a=frame 总帧，e=currentFrame）
    if (finishAtMs === null && st.frame === st.currentFrame + lastTimeCut + 1) {
      finishAtMs = clock.now();
    }
  }
  return { frames, states, finishAtMs };
}

test("frameIntervalMs：正常帧率按 1000/fps，非法帧率回落到 12fps", () => {
  assert.ok(Math.abs(frameIntervalMs(12) - 1000 / 12) < 1e-9);
  assert.ok(Math.abs(frameIntervalMs(24) - 1000 / 24) < 1e-9);
  for (const bad of [0, -5, null, undefined, NaN, "abc"]) {
    assert.ok(
      Math.abs(frameIntervalMs(bad) - 1000 / RuffleBridge.DEFAULT_FRAME_RATE) < 1e-9,
      `非法帧率 ${bad} 未回落到默认值`
    );
  }
});

test("animationDurationMs：按 totalFrames/frameRate 算动画时长", () => {
  // 真实素材：Adult/Exit1.swf = 91 帧 @12fps
  assert.ok(Math.abs(animationDurationMs(91, 12) - (91 * 1000) / 12) < 1e-6);
  assert.strictEqual(animationDurationMs(0, 12), 0);
  assert.strictEqual(animationDurationMs(-3, 12), 0);
  assert.strictEqual(animationDurationMs(null, 12), 0);
});

test("isFinishFrame：与 swfPet.js 的 `总帧 == 当前帧 + cut + 1` 等价", () => {
  // 91 帧、cut=1 → 判定点为 currentFrame 89（0 基倒数第二帧）
  assert.strictEqual(isFinishFrame({ numFrames: 91, currentFrame: 89, lastTimeCut: 1 }), true);
  assert.strictEqual(isFinishFrame({ numFrames: 91, currentFrame: 90, lastTimeCut: 1 }), false);
  assert.strictEqual(isFinishFrame({ numFrames: 91, currentFrame: 88, lastTimeCut: 1 }), false);
  // cut 缺省视为 1
  assert.strictEqual(isFinishFrame({ numFrames: 91, currentFrame: 89 }), true);
  // bury: lastTimeCut=5 → 判定点 84
  assert.strictEqual(isFinishFrame({ numFrames: 90, currentFrame: 84, lastTimeCut: 5 }), true);
  // 单帧素材（Stand.swf/Die.swf）不存在 finish 判定点
  assert.strictEqual(isFinishFrame({ numFrames: 1, currentFrame: 0, lastTimeCut: 1 }), false);
});

test("nextVirtualFrame：0 基循环；中段可追赶，尾段逐帧不跳号", () => {
  assert.strictEqual(nextVirtualFrame({ playedMs: 0, numFrames: 91, frameRate: 12, lastFrame: -1 }), 0);
  assert.strictEqual(nextVirtualFrame({ playedMs: 0, numFrames: 91, frameRate: 12, lastFrame: 0 }), 0);
  // 已播放 1 帧时长 → 推进到 1
  assert.strictEqual(nextVirtualFrame({ playedMs: 1000 / 12, numFrames: 91, frameRate: 12, lastFrame: 0 }), 1);
  // 中段追赶：采样被拖慢时直接跳到时间对应帧（中段帧号不参与等值判定）
  assert.strictEqual(nextVirtualFrame({ playedMs: 2000, numFrames: 91, frameRate: 12, lastFrame: 0 }), 24);
  // 时间已进入尾段 → 落到尾段起点（91-8=83），随后逐帧走
  const tailStart = 91 - RuffleBridge.TAIL_FORCE_FRAMES;
  assert.strictEqual(nextVirtualFrame({ playedMs: 7000, numFrames: 91, frameRate: 12, lastFrame: 10 }), tailStart);
  // 尾段内：每次最多 +1
  assert.strictEqual(nextVirtualFrame({ playedMs: 100000, numFrames: 91, frameRate: 12, lastFrame: tailStart }), tailStart + 1);
  // 末帧后回卷到 0
  assert.strictEqual(nextVirtualFrame({ playedMs: 100000, numFrames: 91, frameRate: 12, lastFrame: 90 }), 0);
  // 单帧素材恒为 0
  assert.strictEqual(nextVirtualFrame({ playedMs: 5000, numFrames: 1, frameRate: 12, lastFrame: 0 }), 0);
  for (const bad of [0, -1, null, undefined, NaN]) {
    assert.strictEqual(nextVirtualFrame({ playedMs: 100, numFrames: bad, frameRate: 12, lastFrame: 0 }), 0);
  }
});

test("metadata 就绪前报告中性状态：不会被 setState 误判为播完", () => {
  const clock = makeClock();
  const logger = makeLogger();
  const bridge = new RuffleBridge({ now: clock.now, logger });
  bridge.setDom(makeFakeDom({ metadata: null }));
  // 采样若干次（仍在 metadata 等待窗口内）
  const { states } = pollBridge(bridge, clock, { steps: 10 });
  for (const st of states) {
    assert.strictEqual(st.frame, 0);
    assert.strictEqual(st.currentFrame, 0);
    // 三条帧驱动分支在中性状态下必须全为 false
    assert.strictEqual(st.frame === st.currentFrame + 1, false, "被误判为播完(a==e+t)");
    assert.strictEqual(st.frame !== 1 && st.currentFrame + 1 < st.frame, false, "被误判为提前停住");
    assert.strictEqual(st.frame === st.currentFrame + 2, false, "被误判为 finish");
  }
});

test("P0：91 帧@12fps（真实 Exit1.swf 参数）尾段逐帧不跳号，finish 判定点在动画时长内出现", () => {
  const NUM_FRAMES = 91;
  const FRAME_RATE = 12;
  const clock = makeClock();
  const logger = makeLogger();
  const bridge = new RuffleBridge({ now: clock.now, logger });
  bridge.setDom(makeFakeDom({ metadata: { numFrames: NUM_FRAMES, frameRate: FRAME_RATE } }));

  const durationMs = animationDurationMs(NUM_FRAMES, FRAME_RATE);
  const steps = Math.ceil(durationMs / SAMPLE_INTERVAL_MS) + 30;
  const { frames, finishAtMs } = pollBridge(bridge, clock, { steps });

  // 总帧数如实上报
  assert.strictEqual(bridge.totalFrames(), NUM_FRAMES);
  // 帧号单调（同帧/+1/回卷），中段允许追赶但不许倒退
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const cur = frames[i];
    assert.ok(cur >= prev || cur === 0, `第 ${i} 次采样帧号倒退：${prev} -> ${cur}`);
  }
  // 尾段（最后 TAIL_FORCE_FRAMES 帧）每一帧都必须被观测到，且尾段内不跳号
  const tailStart = NUM_FRAMES - RuffleBridge.TAIL_FORCE_FRAMES;
  const seen = new Set(frames);
  for (let f = tailStart; f < NUM_FRAMES; f++) assert.ok(seen.has(f), `尾段帧 ${f} 从未被观测到`);
  // finish 判定点确实出现，且时间接近动画时长（不是 30s 兜底）
  assert.ok(finishAtMs !== null, "finish 判定点从未出现 —— P0 bug 未修复");
  assert.ok(finishAtMs <= durationMs + SAMPLE_INTERVAL_MS * 3, `finish 触发过晚：${finishAtMs}ms`);
  assert.ok(finishAtMs < 30000, `finish 晚于 30s 兜底：${finishAtMs}ms`);
  assert.strictEqual(bridge.isFallbackTimeline(), false, "不该走兜底时间轴");
  assert.strictEqual(logger.errors.length, 0, "正常路径不该报错");
});

test("P0 最坏情况：采样被降到 1fps（窗口隐藏时 rAF 被节流）仍能在 30s 内触发 finish", () => {
  const NUM_FRAMES = 91;
  const FRAME_RATE = 12;
  const STARVED_INTERVAL_MS = 1000; // 实测隐藏窗口下 rAF ≈ 1fps
  const clock = makeClock();
  const bridge = new RuffleBridge({ now: clock.now, logger: makeLogger() });
  bridge.setDom(makeFakeDom({ metadata: { numFrames: NUM_FRAMES, frameRate: FRAME_RATE } }));

  let finishAtMs = null;
  const frames = [];
  for (let i = 0; i < 40 && finishAtMs === null; i++) {
    clock.tick(STARVED_INTERVAL_MS);
    const st = bridge.getState();
    frames.push(st.currentFrame);
    if (st.frame === st.currentFrame + 1 + 1) finishAtMs = clock.now();
  }
  assert.ok(finishAtMs !== null, "1fps 采样下 finish 判定点从未出现");
  assert.ok(finishAtMs < 30000, `1fps 采样下 finish 晚于 30s 兜底：${finishAtMs}ms`);
});

test("素材帧率高于 24fps 采样率时尾段仍不跳号（finish 只会晚不会漏）", () => {
  const NUM_FRAMES = 40;
  const clock = makeClock();
  const bridge = new RuffleBridge({ now: clock.now, logger: makeLogger() });
  bridge.setDom(makeFakeDom({ metadata: { numFrames: NUM_FRAMES, frameRate: 60 } }));
  const { frames, finishAtMs } = pollBridge(bridge, clock, { steps: NUM_FRAMES + 20 });
  const tailStart = NUM_FRAMES - RuffleBridge.TAIL_FORCE_FRAMES;
  const seen = new Set(frames);
  for (let f = tailStart; f < NUM_FRAMES; f++) assert.ok(seen.has(f), `尾段帧 ${f} 从未被观测到`);
  assert.ok(finishAtMs !== null, "高帧率素材下 finish 判定点从未出现");
});

test("兜底路径：metadata 一直拿不到时启用兜底时间轴，finish 仍触发且只告警一次", () => {
  const clock = makeClock();
  const logger = makeLogger();
  const bridge = new RuffleBridge({ now: clock.now, logger, metadataTimeoutMs: 2000 });
  bridge.setDom(makeFakeDom({ metadata: null }));

  const { finishAtMs } = pollBridge(bridge, clock, { steps: 400 });
  assert.strictEqual(bridge.isFallbackTimeline(), true, "未启用兜底时间轴");
  assert.strictEqual(bridge.totalFrames(), RuffleBridge.FALLBACK_NUM_FRAMES);
  assert.ok(finishAtMs !== null, "兜底时间轴下 finish 判定点从未出现");
  // 2s 等待 + 兜底动画时长，必须远早于 30s 硬兜底
  assert.ok(finishAtMs < 10000, `兜底路径 finish 过晚：${finishAtMs}ms`);
  // 一次性告警：不能 24fps 刷屏
  const fallbackWarns = logger.warns.filter((a) => a.join(" ").includes("兜底虚拟时间轴"));
  assert.strictEqual(fallbackWarns.length, 1, `兜底告警次数应为 1，实为 ${fallbackWarns.length}`);
});

test("metadata 迟到（渲染层被节流）：兜底时间轴就地切回真实帧数，只告警一次", () => {
  const clock = makeClock();
  const logger = makeLogger();
  const dom = makeFakeDom({ metadata: null });
  const bridge = new RuffleBridge({ now: clock.now, logger, metadataTimeoutMs: 2000 });
  bridge.setDom(dom);
  // 先跑到兜底时间轴
  pollBridge(bridge, clock, { steps: 60 });
  assert.strictEqual(bridge.isFallbackTimeline(), true, "未进入兜底时间轴");
  // metadata 迟到
  dom.metadata = { numFrames: 91, frameRate: 12 };
  pollBridge(bridge, clock, { steps: 5 });
  assert.strictEqual(bridge.isFallbackTimeline(), false, "metadata 迟到后未切回真实时间轴");
  assert.strictEqual(bridge.totalFrames(), 91);
  assert.ok(bridge.currentFrame() >= 0 && bridge.currentFrame() < 91, "切换后帧号越界");
  const upgradeWarns = logger.warns.filter((a) => a.join(" ").includes("切回真实参数"));
  assert.strictEqual(upgradeWarns.length, 1, `切回告警次数应为 1，实为 ${upgradeWarns.length}`);
  // 切回后仍能走到 finish 判定点
  let finishSeen = false;
  for (let i = 0; i < 300 && !finishSeen; i++) {
    clock.tick(SAMPLE_INTERVAL_MS);
    const st = bridge.getState();
    if (st.frame === st.currentFrame + 2) finishSeen = true;
  }
  assert.ok(finishSeen, "切回真实时间轴后 finish 判定点丢失");
});

test("暂停时虚拟时间轴不推进，恢复播放后继续", () => {
  const clock = makeClock();
  const dom = makeFakeDom({ metadata: { numFrames: 50, frameRate: 12 }, isPlaying: true });
  const bridge = new RuffleBridge({ now: clock.now, logger: makeLogger() });
  bridge.setDom(dom);
  pollBridge(bridge, clock, { steps: 10 });
  const frameBeforePause = bridge.currentFrame();
  assert.ok(frameBeforePause > 0, "播放中虚拟帧未推进");

  dom.isPlaying = false;
  pollBridge(bridge, clock, { steps: 30 });
  assert.strictEqual(bridge.currentFrame(), frameBeforePause, "暂停期间虚拟帧仍在推进");
  assert.strictEqual(bridge.isPlaying(), false);

  dom.isPlaying = true;
  pollBridge(bridge, clock, { steps: 10 });
  assert.ok(bridge.currentFrame() > frameBeforePause, "恢复播放后虚拟帧未继续推进");
});

test("单次采样间隔过长（休眠唤醒）时时间轴受限，只落到尾段起点而不越过判定帧", () => {
  const NUM_FRAMES = 91;
  const clock = makeClock();
  const bridge = new RuffleBridge({ now: clock.now, logger: makeLogger() });
  bridge.setDom(makeFakeDom({ metadata: { numFrames: NUM_FRAMES, frameRate: 12 } }));
  clock.tick(SAMPLE_INTERVAL_MS);
  bridge.getState();
  clock.tick(60 * 60 * 1000); // 模拟休眠 1 小时
  bridge.getState();
  const tailStart = NUM_FRAMES - RuffleBridge.TAIL_FORCE_FRAMES;
  // 单次采样最多计入 MAX_SAMPLE_GAP_MS，且最坏也只是落到尾段起点，判定帧仍在后面逐帧走
  assert.ok(bridge.currentFrame() <= tailStart, `休眠唤醒后越过尾段起点：${bridge.currentFrame()}`);
  // 继续采样必须能走到 finish 判定点（虚拟时间轴按真实节奏继续走完剩余动画）
  let finishSeen = false;
  for (let i = 0; i < 300 && !finishSeen; i++) {
    clock.tick(SAMPLE_INTERVAL_MS);
    const st = bridge.getState();
    if (st.frame === st.currentFrame + 2) finishSeen = true;
  }
  assert.ok(finishSeen, "休眠唤醒后 finish 判定点丢失");
});

test("API 缺失/异常：一次性告警，不静默吞、不抛出", () => {
  const logger = makeLogger();
  RuffleBridge.setLogger(logger);

  // 跳帧无等价能力：只告警一次，返回 false
  for (let i = 0; i < 100; i++) assert.strictEqual(RuffleBridge.gotoFrame({}, 66), false);
  const gotoWarns = logger.warns.filter((a) => a.join(" ").includes("不支持跳帧"));
  assert.strictEqual(gotoWarns.length, 1, `跳帧告警次数应为 1，实为 ${gotoWarns.length}`);

  // play/pause/rewind 命中真实 Ruffle API
  const dom = makeFakeDom({ metadata: { numFrames: 10, frameRate: 12 }, isPlaying: false });
  assert.strictEqual(RuffleBridge.play(dom), true);
  assert.strictEqual(RuffleBridge.isPlaying(dom), true);
  assert.strictEqual(RuffleBridge.pause(dom), true);
  assert.strictEqual(RuffleBridge.isPlaying(dom), false);
  assert.strictEqual(RuffleBridge.rewind(dom), true);
  assert.strictEqual(dom.reloaded, 1);

  // API 不存在：返回 false 并告警，绝不抛
  assert.strictEqual(RuffleBridge.play({}), false);
  assert.strictEqual(RuffleBridge.pause({}), false);
  assert.strictEqual(RuffleBridge.rewind({}), false);
  assert.ok(logger.warns.length >= 4, "API 缺失未产生告警");

  RuffleBridge.setLogger(null);
});

test("metadata getter 抛异常时不静默吞：报错一次并走兜底时间轴", () => {
  const clock = makeClock();
  const logger = makeLogger();
  const dom = makeFakeDom();
  Object.defineProperty(dom, "metadata", {
    get() {
      throw new Error("boom");
    },
  });
  const bridge = new RuffleBridge({ now: clock.now, logger, metadataTimeoutMs: 500 });
  bridge.setDom(dom);
  const { finishAtMs } = pollBridge(bridge, clock, { steps: 200 });
  assert.ok(logger.errors.length >= 1, "metadata 读取异常被静默吞");
  const metaErrors = logger.errors.filter((a) => a.join(" ").includes("读取 Ruffle metadata 失败"));
  assert.strictEqual(metaErrors.length, 1, `metadata 异常告警次数应为 1，实为 ${metaErrors.length}`);
  assert.strictEqual(bridge.isFallbackTimeline(), true);
  assert.ok(finishAtMs !== null, "异常路径下 finish 判定点从未出现");
});

test("换 SWF（setDom）重置虚拟时间轴，新动画从第 0 帧重新计时", () => {
  const clock = makeClock();
  const bridge = new RuffleBridge({ now: clock.now, logger: makeLogger() });
  bridge.setDom(makeFakeDom({ metadata: { numFrames: 50, frameRate: 12 } }));
  pollBridge(bridge, clock, { steps: 20 });
  assert.ok(bridge.currentFrame() > 0);
  bridge.setDom(makeFakeDom({ metadata: { numFrames: 91, frameRate: 12 } }));
  assert.strictEqual(bridge.currentFrame(), 0, "setDom 后未重置当前帧");
  clock.tick(SAMPLE_INTERVAL_MS);
  const st = bridge.getState();
  assert.strictEqual(st.frame, 91, "setDom 后总帧数未更新");
  assert.strictEqual(st.currentFrame, 0);
});

test("dom 为空时返回中性状态，不抛异常", () => {
  const bridge = new RuffleBridge({ now: makeClock().now, logger: makeLogger() });
  bridge.setDom(null);
  const st = bridge.getState();
  assert.deepStrictEqual(st, { frame: 0, currentFrame: 0, isPlaying: false, percentLoaded: 0 });
});
