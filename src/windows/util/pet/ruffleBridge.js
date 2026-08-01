/**
 * ruffleBridge.js —— Ruffle 播放桥（替代已不存在的 Flash ActiveX/NPAPI 大驼峰帧 API）
 *
 * ## 背景（P0 bug：关闭桌宠必卡满生产硬兜底才被强杀）
 *
 * swfPet.js 的 StateWatcher 以 24fps 轮询 Flash ActiveX 老接口
 * `IsPlaying()` / `CurrentFrame()` / `TotalFrames()` / `PercentLoaded()`，
 * 并用 `Play()` / `StopPlay()` / `Rewind()` / `GotoFrame()` 控制播放。
 * 项目内置 Ruffle（0.2.0-nightly.2026.4.6，src/windows/js/ruffle/ruffle.js）**只**保留了
 * `PercentLoaded()` 一个大驼峰方法，其余全部不存在 → 四次调用全部抛 TypeError →
 * 被 `catch{return null}` 静默吞 → 状态恒为 null → setState 里所有帧驱动分支恒 false →
 * `finish` 回调永不触发 → main/main.js 的 before-quit 只能等硬兜底 app.exit()。
 * 该硬兜底的**唯一真值**是下面的 `EXIT_FALLBACK_MS`（当前 15000ms，与 main/main.js 里的
 * `setTimeout(...,15e3)` / 日志「finish 回调未在 15s 内触发」一致，由测试跨引用断言钉死）。
 *
 * ## Ruffle 实际提供的能力（已在 ruffle.js / wasm 中核实）
 *
 * 元素（`<embed type=application/x-shockwave-flash>` 被 polyfill 成 ruffle 元素）上可用：
 *   - getter `metadata`：加载完成后为对象，字段（wasm 内 MovieMetadata 序列化名）：
 *       width / height / frameRate / numFrames / swfVersion / backgroundColor /
 *       isActionScript3 / uncompressedLength
 *   - getter `isPlaying`：播放器是否在运行（非"时间轴是否播完"）
 *   - getter `readyState`、`loadedConfig`、`config`、`volume`、`isFullscreen`
 *   - 方法 `play()` / `pause()` / `reload()` / `load()` / `PercentLoaded()` / `displayMessage()`
 *   - 事件 `loadedmetadata`、`loadeddata`（CustomEvent，元素上派发）
 *   - **没有**：当前帧读取、跳帧（GotoFrame 等价物）、播放结束事件
 *
 * ## 本模块做法
 *
 * 既然 Ruffle 不给当前帧，也没有"播完"事件，就用 **metadata(numFrames/frameRate) + 单调时钟**
 * 重建一条"虚拟时间轴"，把 `currentFrame` / `totalFrames` 还原成 swfPet.js 期待的语义，
 * 从而让原有帧驱动逻辑（切下一动作、finish 回调）恢复工作。
 * 刻意**不做**大驼峰 shim：那要依赖 Ruffle 内部实现，版本一升就再坏一次。
 *
 * 关键语义约定（与 Flash ActiveX 一致，不可改）：
 *   - `CurrentFrame()` 是 **0 基**（第一帧为 0），`TotalFrames()` 是帧**数量**。
 *     证据：swfPet.js 里"播完"判定为 `totalFrames == currentFrame + lastTimeCut`（默认 cut=1），
 *     只有 0 基才等价于"停在最后一帧"；且素材中 Stand.swf/Die.swf 只有 1 帧，
 *     0 基下 `1 == 0 + 1` 恒真（随时可切下一动作），与老版实际表现一致。
 *   - `finish` 判定点为 `currentFrame == numFrames - lastTimeCut - 1`（倒数第二帧附近）。
 *   - 虚拟帧循环递增（Ruffle 的 AVM1 根时间轴默认也是循环播放），
 *     因此判定点每播完一轮都会再次出现，单次采样错过也能补上。
 *
 * 已知限制（诚实记录）：
 *   - 跳帧（swfPet 的 `nextFrames`：hideleft/hideright 跳到 61/66/39 帧）**无法实现**，
 *     Ruffle 未暴露任何跳帧 API，SWF 素材也没有可调的 ExternalInterface 回调。
 *     这里只保证不再抛异常，并一次性告警。
 *   - `isPlaying` 只能反映"播放器在跑"，无法区分"时间轴 stop() 停住"。
 *   - 虚拟时间轴起点取"读到 metadata 的那次采样"，与真实播放起点最多差一次采样(~42ms)。
 *
 * 运行环境：渲染层普通 script 全局类（window.RuffleBridge），同时兼容 CommonJS（node --test 用）。
 * 由 src/windows/app.html 的 <script> 引入（早于 window.js 注入的 swfPet.js 执行）。
 */
