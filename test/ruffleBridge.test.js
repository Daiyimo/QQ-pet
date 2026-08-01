/**
 * ruffleBridge 单元测试（node --test，纯 node，无需 Electron）
 *
 * 覆盖 P0 bug「关闭桌宠必卡满硬兜底才被强杀」的核心契约：
 *   1. 纯逻辑：单帧时长 / 动画时长 / 虚拟帧推进 / finish 判定点
 *   2. 虚拟帧序列必须**逐帧不跳号**地走完尾段，
 *      否则 swfPet.js 里 `总帧 == 当前帧 + cut + 1` 的等值判定会被跨过 → finish 永不触发
 *   3. **不变量**：finish 判定点必须在 RuffleBridge.EXIT_FINISH_DEADLINE_MS 之前出现，
 *      且该结论与素材帧数无关（8/24/91/100/150/300/600 帧参数化验证）——
 *      生产硬兜底 EXIT_FALLBACK_MS 与 main/main.js 由本文件的跨引用断言钉死
 *   4. metadata 拿不到时走兜底虚拟时间轴，finish 仍触发，且只告警一次
 *   5. 暂停时虚拟时间轴不推进；异常/缺失 API 一次性告警而非静默吞
 *
 * 运行：cd qq_local && node --test test/ruffleBridge.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const {
  RuffleBridge,
  frameIntervalMs,
  animationDurationMs,
  nextVirtualFrame,
  isFinishFrame,
  tailWalkBudgetMs,
  midSectionDeadlineMs,
  EXIT_FALLBACK_MS,
  EXIT_FINISH_DEADLINE_MS,
  EXIT_FINISH_SAFETY_MARGIN_MS,
} = require("../src/windows/util/pet/ruffleBridge.js");

/** 24fps 轮询间隔（swfPet.js 的 defaultSystem.interval = 1000/24，模块内为 POLL_INTERVAL_MS） */
const SAMPLE_INTERVAL_MS = RuffleBridge.POLL_INTERVAL_MS;
assert.ok(Math.abs(SAMPLE_INTERVAL_MS - 1000 / 24) < 1e-9, "轮询间隔常量应为 1000/24");

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
function pollBridge(bridge, clock, { steps, lastTimeCut = 1, intervalMs = SAMPLE_INTERVAL_MS }) {
  const frames = [];
  const states = [];
  let finishAtMs = null;
  for (let i = 0; i < steps; i++) {
    clock.tick(intervalMs);
    const st = bridge.getState();
    frames.push(st.currentFrame);
    states.push(st);
    // 走 ruffleBridge 导出的 isFinishFrame（它与 swfPet.js 的判定式等价，由下面的源码断言钉住）
    if (finishAtMs === null && isFinishFrame({ numFrames: st.frame, currentFrame: st.currentFrame, lastTimeCut })) {
      finishAtMs = clock.now();
    }
  }
  return { frames, states, finishAtMs };
}

// ---------- 单一真值：生产硬兜底与本模块常量的跨引用断言 ----------

test("跨引用：main/main.js 的退出硬兜底字面量与 RuffleBridge.EXIT_FALLBACK_MS 一致", () => {
  // main/main.js 是 webpack 压缩单行产物，无法 require 主进程模块共享常量，
  // 按本项目既有手法（fishingBalance.test.js 口径互校 / pinkDiamond125.test.js 压缩区源码断言）
  // 用源码字符串把两侧钉死：main.js 侧改了 15e3 或日志文案里的秒数，这条立刻红。
  const src = readSource("src/windows/main/main.js");
  const m = src.match(/finish 回调未在 (\d+)s 内触发[\s\S]{0,400}?\}\),(\d+(?:\.\d+)?(?:e\d+)?)\)/);
  assert.ok(m, "未在 main/main.js 中找到退出兜底 setTimeout（文案或结构已变，请同步 EXIT_FALLBACK_MS）");
  assert.strictEqual(
    Number(m[2]),
    EXIT_FALLBACK_MS,
    `main/main.js 兜底 setTimeout 为 ${m[2]}ms，与 EXIT_FALLBACK_MS(${EXIT_FALLBACK_MS}) 不一致`
  );
  assert.strictEqual(
    Number(m[1]) * 1000,
    EXIT_FALLBACK_MS,
    `main/main.js 日志文案写的是 ${m[1]}s，与 EXIT_FALLBACK_MS(${EXIT_FALLBACK_MS}) 不一致`
  );
  // 兜底只应有一处，避免出现第二个未被本断言覆盖的计时器
  assert.strictEqual((src.match(/finish 回调未在/g) || []).length, 1, "退出兜底计时器不止一处");
});

