// 感知主循环：画面变化 / 5 分钟心跳触发多模态感知，按稳定场景分发。
// 移植自 pub-local-jarvis worker.cpp 感知循环 + orchestrator/service.py 的分发逻辑。
// Electron 依赖（截屏、openSpeak、barrageWindow）均惰性访问。
const _require = eval("require");
const { EventEmitter } = _require("events");

const { captureScreen, FrameChangeDetector, ScreenIdleMonitor } = _require(
  "./capture"
);
const {
  CourseSceneStabilizer,
  validateScene,
  resolveGameExitSamples,
  EVIDENCE_KEYS,
} = _require("./sceneStabilizer");
const { BarrageEmitter, textsAreSimilar } = _require("./barrageRanker");
const { chat, getVisionProvider } = _require("../llm/providers");
const { tryExtractJsonObject, isPlainObject } = _require("../llm/jsonParse");
const { UNIFIED_PERCEPTION_PROMPT } = _require("../llm/prompts");

const HEARTBEAT_MS = 5 * 60 * 1000;
const ASSISTANT_COOLDOWN_MS = 16 * 1000;
const ASSISTANT_DEDUP_WINDOW_MS = 60 * 1000;
const PERCEPTION_MAX_TOKENS = 1500;

// 失败日志节流：感知失败是持续性的（Key 失效、视觉模型不支持图片时每一轮都会失败），
// 逐轮打日志会把控制台刷满。首次记一条，之后每 N 次记一条。
// N 取 10 的依据：退避封顶 30s（见 start() 的 backoff），10 次失败 ≈ 5 分钟一条，
// 与 HEARTBEAT_MS 同量级——足以确认"故障仍在持续"，又不至于刷屏。
const PERCEPTION_FAILURE_LOG_EVERY = 10;
// 连续失败达到该次数时向用户弹一次气泡（此前用户开了感知却完全无从察觉它已失效）。
// 取 3 的依据：默认 interval 2s + 指数退避，3 次失败约 14s 内发生，
// 既能滤掉单次抖动（网络瞬断、偶发 5xx），又能让"从未配置视觉提供商"这类
// 必然失败在十几秒内被用户看见。
const PERCEPTION_FAILURE_NOTIFY_THRESHOLD = 3;
// 可预期的业务错误特征：均由用户的配置/账户状态导致，改配置即可解决，记 warn 足够。
// 覆盖 providers.js 抛出的"未配置 LLM 提供商"/"缺少 API Key"，以及 HTTP 4xx
// （模型不支持图片时的 400、Key 失效的 401、欠费的 402/403、限流的 429）。
const EXPECTED_PERCEPTION_ERROR_RE = /(?:尚未|未)配置|缺少 API Key|HTTP 4\d\d/;

// 屏幕闲置时的摸鱼吐槽（移植 service.py SCREEN_IDLE_MESSAGES）
const SCREEN_IDLE_MESSAGES = [
  "是在摸鱼吗？",
  "ZZZ...",
  "摸鱼小神仙是你吗？？",
  "屏幕都快睡着了。",
  "今天的鱼摸得很有节奏嘛。",
];

function sysGet(key) {
  return typeof getSys === "function" ? getSys(key) : undefined;
}

// —— 主动发言过滤器（移植 service.py _clean_duplex_message，require_proactive_value=true）——
const UNSUPPORTED_OFFER_RE =
  /需要我|要不要(?:我)?|是否需要|我(?:可以|来|能)(?:帮|替|为)|让我(?:帮|来)|帮你|替你|为你(?:打开|搜索|整理|处理|操作)|随时(?:告诉|叫|找)我|交给我/;
const ROUTINE_NARRATION_RE =
  /^[、，。；：）】\]}>]|^(?:和|与|及|以及|而且|但是|不过|的)(?!确)|^(?:当前|现在)?(?:正在|已打开|打开了|切换到|进入了|已经进入|开始查看)|^(?:当前|现在)(?:用户|你|您)?(?:正在)?(?:浏览|查看|观看|阅读|使用|停留|播放)|^(?:用户|你|您)(?:正在|在)?(?:浏览|查看|观看|阅读|使用|停留|播放)|^(?:当前|现在)?显示|^操作无(?:明显)?|^(?:画面|页面|视频|屏幕)(?:中|里|上)?(?:显示|出现|开始|正在|讲解|播放|内容|是)|(?:^|[，,；;。])(?:当前|现在)?(?:页面|画面|屏幕|界面)(?:中|里|上)?(?:显示|包含|出现|列出|展示)|^(?:你|您|主人|用户)(?:正在|在)|^(?:屏幕|画面|界面|桌面)(?:中|上|显示|有)|正在为(?:你|您)播放|(?:文件|列表|内容|信息)(?:较多|清晰|已经显示)|(?:光标|鼠标指针)|(?:桌面图标|快捷方式).{0,20}(?:打开|排列|显示)|(?:准备|打算)(?:继续|开始|打开|查看|往下)|^(?:这|该)?(?:新闻|文章|视频|页面|内容|帖子).{0,12}(?:是|关于|讲(?:的)?是|介绍|报道|涉及)/;