(function (global) {
  "use strict";

  /** 素材实测帧率：src/assets/Action 下全部 SWF 头 FrameRate 均为 12fps，作为 metadata 缺失时的默认值 */
  const DEFAULT_FRAME_RATE = 12;

  /**
   * swfPet.js StateWatcher 的轮询间隔（ms）——`defaultSystem.interval = 1000/24`。
   * 这里只用于"采样间隔未知时"的乐观估计（见 tailWalkBudgetMs）。
   */
  const POLL_INTERVAL_MS = 1000 / 24;

  /**
   * **退场硬兜底（ms）：本模块及其测试的单一真值。**
   *
   * 依据：src/windows/main/main.js 的 before-quit 里
   *   `setTimeout(()=>{console.warn("[退出] finish 回调未在 15s 内触发…");app.exit(0)}, 15e3)`
   * ——finish 回调若未在这个时间内触发，进程被强杀，用户观感就是"关闭桌宠卡住"（本仓库最初的 P0）。
   *
   * main/main.js 是 webpack 压缩单行产物，无法 require 主进程模块共享常量，因此按本项目既有手法
   * （参考 test/fishingBalance.test.js 的价格口径互校、test/pinkDiamond125.test.js 的压缩区源码断言）
   * 允许存在第二份字面量，但由 test/ruffleBridge.test.js 的跨引用断言读取 main.js 源码把两侧钉死：
   * 任何一侧被改动而另一侧没跟上，测试立刻红。
   */
  const EXIT_FALLBACK_MS = 15000;

  /**
   * finish 必须提前于硬兜底触发的安全余量（ms）。
   *
   * 取值依据（三项相加约 2.5s，取 3000 收整）：
   *   1. 生产的 15s 计时起点是 before-quit，而本模块的计时起点是 setDom（元素已创建/开始加载），
   *      两者之间还有 changeSwf 建元素 + Ruffle 起播的时间（test/ruffleSmoke/report.md 实测 ≤500ms）；
   *   2. finish 回调之后主进程仍要存档、销毁窗口，再走 app.quit；
   *   3. 一次采样的调度抖动（隐藏窗口下 rAF 被节流到约 1fps，单次可达 1s）。
   */
  const EXIT_FINISH_SAFETY_MARGIN_MS = 3000;

  /** 虚拟时间轴必须让 finish 判定点出现的最晚时刻（ms，自 setDom 起算） */
  const EXIT_FINISH_DEADLINE_MS = EXIT_FALLBACK_MS - EXIT_FINISH_SAFETY_MARGIN_MS;

  /**
   * metadata 等待上限（ms）。超过即判定加载失败，启用兜底虚拟时间轴，保证 finish 仍会触发。
   * 依据：素材是本地文件，Ruffle 冒烟测试（test/ruffleSmoke/report.md）中 load() 均在 500ms 内 resolve，
   * 2s 已留足 4 倍余量；同时远小于 EXIT_FALLBACK_MS，不会先被硬兜底抢走。
   */
  const METADATA_TIMEOUT_MS = 2000;

  /**
   * 兜底虚拟时间轴帧数：24 帧 @12fps = 2s。
   * 取值依据：必须 > 常见 lastTimeCut(1~5) + 1，才能让 finish 判定点（总帧-cut-1）存在且可达；
   * 同时尽量短，避免加载失败时把退出流程拖长。
   */
  const FALLBACK_NUM_FRAMES = 24;

  /**
   * "尾段"帧数：动画最后 N 帧必须**逐帧**被观测到，不许跳号。
   *
   * 依据：swfPet.js 里所有帧等值判定都落在尾段——
   *   切下一动作 `总帧 == 当前帧 + cut`、finish `总帧 == 当前帧 + cut + 1`，
   *   cut 即 lastTimeCut，素材配置中最大为 5（bury）。取 8 覆盖 cut ≤ 6 并留余量。
   * 中段帧号对逻辑无影响（只有不等式判定），因此中段允许"追赶式"跳号，
   * 这样即使采样被拖慢（窗口隐藏时 rAF 会被 Chromium 降到约 1fps，实测 30s 仅 31 次采样），
   * 也能在有限时间内走到尾段并触发 finish，而不是被 EXIT_FALLBACK_MS 硬兜底截断。
   */
  const TAIL_FORCE_FRAMES = 8;

  /**
   * 走完尾段最坏需要的时间（ms）。
   *
   * 尾段每次采样最多 +1 帧（语义要求，见 TAIL_FORCE_FRAMES），所以耗时 = 尾段帧数 × 采样间隔，
   * 与素材帧率无关，只受采样被节流的程度影响。
   *
   * @param {number} [sampleGapMs] 已观测到的最大采样间隔（ms）；未知时按 24fps 轮询乐观估计
   * @returns {number} 尾段预算（ms）
   */
  function tailWalkBudgetMs(sampleGapMs) {
    const gap = Number(sampleGapMs);
    const safe = Number.isFinite(gap) && gap > 0 ? Math.min(gap, MAX_SAMPLE_GAP_MS) : POLL_INTERVAL_MS;
    return TAIL_FORCE_FRAMES * safe;
  }

  /**
   * 中段最晚必须交棒给尾段的时刻（ms，自 setDom 起算）。
   *
   * 这是"finish 一定早于生产硬兜底"这条不变量的落点：中段是唯一会随素材帧数线性变长的部分
   * （numFrames-8 帧 ÷ frameRate 秒），素材一换长就会把 finish 推到 EXIT_FALLBACK_MS 之后
   * ——正是本仓库最初 P0 的复活路径。因此给中段设一个**与素材无关**的硬截止：
   *   中段截止 = finish 截止 − 尾段预算。
   * 到点仍在中段就直接跳到尾段起点（中段帧号不参与任何等值判定，跳号无害）。
   *
   * 代价（诚实记录）：单个动画时长超过该截止时，其尾段会被提前，观感上动画被截短。
   * 这是刻意取舍——退出卡死是 P0，动画少播几帧是观感问题。
   *
   * @param {number} [sampleGapMs] 已观测到的最大采样间隔（ms）
   * @returns {number} 中段截止时刻（ms），最小为 0（采样太慢时立即交棒）
   */
  function midSectionDeadlineMs(sampleGapMs) {
    return Math.max(0, EXIT_FINISH_DEADLINE_MS - tailWalkBudgetMs(sampleGapMs));
  }

  /**
   * 单次采样计入虚拟时间轴的最大时长（ms）。
   * 防止系统休眠唤醒后一次采样间隔巨大，把虚拟时间轴推得远超真实播放进度（提前判定播完）。
   * 取 2s：既能让"采样被降频到 1fps"的场景仍近似跟上真实时间，又能挡住休眠级别的跳变。
   */
  const MAX_SAMPLE_GAP_MS = 2000;

  /** metadata 未就绪时对外报告的中性状态：所有 setState 帧驱动分支在该状态下均为 false */
  const NEUTRAL_STATE = Object.freeze({
    frame: 0,
    currentFrame: 0,
    isPlaying: false,
    percentLoaded: 0,
  });

  /**
   * 单帧时长（ms）。
   * @param {number} frameRate 帧率（fps）；非正数/非法值时回落到 DEFAULT_FRAME_RATE
   * @returns {number} 单帧时长（ms）
   */
  function frameIntervalMs(frameRate) {
    const fps = Number(frameRate);
    const safe = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FRAME_RATE;
    return 1000 / safe;
  }

  /**
   * 一遍完整动画的时长（ms）。
   * @param {number} numFrames 总帧数
   * @param {number} frameRate 帧率（fps）
   * @returns {number} 动画时长（ms）；numFrames 非法时返回 0
   */
  function animationDurationMs(numFrames, frameRate) {
    const n = Number(numFrames);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n * frameIntervalMs(frameRate);
  }

  /**
   * 由"已播放时长"推出下一个虚拟帧号（0 基、循环播放）。
   *
   * 推进策略（见 TAIL_FORCE_FRAMES 注释的依据）：
   *   - 尾段（最后 TAIL_FORCE_FRAMES 帧）：按时间逐帧 +1，**绝不跳号**，走到末帧后回卷到 0；
   *   - 中段：允许追赶到时间对应的帧（帧号不参与等值判定，跳号无害），保证采样被降频时
   *     仍能在有限时间内抵达尾段；
   *   - 中段停留时间越过 midSectionDeadlineMs(sampleGapMs) 时**强制**交棒到尾段起点，
   *     这样 finish 触发时刻与素材帧数解耦，恒早于 EXIT_FALLBACK_MS（不变量，见该函数注释）；
   *   - 若本轮已播过尾段起点（含 target 已回卷），直接落到尾段起点再逐帧走完。
   *
   * @param {object} opt
   * @param {number} opt.playedMs   已播放累计时长（ms，只在播放中累加）
   * @param {number} opt.numFrames  总帧数
   * @param {number} opt.frameRate  帧率（fps）
   * @param {number} opt.lastFrame  上一次输出的帧号（首次传 -1）
   * @param {number} [opt.elapsedMs]   自 setDom 起的**墙钟**时长（ms）；缺省则不启用中段硬截止
   * @param {number} [opt.sampleGapMs] 已观测到的最大采样间隔（ms），用于估算尾段预算
   * @returns {number} 新的当前帧号（0 基，范围 [0, numFrames-1]）
   */
  function nextVirtualFrame(opt) {
    const numFrames = Number(opt && opt.numFrames);
    if (!Number.isFinite(numFrames) || numFrames <= 0) return 0;
    const lastFrame = Number(opt.lastFrame);
    if (!Number.isFinite(lastFrame) || lastFrame < 0) return 0;
    if (numFrames === 1) return 0;
    const playedMs = Math.max(0, Number(opt.playedMs) || 0);
    const target = Math.floor(playedMs / frameIntervalMs(opt.frameRate)) % numFrames;
    const tailStart = Math.max(0, numFrames - TAIL_FORCE_FRAMES);
    if (lastFrame >= tailStart) {
      // 尾段：时间没到就停在原帧，到了就 +1（末帧后回卷开始新一轮）
      if (target === lastFrame) return lastFrame;
      return lastFrame >= numFrames - 1 ? 0 : lastFrame + 1;
    }
    // 中段硬截止：再留在中段就来不及在硬兜底前走完尾段（素材帧数无关的保底）
    const elapsedMs = Number(opt.elapsedMs);
    if (Number.isFinite(elapsedMs) && elapsedMs >= midSectionDeadlineMs(opt.sampleGapMs)) return tailStart;
    // 已播到尾段（或采样太慢导致 target 回卷）→ 从尾段起点开始逐帧走
    if (target >= tailStart || target < lastFrame) return tailStart;
    return Math.max(lastFrame, target);
  }

  /**
   * 是否处于 swfPet.js 的 finish 判定点。
   *
   * 与 swfPet.js `setState` 中 `a == e + (lastTimeCut||1) + 1` 严格等价
   * （a=totalFrames，e=currentFrame）。生产判定仍在 swfPet.js 内，本函数供单测与诊断使用，
   * 保证"虚拟帧序列一定会经过该判定点"这一契约可被自动验证。
   *
   * @param {object} opt
   * @param {number} opt.numFrames    总帧数
   * @param {number} opt.currentFrame 当前帧（0 基）
   * @param {number} [opt.lastTimeCut=1] 动作配置的尾部截断帧数
   * @returns {boolean} 是否应触发 finish
   */
  function isFinishFrame(opt) {
    const numFrames = Number(opt && opt.numFrames);
    const currentFrame = Number(opt && opt.currentFrame);
    const cut = Number(opt && opt.lastTimeCut) || 1;
    if (!Number.isFinite(numFrames) || !Number.isFinite(currentFrame)) return false;
    return numFrames === currentFrame + cut + 1;
  }

  /**
   * 生成"同一 key 只告警一次"的告警器，避免 24fps 轮询刷屏。
   * @param {{warn?:Function,error?:Function}} logger 日志器（渲染层约定用 console）
   * @returns {(key:string, level:'warn'|'error', ...args:any[])=>boolean} 返回 true 表示本次真的输出了
   */
  function makeWarnOnce(logger) {
    const fired = Object.create(null);
    return function warnOnce(key, level) {
      if (fired[key]) return false;
      fired[key] = true;
      const rest = Array.prototype.slice.call(arguments, 2);
      const sink = logger && typeof logger[level] === "function" ? logger[level] : null;
      if (sink) sink.apply(logger, ["[ruffleBridge]"].concat(rest));
      return true;
    };
  }

  /** 静态播放控制用的日志器（默认 console，测试可用 RuffleBridge.setLogger 注入） */
  let staticLogger = typeof console !== "undefined" ? console : null;
  let staticWarnOnce = makeWarnOnce(staticLogger);

  class RuffleBridge {
    /**
     * @param {object} [opt]
     * @param {()=>number} [opt.now] 单调时钟（ms），默认 performance.now，退化为 Date.now；测试可注入
     * @param {{warn?:Function,error?:Function}} [opt.logger] 日志器，默认 console
     * @param {number} [opt.metadataTimeoutMs] metadata 等待上限，默认 METADATA_TIMEOUT_MS
     * @param {number} [opt.fallbackNumFrames] 兜底帧数，默认 FALLBACK_NUM_FRAMES
     * @param {number} [opt.defaultFrameRate] 默认帧率，默认 DEFAULT_FRAME_RATE
     */
    constructor(opt) {
      const o = opt || {};
      this.now =
        typeof o.now === "function"
          ? o.now
          : function () {
              if (global.performance && typeof global.performance.now === "function") {
                return global.performance.now();
              }
              return Date.now();
            };
      this.logger = o.logger || (typeof console !== "undefined" ? console : null);
      this.warnOnce = makeWarnOnce(this.logger);
      this.metadataTimeoutMs = Number(o.metadataTimeoutMs) > 0 ? Number(o.metadataTimeoutMs) : METADATA_TIMEOUT_MS;
      this.fallbackNumFrames = Number(o.fallbackNumFrames) > 0 ? Number(o.fallbackNumFrames) : FALLBACK_NUM_FRAMES;
      this.defaultFrameRate = Number(o.defaultFrameRate) > 0 ? Number(o.defaultFrameRate) : DEFAULT_FRAME_RATE;
      this.dom = null;
      /** @type {object} 最近一次对外报告的状态（供分方法读取，避免一次采样内重复推进时间轴） */
      this.state = Object.assign({}, NEUTRAL_STATE);
      this._resetTimeline();
    }

    /** 重置虚拟时间轴（换 SWF 元素时调用） */
    _resetTimeline() {
      this._started = false;
      this._fallback = false;
      this._numFrames = 0;
      this._frameRate = this.defaultFrameRate;
      this._lastFrame = -1;
      this._playedMs = 0;
      this._lastSampleMs = 0;
      /** 本条时间轴上观测到的最大采样间隔（ms），用于估算尾段预算；0 表示还没有可用观测 */
      this._maxSampleGapMs = 0;
      this._attachedMs = this.now();
      this._metadataFromEvent = null;
    }

    /**
     * 绑定新的 SWF 播放元素（swfPet 每次 changeSwf 完成后调用），并重置虚拟时间轴。
     * @param {(HTMLElement|null)} dom Ruffle 播放元素
     * @returns {void}
     */
    setDom(dom) {
      this.dom = dom || null;
      this.state = Object.assign({}, NEUTRAL_STATE);
      this._resetTimeline();
      if (!this.dom || typeof this.dom.addEventListener !== "function") return;
      // loadedmetadata 用于拿到更精确的播放起点；元素可能在 setDom 之前就已加载完成，
      // 那种情况由 _readMetadata() 的轮询兜住，所以这里不做"必须收到事件"的假设。
      const self = this;
      this.dom.addEventListener(
        "loadedmetadata",
        function onLoadedMetadata() {
          self._metadataFromEvent = self._domMetadata();
        },
        { once: true }
      );
    }

    /** @returns {(object|null)} 元素上的 metadata（读取失败一次性告警） */
    _domMetadata() {
      if (!this.dom) return null;
      try {
        return this.dom.metadata || null;
      } catch (err) {
        this.warnOnce("metadata-getter", "error", "读取 Ruffle metadata 失败，帧驱动将走兜底时间轴：", err);
        return null;
      }
    }

    /** @returns {boolean} 播放器是否在播放（读取失败一次性告警，并按"在播放"处理以免时间轴卡死） */
    _domIsPlaying() {
      if (!this.dom) return false;
      try {
        const v = this.dom.isPlaying;
        if (typeof v === "boolean") return v;
        this.warnOnce("isplaying-missing", "warn", "Ruffle 元素无 isPlaying getter（实得：" + typeof v + "），按播放中处理");
        return true;
      } catch (err) {
        this.warnOnce("isplaying-getter", "error", "读取 Ruffle isPlaying 失败，按播放中处理：", err);
        return true;
      }
    }

    /** @returns {number} 加载百分比（Ruffle 保留了 PercentLoaded()；不可用时按 metadata 推断） */
    _domPercentLoaded() {
      if (!this.dom) return 0;
      try {
        if (typeof this.dom.PercentLoaded === "function") return this.dom.PercentLoaded();
      } catch (err) {
        this.warnOnce("percentloaded", "warn", "调用 PercentLoaded() 失败，改用 metadata 推断：", err);
      }
      return this._domMetadata() ? 100 : 0;
    }

    /**
     * 启动虚拟时间轴。
     * @param {number} nowMs 当前时钟
     * @param {(object|null)} metadata Ruffle metadata；为空表示走兜底
     */
    _startTimeline(nowMs, metadata) {
      const n = metadata && Number(metadata.numFrames);
      const r = metadata && Number(metadata.frameRate);
      if (Number.isFinite(n) && n > 0) {
        this._numFrames = n;
        this._frameRate = Number.isFinite(r) && r > 0 ? r : this.defaultFrameRate;
        this._fallback = false;
      } else {
        this._numFrames = this.fallbackNumFrames;
        this._frameRate = this.defaultFrameRate;
        this._fallback = true;
        this.warnOnce(
          "fallback-timeline",
          "warn",
          "等待 " +
            this.metadataTimeoutMs +
            "ms 仍未拿到 Ruffle metadata，启用兜底虚拟时间轴（" +
            this.fallbackNumFrames +
            "帧@" +
            this.defaultFrameRate +
            "fps）；动作切换与 finish 回调仍可触发，但时长不准"
        );
      }
      this._started = true;
      this._lastFrame = 0;
      this._playedMs = 0;
      this._lastSampleMs = nowMs;
    }

    /**
     * 兜底时间轴运行中若 metadata 迟到（渲染层被节流时 SWF 加载可能超过 metadataTimeoutMs），
     * 就地切回真实帧数/帧率。保留已累计的播放时长（那是真实播放进度），只把总帧数换掉。
     * @returns {void}
     */
    _maybeUpgradeTimeline() {
      if (!this._fallback) return;
      const metadata = this._metadataFromEvent || this._domMetadata();
      const n = metadata && Number(metadata.numFrames);
      if (!Number.isFinite(n) || n <= 0) return;
      const r = metadata && Number(metadata.frameRate);
      this._numFrames = n;
      this._frameRate = Number.isFinite(r) && r > 0 ? r : this.defaultFrameRate;
      this._fallback = false;
      if (this._lastFrame > n - 1) this._lastFrame = n - 1;
      this.warnOnce(
        "upgrade-timeline",
        "warn",
        "metadata 迟到，已从兜底时间轴切回真实参数（" + n + "帧@" + this._frameRate + "fps）"
      );
    }

    /**
     * 采样一次，推进虚拟时间轴并返回当前状态。由 24fps 轮询调用。
     * @returns {{frame:number,currentFrame:number,isPlaying:boolean,percentLoaded:number}}
     *   frame=总帧数（对应老 TotalFrames()），currentFrame=当前帧（0 基，对应老 CurrentFrame()）
     */
    getState() {
      const nowMs = this.now();
      if (!this.dom) {
        this.state = Object.assign({}, NEUTRAL_STATE);
        return this.state;
      }
      if (!this._started) {
        const metadata = this._metadataFromEvent || this._domMetadata();
        if (metadata) {
          this._startTimeline(nowMs, metadata);
        } else if (nowMs - this._attachedMs >= this.metadataTimeoutMs) {
          this._startTimeline(nowMs, null);
        } else {
          // 加载窗口内报告中性状态：不能报 currentFrame=-1，否则 `总帧==当前帧+1` 会被误判成"播完"
          this.state = Object.assign({}, NEUTRAL_STATE, { percentLoaded: this._domPercentLoaded() });
          return this.state;
        }
      } else {
        this._maybeUpgradeTimeline();
      }
      const playing = this._domIsPlaying();
      const delta = nowMs - this._lastSampleMs;
      this._lastSampleMs = nowMs;
      if (delta > 0) {
        // 采样间隔取"历史最大值"而非最近值：只能高估不能低估，否则尾段预算被算小、
        // 中段截止被算晚，就又可能来不及在硬兜底前走完尾段。
        const gap = Math.min(delta, MAX_SAMPLE_GAP_MS);
        if (gap > this._maxSampleGapMs) this._maxSampleGapMs = gap;
      }
      if (playing && delta > 0) {
        this._playedMs += Math.min(delta, MAX_SAMPLE_GAP_MS);
      }
      this._lastFrame = nextVirtualFrame({
        playedMs: this._playedMs,
        numFrames: this._numFrames,
        frameRate: this._frameRate,
        lastFrame: this._lastFrame,
        // 墙钟口径：即使播放器报"没在播"，也不能让 finish 拖过生产硬兜底
        elapsedMs: nowMs - this._attachedMs,
        sampleGapMs: this._maxSampleGapMs,
      });
      this.state = {
        frame: this._numFrames,
        currentFrame: this._lastFrame,
        isPlaying: playing,
        percentLoaded: this._domPercentLoaded(),
      };
      return this.state;
    }

    /** @returns {number} 总帧数（读最近一次采样缓存，等价于老 TotalFrames()） */
    totalFrames() {
      return this.state.frame;
    }

    /** @returns {number} 当前帧，0 基（读最近一次采样缓存，等价于老 CurrentFrame()） */
    currentFrame() {
      return this.state.currentFrame;
    }

    /** @returns {boolean} 是否播放中（读最近一次采样缓存） */
    isPlaying() {
      return this.state.isPlaying;
    }

    /** @returns {number} 加载百分比（读最近一次采样缓存） */
    percentLoaded() {
      return this.state.percentLoaded;
    }

    /** @returns {boolean} 当前是否运行在兜底虚拟时间轴上（诊断用） */
    isFallbackTimeline() {
      return this._fallback;
    }

    /**
     * 注入静态播放控制方法使用的日志器（默认 console）。
     * @param {{warn?:Function,error?:Function}} logger
     * @returns {void}
     */
    static setLogger(logger) {
      staticLogger = logger || (typeof console !== "undefined" ? console : null);
      staticWarnOnce = makeWarnOnce(staticLogger);
    }

    /**
     * 继续播放（老 Play()）。
     * @param {HTMLElement} dom Ruffle 元素
     * @returns {boolean} 是否调用成功
     */
    static play(dom) {
      if (dom && typeof dom.play === "function") {
        try {
          dom.play();
          return true;
        } catch (err) {
          staticWarnOnce("play", "error", "调用 Ruffle play() 失败：", err);
          return false;
        }
      }
      staticWarnOnce("play-missing", "warn", "Ruffle 元素无 play()，无法继续播放");
      return false;
    }

    /**
     * 暂停播放（老 StopPlay()）。
     * @param {HTMLElement} dom Ruffle 元素
     * @returns {boolean} 是否调用成功
     */
    static pause(dom) {
      if (dom && typeof dom.pause === "function") {
        try {
          dom.pause();
          return true;
        } catch (err) {
          staticWarnOnce("pause", "error", "调用 Ruffle pause() 失败：", err);
          return false;
        }
      }
      staticWarnOnce("pause-missing", "warn", "Ruffle 元素无 pause()，无法暂停");
      return false;
    }

    /**
     * 重头播放（老 Rewind()）。Ruffle 无跳帧能力，只能整片重载。
     * @param {HTMLElement} dom Ruffle 元素
     * @returns {boolean} 是否调用成功
     */
    static rewind(dom) {
      if (dom && typeof dom.reload === "function") {
        try {
          dom.reload();
          return true;
        } catch (err) {
          staticWarnOnce("rewind", "error", "调用 Ruffle reload() 失败：", err);
          return false;
        }
      }
      staticWarnOnce("rewind-missing", "warn", "Ruffle 元素无 reload()，无法回到片头");
      return false;
    }

    /**
     * 跳帧（老 GotoFrame()）。**Ruffle 未暴露任何跳帧 API，这里只保证不抛异常并一次性告警。**
     * 影响：hideleft/hideright 的 nextFrames（跳到 61/66/39 帧）无法生效，贴边动画会整片循环。
     * @param {HTMLElement} dom Ruffle 元素
     * @param {number} frame 目标帧号
     * @returns {boolean} 恒为 false（未执行跳帧）
     */
    static gotoFrame(dom, frame) {
      staticWarnOnce(
        "gotoframe-unsupported",
        "warn",
        "Ruffle 不支持跳帧，忽略 GotoFrame(" + frame + ")：贴边等依赖 nextFrames 的动画将整片播放/循环"
      );
      return false;
    }

    /**
     * 直接读取播放器播放状态（不经过虚拟时间轴）。
     * @param {HTMLElement} dom Ruffle 元素
     * @returns {boolean} 是否播放中
     */
    static isPlaying(dom) {
      if (!dom) return false;
      try {
        return dom.isPlaying === true;
      } catch (err) {
        staticWarnOnce("static-isplaying", "error", "读取 Ruffle isPlaying 失败：", err);
        return false;
      }
    }
  }

  // 常量与纯函数挂到类上，便于单测与线上诊断
  RuffleBridge.DEFAULT_FRAME_RATE = DEFAULT_FRAME_RATE;
  RuffleBridge.POLL_INTERVAL_MS = POLL_INTERVAL_MS;
  RuffleBridge.EXIT_FALLBACK_MS = EXIT_FALLBACK_MS;
  RuffleBridge.EXIT_FINISH_SAFETY_MARGIN_MS = EXIT_FINISH_SAFETY_MARGIN_MS;
  RuffleBridge.EXIT_FINISH_DEADLINE_MS = EXIT_FINISH_DEADLINE_MS;
  RuffleBridge.METADATA_TIMEOUT_MS = METADATA_TIMEOUT_MS;
  RuffleBridge.FALLBACK_NUM_FRAMES = FALLBACK_NUM_FRAMES;
  RuffleBridge.MAX_SAMPLE_GAP_MS = MAX_SAMPLE_GAP_MS;
  RuffleBridge.TAIL_FORCE_FRAMES = TAIL_FORCE_FRAMES;
  RuffleBridge.frameIntervalMs = frameIntervalMs;
  RuffleBridge.animationDurationMs = animationDurationMs;
  RuffleBridge.nextVirtualFrame = nextVirtualFrame;
  RuffleBridge.isFinishFrame = isFinishFrame;
  RuffleBridge.tailWalkBudgetMs = tailWalkBudgetMs;
  RuffleBridge.midSectionDeadlineMs = midSectionDeadlineMs;

  global.RuffleBridge = RuffleBridge;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
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
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