test("跨引用：swfPet.js 压缩区的 finish 判定式与 isFinishFrame 等价（防两侧漂移）", () => {
  // isFinishFrame 是 swfPet.js 判定式的可测复刻；swfPet.js 为压缩产物不可 require，
  // 因此断言其源码里的等值式仍是 `总帧 == 当前帧 + (lastTimeCut||1) + 1`。
  const src = readSource("src/windows/util/pet/swfPet.js");
  assert.ok(
    src.includes("a==e+(this.oldNext?.opt?.lastTimeCut||1)+1&&(this.oldNext.callBack.finish()"),
    "swfPet.js 的 finish 判定式已变化，isFinishFrame 需同步"
  );
  assert.ok(
    src.includes("a==e+t||"),
    "swfPet.js 的『切下一动作』判定式（总帧==当前帧+cut）已变化"
  );
});

test("退场时间轴预算：安全余量为正，且中段截止随采样间隔收紧", () => {
  assert.ok(EXIT_FINISH_SAFETY_MARGIN_MS > 0, "安全余量必须为正");
  assert.strictEqual(EXIT_FINISH_DEADLINE_MS, EXIT_FALLBACK_MS - EXIT_FINISH_SAFETY_MARGIN_MS);
  assert.ok(EXIT_FINISH_DEADLINE_MS < EXIT_FALLBACK_MS, "finish 截止必须早于生产硬兜底");
  // 尾段每采样最多 +1 帧 → 预算 = 尾段帧数 × 采样间隔
  assert.strictEqual(tailWalkBudgetMs(1000), RuffleBridge.TAIL_FORCE_FRAMES * 1000);
  assert.strictEqual(midSectionDeadlineMs(1000), EXIT_FINISH_DEADLINE_MS - RuffleBridge.TAIL_FORCE_FRAMES * 1000);
  // 采样被节流到极限（MAX_SAMPLE_GAP_MS）时中段截止钳到 0：立刻交棒给尾段
  assert.strictEqual(midSectionDeadlineMs(RuffleBridge.MAX_SAMPLE_GAP_MS), 0);
  // 采样间隔未知时按 24fps 轮询估计
  assert.strictEqual(tailWalkBudgetMs(undefined), RuffleBridge.TAIL_FORCE_FRAMES * RuffleBridge.POLL_INTERVAL_MS);
});

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
  // finish 判定点确实出现，且时间接近动画时长（不是等到生产硬兜底）
  assert.ok(finishAtMs !== null, "finish 判定点从未出现 —— P0 bug 未修复");
  assert.ok(finishAtMs <= durationMs + SAMPLE_INTERVAL_MS * 3, `finish 触发过晚：${finishAtMs}ms`);
  assert.ok(
    finishAtMs <= EXIT_FINISH_DEADLINE_MS,
    `finish 晚于 finish 截止 ${EXIT_FINISH_DEADLINE_MS}ms（生产硬兜底 ${EXIT_FALLBACK_MS}ms）：${finishAtMs}ms`
  );
  assert.strictEqual(bridge.isFallbackTimeline(), false, "不该走兜底时间轴");
  assert.strictEqual(logger.errors.length, 0, "正常路径不该报错");
});

test("P0 最坏情况：采样被降到 1fps（窗口隐藏时 rAF 被节流）仍能在生产硬兜底前触发 finish", () => {
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
    if (isFinishFrame({ numFrames: st.frame, currentFrame: st.currentFrame, lastTimeCut: 1 })) {
      finishAtMs = clock.now();
    }
  }
  assert.ok(finishAtMs !== null, "1fps 采样下 finish 判定点从未出现");
  assert.ok(
    finishAtMs <= EXIT_FINISH_DEADLINE_MS,
    `1fps 采样下 finish 晚于截止 ${EXIT_FINISH_DEADLINE_MS}ms（生产硬兜底 ${EXIT_FALLBACK_MS}ms）：${finishAtMs}ms`
  );
});