const DUPLEX_UNCERTAIN_RE = /看起来|似乎|可能是|大概|也许|推测|猜测/;
const PROACTIVE_VALUE_RE =
  /完成|成功|失败|报错|错误|异常|中断|超时|已保存|已下载|构建(?:通过|失败)|测试(?:通过|失败)|风险|危险|授权|权限|截止|到期|过期|不足|冲突|占用|泄露|断开|不可用|无法|找不到|未找到|空间(?:不足|已满)|建议|注意|留意|提醒|核对|确认|避免|谨防|变化|新增|减少|升高|降低/;
const NARRATION_PREFIX_RE = /^(?:好的|明白|收到)[，,。!！\s]*/;

function cleanDuplexMessage(message, { requireProactiveValue = true } = {}) {
  const cleaned = String(message || "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 6 || cleaned.includes("？") || cleaned.includes("?")) {
    return "";
  }
  if (
    UNSUPPORTED_OFFER_RE.test(cleaned) ||
    ROUTINE_NARRATION_RE.test(cleaned.replace(NARRATION_PREFIX_RE, "")) ||
    DUPLEX_UNCERTAIN_RE.test(cleaned)
  ) {
    return "";
  }
  if (requireProactiveValue && !PROACTIVE_VALUE_RE.test(cleaned)) return "";
  const firstSentence = cleaned.match(/^(.{6,60}?[。！!])/);
  if (firstSentence && firstSentence[1] !== cleaned) return firstSentence[1];
  if (cleaned.length > 60) return "";
  return cleaned;
}