// 参数化：换素材（帧数变化）不得让 finish 越过生产硬兜底 —— 这是防 P0 复活的锚。
// 91=真实 Exit1.swf；100/150/300/600=假想更长的退场素材；8/24=极短素材与兜底帧数。
// cut 取 1（默认）与 5（bury 的 lastTimeCut，配置中最大值）。
for (const numFrames of [8, 24, 91, 100, 150, 300, 600]) {
  for (const lastTimeCut of [1, 5]) {
    for (const [rateName, intervalMs] of [
      ["24fps 正常轮询", SAMPLE_INTERVAL_MS],
      ["1fps 被节流", 1000],
    ]) {
      test(`不变量：${numFrames}帧@12fps / cut=${lastTimeCut} / ${rateName} → finish 必在生产硬兜底前触发`, () => {
        const clock = makeClock();
        const bridge = new RuffleBridge({ now: clock.now, logger: makeLogger() });
        bridge.setDom(makeFakeDom({ metadata: { numFrames, frameRate: 12 } }));
        // 采样到硬兜底时刻为止：兜底一到进程就被强杀，之后触发的 finish 对用户毫无意义
        const steps = Math.ceil(EXIT_FALLBACK_MS / intervalMs);
        const { finishAtMs, frames } = pollBridge(bridge, clock, { steps, lastTimeCut, intervalMs });
        assert.ok(
          finishAtMs !== null,
          `${numFrames}帧 cut=${lastTimeCut} 在 ${EXIT_FALLBACK_MS}ms 内 finish 判定点从未出现（帧序列尾部：${frames.slice(-12)}）`
        );
        assert.ok(
          finishAtMs <= EXIT_FINISH_DEADLINE_MS,
          `${numFrames}帧 cut=${lastTimeCut} 的 finish 在 ${finishAtMs}ms 触发，晚于截止 ${EXIT_FINISH_DEADLINE_MS}ms（生产硬兜底 ${EXIT_FALLBACK_MS}ms）`
        );
      });
    }
  }
}

test("中段硬截止：长素材在中段截止时刻被强制交棒到尾段起点（与素材帧数解耦）", () => {
  const NUM_FRAMES = 300;
  const tailStart = NUM_FRAMES - RuffleBridge.TAIL_FORCE_FRAMES;
  const deadline = midSectionDeadlineMs(1000);
  // 截止前一刻：仍按时间轴停在中段（不提前截断动画）
  assert.strictEqual(
    nextVirtualFrame({
      playedMs: deadline - 1,
      numFrames: NUM_FRAMES,
      frameRate: 12,
      lastFrame: 10,
      elapsedMs: deadline - 1,
      sampleGapMs: 1000,
    }),
    Math.floor((deadline - 1) / frameIntervalMs(12))
  );
  // 到点：强制落到尾段起点
  assert.strictEqual(
    nextVirtualFrame({
      playedMs: deadline,
      numFrames: NUM_FRAMES,
      frameRate: 12,
      lastFrame: 10,
      elapsedMs: deadline,
      sampleGapMs: 1000,
    }),
    tailStart
  );
  // 不传 elapsedMs（纯逻辑调用）时不启用硬截止，行为与修复前一致
  assert.strictEqual(
    nextVirtualFrame({ playedMs: 100000, numFrames: NUM_FRAMES, frameRate: 12, lastFrame: 10 }),
    tailStart
  );
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
  // 上界 = metadata 等待上限 + 兜底动画时长 + 3 次采样抖动；必须同时早于 finish 截止
  const fallbackBudgetMs =
    2000 +
    animationDurationMs(RuffleBridge.FALLBACK_NUM_FRAMES, RuffleBridge.DEFAULT_FRAME_RATE) +
    SAMPLE_INTERVAL_MS * 3;
  assert.ok(finishAtMs <= fallbackBudgetMs, `兜底路径 finish 过晚：${finishAtMs}ms > ${fallbackBudgetMs}ms`);
  assert.ok(
    finishAtMs <= EXIT_FINISH_DEADLINE_MS,
    `兜底路径 finish 晚于截止 ${EXIT_FINISH_DEADLINE_MS}ms：${finishAtMs}ms`
  );
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