// —— 感知响应解析（移植 service.py _parse_perception + _recover_truncated_perception）——
// 常规 JSON 抽取完全交给 llm/jsonParse.js（与 llm.js 同一套标准）：剥围栏、定位首个 "{"、
// 尾部回退都在那里做，本文件不再重复切片。
// 抽取不出来时才走本文件特有的"截断恢复"：被 max_tokens 掐断的响应 JSON 不闭合，
// 但正则仍能捞回 scene/confidence/scene_evidence 三项，足够驱动场景状态机。
// 关于错误文案：原先"完全没有 {"与"有 { 但解不出"是两条不同文案，现合并为一条并附上
// 原文片段。理由是这两条只经 perception-failed 事件外传（目前无监听者），区分它们不带来
// 任何动作差异，而排查时真正需要的是"模型到底返回了什么"。
function parsePerceptionJson(text) {
  const source = String(text || "");
  let value = tryExtractJsonObject(source);
  if (!value) {
    // 截断恢复：只取 scene/confidence/scene_evidence，其余字段留空
    const sceneMatch = source.match(/"scene"\s*:\s*"(game|course|other)"/);
    const confidenceMatch = source.match(
      /"confidence"\s*:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/
    );
    if (sceneMatch && confidenceMatch) {
      const evidence = {};
      for (const key of EVIDENCE_KEYS) {
        const m = source.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`));
        if (m) evidence[key] = m[1] === "true";
      }
      value = {
        scene: sceneMatch[1],
        confidence: parseFloat(confidenceMatch[1]),
        scene_evidence: evidence,
      };
    }
  }
  if (!isPlainObject(value)) {
    throw new Error(
      "perception response is not valid JSON: " +
        source.replace(/\s+/g, " ").slice(0, 200)
    );
  }
  return value;
}

// 字段归一化：模型偶发把本该是字符串的字段写成对象/数组，
// String() 会得到 "[object Object]" 并被当成正文（弹幕曾因此上屏），这里直接判空。
function str(value, limit) {
  if (value == null) return "";
  if (typeof value === "object") return "";
  return String(value).trim().slice(0, limit);
}

// 弹幕候选归一化：允许字符串，或 {text|content|barrage} 形式的对象；其余判空丢弃
function candidateText(candidate, limit) {
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return str(candidate.text ?? candidate.content ?? candidate.barrage, limit);
  }
  return str(candidate, limit);
}

// 归一化为统一感知契约，并套用 game/course 置信门槛（validateScene）
function buildPerceptionResult(value) {
  let scene = str(value.scene, 32).toLowerCase();
  if (!["game", "course", "other"].includes(scene)) scene = "other";
  let confidence = Number(value.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const rawEvidence =
    typeof value.scene_evidence === "object" && value.scene_evidence !== null
      ? value.scene_evidence
      : {};
  const sceneEvidence = {};
  for (const key of EVIDENCE_KEYS) sceneEvidence[key] = rawEvidence[key] === true;
  const evidenceProvided = Object.keys(rawEvidence).length > 0;

  const result = {
    scene,
    confidence,
    scene_evidence: sceneEvidence,
    observation: str(value.observation, 300),
    course_transcript: str(value.course_transcript, 2000),
    course_note: str(value.course_note, 2000),
    course_title: str(value.course_title, 128),
    course_interaction: str(value.course_interaction, 100),
    capture_keyframe: value.capture_keyframe === true,
    keyframe_note: str(value.keyframe_note, 300),
    assistant_message: str(value.assistant_message, 500),
    barrage: str(value.barrage, 30),
    // validateScene 的"无证据但有产出"兜底要看原始候选列表，先挂原始值
    // （非字符串元素在这里就被剔除，避免 "[object Object]" 混进弹幕）
    barrage_candidates: Array.isArray(value.barrage_candidates)
      ? value.barrage_candidates.map((c) => candidateText(c, 30)).filter(Boolean)
      : [],
    _evidenceProvided: evidenceProvided,
  };

  validateScene(result);
  delete result._evidenceProvided;

  // game 场景弹幕兜底（移植 _parse_perception 末段）
  if (result.scene === "game" && !result.barrage) {
    result.barrage = str(result.assistant_message || result.course_note, 30);
  }
  const rawCandidates = result.barrage_candidates;
  const candidates = [result.barrage, ...rawCandidates];
  const deduped = [];
  for (const c of candidates) {
    const text = str(c, 30);
    if (text && !deduped.includes(text)) deduped.push(text);
  }
  result.barrage_candidates = result.scene === "game" ? deduped.slice(0, 4) : [];
  result.barrage = result.scene === "game" ? result.barrage : "";
  return result;
}

class PerceptionLoop extends EventEmitter {
  constructor({
    intervalMs = null, // null 时每次 tick 惰性读 getSys("perceptionIntervalMs")
    captureFn = captureScreen, // 可注入，便于测试
    chatFn = chat,
  } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.captureFn = captureFn;
    this.chatFn = chatFn;
    this.detector = new FrameChangeDetector();
    this.idleMonitor = new ScreenIdleMonitor();
    this.stabilizer = new CourseSceneStabilizer();
    this.emitter = new BarrageEmitter((text) => this._showBarrage(text), {
      shouldEmit: () => this.stabilizer.current === "game",
    });
    this.timer = null;
    this.running = false;
    this.inFlight = false;
    // 运行周期编号：每次 start()/stop() 自增。所有异步续作（tick 的 finally、
    // 在途感知结果的派发）都要比对进入时捕获的 epoch，不一致即整段作废。
    // 修复两个真实缺陷：① stop() 后在途结果仍派发导致桌宠被永久隐藏；
    // ② stop()+start() 让旧 tick 的 finally 又排一条 timer，定时链叠加（截屏成倍）。
    this._epoch = 0;
    this._abort = null; // 在途感知请求的 AbortController，stop() 时掐断
    this.lastPerceptionAt = 0;
    this.lastAssistantAt = 0;
    this.recentAssistantMessages = []; // [{text, at}]，最多 6 条
    this._petHidden = false; // 游戏场景下桌宠是否处于隐藏态
    this._failures = 0; // 连续感知失败计数（用于指数退避与失败日志节流）
    this._failureNotified = false; // 本轮连续失败是否已告知过用户（只弹一次气泡）
  }

  _interval() {
    if (this.intervalMs) return this.intervalMs;
    const v = Number(sysGet("perceptionIntervalMs"));
    return Number.isFinite(v) && v >= 500 ? v : 2000;
  }

  _enabled() {
    // 配置项默认关闭；getSys 不存在（未初始化/纯 node 测试）视为开启
    if (typeof getSys !== "function") return true;
    return !!sysGet("perceptionEnabled");
  }

  _barrageEnabled() {
    // 弹幕默认开启；getSys 已修复为 in 语义，存储的 false 能如实读出
    if (typeof getSys !== "function") return true;
    return getSys("barrageEnabled") !== false;
  }

  start() {
    if (this.timer) return;
    this.running = true;
    this.detector.reset();
    this.idleMonitor.reset();
    this._failures = 0;
    this._failureNotified = false;
    const epoch = ++this._epoch; // 本次运行周期；旧周期的续作全部作废
    const tick = () => {
      if (!this.running || epoch !== this._epoch) return;
      this._tick(epoch)
        .then(() => {
          // 同样要比对 epoch：被作废的 tick 若恰好成功，不该把新周期的失败计数清零
          if (epoch !== this._epoch) return;
          this._failures = 0;
          this._failureNotified = false;
        })
        .catch((e) => {
          // 先判 epoch 再自增。本轮已被 stop() 作废（含 stop() 主动 abort 造成的失败）时：
          // 不计失败、不记日志、不告警、不上报。
          // 自增原先在 epoch 判定之前，会把被作废 tick 的失败数记到新运行周期上，
          // 让重新开启后的第一轮就带着不该有的退避。
          if (epoch !== this._epoch) return;
          // 连续失败指数退避：interval × 2^n，封顶 30s（API key 失效/断网时不至于狂打请求）
          this._failures = (this._failures || 0) + 1;
          // perception-failed 事件目前无生产监听者（EventEmitter 对无监听的非 error 事件
          // 静默返回 false），失败必须在这里无条件落日志，否则整条链路完全不可诊断。
          this._logFailure(e);
          this._maybeNotifyFailure();
          this.emit("perception-failed", { error: e?.message || String(e) });
        })
        .finally(() => {
          // 关键：epoch 比对。只看 this.running 会让"停止期间在途的 tick"
          // 在用户重新开启后再排一条 timer，与新链并存 → 截屏频率成倍
          if (!this.running || epoch !== this._epoch) return;
          const backoff = Math.min(
            30000,
            this._interval() * Math.pow(2, this._failures || 0)
          );
          this.timer = setTimeout(tick, backoff);
          if (this.timer.unref) this.timer.unref();
        });
    };
    this.timer = setTimeout(tick, this._interval());
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.running = false;
    this._epoch += 1; // 作废所有在途 tick 与已排队的续作
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // 掐断在途的截屏→大模型请求，避免关闭功能后请求还在跑（也让 inFlight 尽快复位）
    if (this._abort) {
      try {
        this._abort.abort();
      } catch (e) {
        console.error(
          "[perception] 中断在途感知请求失败:",
          e && e.stack ? e.stack : e
        );
      }
      this._abort = null;
    }
    this.emitter.cancel();
    this._restoreFromGame();
  }

  // 失败日志。分级依据：错误信息命中 EXPECTED_PERCEPTION_ERROR_RE 的属"用户配置/账户
  // 状态导致的可预期业务错误"（未配置提供商、缺 Key、HTTP 4xx），堆栈对排查无价值，
  // 记 warn + message；其余（网络栈异常、JSON 解析崩溃、代码缺陷）属意料外，记 error
  // + 完整堆栈。两条都写明降级后的行为，便于从日志判断桌宠此刻在做什么。
  _logFailure(e) {
    const n = this._failures;
    // 节流：首次 + 每 PERCEPTION_FAILURE_LOG_EVERY 次
    if (n !== 1 && n % PERCEPTION_FAILURE_LOG_EVERY !== 0) return;
    const tail =
      `（连续第 ${n} 次失败，本轮感知跳过，将在退避后重试；` +
      `连续失败 ${PERCEPTION_FAILURE_NOTIFY_THRESHOLD} 次后会气泡告知用户）:`;
    if (EXPECTED_PERCEPTION_ERROR_RE.test(e?.message || String(e || ""))) {
      console.warn(`[perception/loop] 屏幕感知失败${tail}`, e?.message || e);
    } else {
      console.error(`[perception/loop] 屏幕感知异常${tail}`, e?.stack || e);
    }
  }

  // 连续失败超阈值时经气泡（openSpeak，与主动发言/摸鱼提醒同一条用户可见通道，
  // 自带免打扰门禁）告知用户一次。只告知一次：下一次成功或 start() 才会复位标志。
  _maybeNotifyFailure() {
    if (this._failureNotified) return;
    if (this._failures < PERCEPTION_FAILURE_NOTIFY_THRESHOLD) return;
    this._failureNotified = true; // 先置位：openSpeak 抛错也不重复弹
    if (typeof openSpeak !== "function") return;
    try {
      openSpeak({
        data: {
          type: "text",
          data: "屏幕感知一直失败啦，可能是视觉模型没配置或者不支持看图，去设置里检查一下吧～",
          submitText: "",
        },
        active: "speak",
        nextActiveStr: "speak",
      });
    } catch (err) {
      console.error(
        "[perception/loop] 感知故障告知气泡失败（用户将无从察觉感知已失效）:",
        err && err.stack ? err.stack : err
      );
    }
  }

  async _tick(epoch = this._epoch) {
    if (!this._enabled()) {
      // 运行中被设置页关闭：若正处于游戏隐藏态则恢复桌宠与弹幕层
      this._restoreFromGame();
      return;
    }
    const frame = await this.captureFn({ maxWidth: 1280 });
    if (epoch !== this._epoch) return; // 截屏期间被 stop()：不再更新检测器状态
    const changed = this.detector.changed(frame.bitmap, frame.width, frame.height);
    const idleEvent = this.idleMonitor.observe(changed);

    if (idleEvent === "entered-idle") {
      this.emit("idle-changed", { idle: true });
      return;
    }
    if (idleEvent === "reminder-due") {
      this._speakIdleReminder();
      return;
    }
    if (idleEvent === "resumed") {
      this.emit("idle-changed", { idle: false });
    }
    if (this.idleMonitor.idle) return; // 闲置期间不做感知，只等摸鱼提醒

    const now = Date.now();
    const heartbeatDue = now - this.lastPerceptionAt >= HEARTBEAT_MS;
    if (!changed && !heartbeatDue) return;
    if (this.inFlight) return;

    this.inFlight = true;
    this.lastPerceptionAt = now;
    try {
      await this._perceive(frame, epoch);
    } finally {
      this.inFlight = false;
    }
  }

  async _perceive(frame, epoch = this._epoch) {
    const providerCfg = getVisionProvider();
    const context =
      `\n\n【动态上下文】当前稳定场景：${this.stabilizer.current}；` +
      `本地时间：${new Date().toLocaleString("zh-CN", { hour12: false })}。`;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    this._abort = controller;
    let text;
    try {
      text = await this.chatFn({
        providerCfg,
        messages: [{ role: "user", content: UNIFIED_PERCEPTION_PROMPT + context }],
        images: [frame.pngBuffer],
        maxTokens: PERCEPTION_MAX_TOKENS,
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      if (this._abort === controller) this._abort = null;
    }
    // 请求期间用户关掉了感知（或重开了一轮）：丢弃这份过期结果。
    // 否则会在感知已停止的情况下切场景、隐藏桌宠（且再没有 pet-show 来恢复）、重建弹幕窗。
    if (epoch !== this._epoch) return;
    const parsed = parsePerceptionJson(text);
    const result = buildPerceptionResult(parsed);
    this._dispatch(result);
  }

  _dispatch(result) {
    const observedScene = result.scene;
    const before = this.stabilizer.current;
    const exitSamples = resolveGameExitSamples(
      before,
      observedScene,
      result.scene_evidence
    );
    const scene = this.stabilizer.observe(observedScene, { exitSamples });
    result.observed_scene = observedScene;
    result.scene = scene;

    if (scene !== before) {
      this._onSceneChanged(before, scene);
    }

    // 记忆系统消费：任意场景、confidence≥0.6 的观察
    if (result.confidence >= 0.6 && result.observation) {
      this.emit("activity", {
        scene,
        confidence: result.confidence,
        text: result.observation,
        course_title: result.course_title,
        timestamp: new Date().toISOString(),
      });
    }

    if (scene === "game") {
      if (this._barrageEnabled() && result.barrage_candidates.length) {
        this.emitter.offerCandidates(result.barrage_candidates);
      } else {
        this.emitter.cancel();
      }
    } else if (scene === "course") {
      // 课程模块经 "course-perception" 事件消费结果（关键帧由 courseManager
      // 节流后发 "keyframe-capture" 事件，loop 不再自行触发截屏）
      this.emit("course-perception", result);
    } else {
      this._maybeSpeakAssistant(result.assistant_message);
    }
  }

  _onSceneChanged(from, to) {
    if (from === "game" && to !== "game") {
      this.emitter.cancel();
      // 退出游戏场景时隐藏弹幕覆盖层（jarvis 原实现同款行为）
      try {
        global.barrageWindow && global.barrageWindow.hide();
      } catch (e) {
        console.error(
          "[perception] 隐藏弹幕覆盖层失败:",
          e && e.stack ? e.stack : e
        );
      }
    }
    if (to === "game") {
      this._closeBubble();
      this._petHidden = true;
      this.emit("pet-hide", { scene: to });
    } else if (from === "game") {
      this._petHidden = false;
      this.emit("pet-show", { scene: to });
    }
    this.emit("scene-changed", {
      from,
      to,
      timestamp: new Date().toISOString(),
    });
  }

  // 感知被关闭/循环停止时的状态收尾：若桌宠正处于游戏隐藏态则恢复，并隐藏弹幕层
  _restoreFromGame() {
    if (this._petHidden) {
      this._petHidden = false;
      this.emit("pet-show", { scene: this.stabilizer.current });
    }
    this.emitter.cancel();
    try {
      global.barrageWindow && global.barrageWindow.hide();
    } catch (e) {
      console.error(
        "[perception] 收尾隐藏弹幕覆盖层失败:",
        e && e.stack ? e.stack : e
      );
    }
  }

  // other 场景主动发言：清洁过滤 + 16s 冷却 + 相似去重
  _maybeSpeakAssistant(message) {
    const cleaned = cleanDuplexMessage(message);
    if (!cleaned) return;
    const now = Date.now();
    if (now - this.lastAssistantAt < ASSISTANT_COOLDOWN_MS) return;
    const cutoff = now - ASSISTANT_DEDUP_WINDOW_MS;
    this.recentAssistantMessages = this.recentAssistantMessages.filter(
      (m) => m.at >= cutoff
    );
    if (this.recentAssistantMessages.some((m) => textsAreSimilar(cleaned, m.text))) {
      return;
    }
    if (typeof openSpeak !== "function") return;
    this.lastAssistantAt = now;
    this.recentAssistantMessages.push({ text: cleaned, at: now });
    if (this.recentAssistantMessages.length > 6) {
      this.recentAssistantMessages.shift();
    }
    try {
      openSpeak({
        data: { type: "text", data: cleaned, submitText: "" },
        active: "speak",
        nextActiveStr: "speak",
      });
    } catch (e) {
      console.error(
        "[perception] 主动发言气泡失败:",
        e && e.stack ? e.stack : e
      );
    }
  }

  _speakIdleReminder() {
    if (typeof openSpeak !== "function") return;
    const text =
      SCREEN_IDLE_MESSAGES[
        Math.floor(Math.random() * SCREEN_IDLE_MESSAGES.length)
      ];
    try {
      openSpeak({
        data: { type: "text", data: text, submitText: "" },
        nextActiveStr: "speak",
      });
    } catch (e) {
      console.error(
        "[perception] 摸鱼提醒气泡失败:",
        e && e.stack ? e.stack : e
      );
    }
  }

  // 进入 game：关掉宠物气泡，避免与弹幕重叠
  _closeBubble() {
    if (typeof openSpeak !== "function") return;
    try {
      openSpeak({
        data: { type: "text", data: "", submitText: "", finish: true },
      });
    } catch (e) {
      console.error(
        "[perception] 关闭宠物气泡失败:",
        e && e.stack ? e.stack : e
      );
    }
  }

  _showBarrage(text) {
    // 感知已停止时不发弹幕：barrageWindow.show() 内部会 ensure() 重建刚被销毁的窗口
    if (!this.running) return;
    // 尊重"免打扰"总开关：气泡走 openSpeak 时被拦，弹幕不走 openSpeak，需在此自行门禁
    if (typeof getSys === "function" && sysGet("doNotDisturb")) return;
    const bw = global.barrageWindow;
    if (bw && typeof bw.show === "function") {
      try {
        bw.show(text);
      } catch (e) {
        console.error("[perception] 弹幕上屏失败:", e && e.stack ? e.stack : e);
      }
    }
  }
}

const perceptionLoop = new PerceptionLoop();
global.perceptionLoop = perceptionLoop;

module.exports = {
  PerceptionLoop,
  perceptionLoop,
  parsePerceptionJson,
  buildPerceptionResult,
  cleanDuplexMessage,
  SCREEN_IDLE_MESSAGES,
  // 导出供回归测试断言节流/告警阈值，避免测试里硬编码魔法数字
  PERCEPTION_FAILURE_LOG_EVERY,
  PERCEPTION_FAILURE_NOTIFY_THRESHOLD,
};
