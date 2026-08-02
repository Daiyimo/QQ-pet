// 课程记录管理器：移植 jarvis orchestrator/service.py 的课程相关流程。
// 消费感知模块 'course-perception' 事件 payload，维护录制会话，
// 结束时分块总结（云端 LLM）并导出 Markdown 到 桌面/QQ-Courses/<id>/README.md。
// Electron 依赖（openSpeak / desktop 路径）全部惰性访问，普通 node 可 require。
const _require = eval("require");
const fs = _require("fs");
const path = _require("path");
const os = _require("os");
const { EventEmitter } = _require("events");

const { CourseRepo, atomicWrite } = _require("./repo.js");
const { getElectronPath } = _require("../electronPaths.js");
const transcript = _require("./transcript.js");
const providers = _require("../llm/providers.js");
const prompts = _require("../llm/prompts.js");

// 节流/退出参数（对应 jarvis settings.courses / settings.interaction）
const MAX_KEYFRAMES = 40; // 每会话关键帧上限
const KEYFRAME_MIN_INTERVAL_MS = 30 * 1000; // 关键帧最小间隔
const INTERACTION_COOLDOWN_MS = 30 * 1000; // 课程气泡冷却
const EXIT_SAMPLES = 4; // 连续非 course 次数阈值
const EXIT_GRACE_MS = 90 * 1000; // 且距首次非 course 时长阈值
// 看门狗：activity 桥（aiWiring）只在 confidence≥0.6 且 observation 非空时发事件
//（perception/loop.js 的门槛），屏幕持续模糊时 handleNonCourse 一次都不会被调到，
// 自动会话会无限拖延。因此对自动会话加"无课程感知信号"超时兜底，
// 不依赖任何感知事件也能让会话终结。
const SILENCE_TIMEOUT_MS = 5 * 60 * 1000; // 连续无课程感知信号的超时时长
const WATCHDOG_INTERVAL_MS = 30 * 1000; // 看门狗检查间隔
const SUMMARY_LIMIT = 6000;
const CHAT_TIMEOUT_MS = 120000;
// 桌面导出目录（桌面/QQ-Courses）的课程数上限提示。依据：桌面是用户可见资产，
// 删除不可逆，这里只在超限时告警提示用户自行清理，不代替用户删桌面文件。
// 取 30 与本地会话上限（repo.MAX_SESSION_COUNT=20）留出余量，避免刚导出就刷告警。
const MAX_EXPORTED_COURSES = 30;
// state.summary_error 里保留的错误摘要长度上限。依据：providers.chat 的 HTTP 错误会把
// 响应体截到 500 字符拼进 message，整段写进 state.json 会淹没其他字段、也会灌进导出稿；
// 300 字符足够看清 "HTTP 429" / "缺少 API Key" 这类根因。
const SUMMARY_ERROR_LIMIT = 300;
// —— 启动恢复（崩溃/断电遗留的 finalizing 会话、总结失败的会话）——
// 延迟依据：courses/index.js 在 doMain 启动链里被同步 require，恢复要跑 LLM
//（每次调用上限 CHAT_TIMEOUT_MS=120s），绝不能压在启动路径上；20 秒足够窗口首帧与
// 感知循环拉起，又远小于用户开始上一节课的时间尺度。
const STARTUP_RECOVERY_DELAY_MS = 20 * 1000;
// 单次启动最多恢复的会话数。依据：每个会话恢复要重跑整条分块总结（N 次 LLM 调用），
// 积压到 repo.MAX_SESSION_COUNT=20 个时全量恢复会一次打出上百次请求、把主进程占住数分钟；
// 3 个覆盖"崩溃前后 1~2 节课"的现实情形，其余留给下次启动或用户手动重试。
const MAX_RECOVERY_PER_STARTUP = 3;

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 自动会话 id/标题用的时间戳：YYYYMMDD-HHMMSS（UTC，同 jarvis）
function utcStamp() {
  const d = new Date();
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

// 桌面路径：Electron app.getPath("desktop")，无 Electron 退 ~/Desktop（单测用）。
// 可用性判定与降级日志统一走 electronPaths（原内联实现漏了"require 成功但 app 为
// undefined"这条静默降级，见该模块注释）。
function desktopPath() {
  return getElectronPath("desktop", path.join(os.homedir(), "Desktop"), "courses");
}

// 总结失败的日志分级：可预期的业务/环境错误（未配置 provider、缺 Key、HTTP 4xx 含 429、
// 请求超时）只需 warn——用户改配置或稍后重试即可；其余（编程错误、磁盘/解析异常）
// 属意外异常，必须 error + 完整堆栈。
function isExpectedSummaryError(e) {
  const message = String((e && e.message) || e || "");
  return (
    /配置 LLM 提供商/.test(message) ||
    /缺少 API Key/.test(message) ||
    /HTTP 4\d\d/.test(message) ||
    /\btimeout\b/i.test(message)
  );
}

// 是否需要（重）生成终稿总结。判据是"有没有真的产出过 summary"，而不是"有没有 summary_error"。
// 依据：finishSession 先把 status 置 finalizing、再 await _generateFinalSummary（这个顺序不可换，
// 见该处注释），所以"总结途中崩溃/断电"在磁盘上留下的正是 finalizing + 空 summary +
// summary_error=null。按 summary_error 判会把它误当成"只差导出"，直接导出一份既没有总结、
// 也没写失败说明的 README 并置 complete，此后 repo.recoverable() 再也不列出它
// → 那节课的总结永久丢失且无法重试，而 state 显示一切正常。
// 反向也成立：summary 非空 ⟺ _generateFinalSummary 真的成功过（_askSummarizer 对空响应抛错），
// 因此"summary 完好、只是导出环节失败"的会话不会被拖去白跑一次 LLM。
function needsSummaryRerun(state) {
  if (!state) return false;
  return !String(state.summary || "").trim() || !!state.summary_error;
}

function speakBubble(text) {
  if (typeof openSpeak !== "function") return;
  openSpeak({
    data: { type: "text", data: text, submitText: "" },
    nextActiveStr: "speak",
  });
}

class CourseManager extends EventEmitter {
  // opts.now / setInterval / clearInterval / setTimeout / desktopDir 仅测试注入
  //（看门狗定时链 + 启动恢复定时器 + 导出根目录，避免单测写进用户真实桌面），
  // 生产走全局/desktopPath()；autoRecover=false 也只给测试用（关掉启动恢复调度）。
  constructor({
    repo,
    now,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    setTimeout: setTimeoutFn,
    desktopDir,
    autoRecover,
  } = {}) {
    super();
    this.repo = repo || new CourseRepo();
    this._desktopDir = desktopDir || null;
    this._nowFn = now || (() => Date.now());
    this._setIntervalFn = setIntervalFn || ((fn, ms) => setInterval(fn, ms));
    this._clearIntervalFn = clearIntervalFn || ((t) => clearInterval(t));
    this._setTimeoutFn = setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this.currentSession = null; // 当前录制中的 state 快照（含 manual 标记）
    this._lastTranscript = ""; // 上一轮全量转写（增量提取基准）
    this._lastNote = ""; // 上一条入库笔记（连续去重）
    this._lastInteraction = "";
    this._lastInteractionAt = 0;
    this._keyframeRequestedAt = 0;
    this._nonCourseStreak = 0;
    this._nonCourseStartedAt = 0;
    this._lastCourseSignalAt = 0; // 最近一次课程感知信号时间（看门狗基准）
    this._watchdog = null; // 无课程信号看门狗定时器（仅自动会话）
    this._recoveryStarted = false; // 启动恢复的幂等闸门：一个进程只跑一次
    this._exportOverflowNotified = false; // 桌面导出目录超限只对用户提示一次（本进程内）
    if (autoRecover !== false) this._scheduleStartupRecovery();
  }

  // ---- 启动恢复：把崩溃遗留的会话重新结稿 ----
  // repo.recoverable() 共两个调用者：这条恢复链路（recoverPending 内部），以及本类
  // 对外暴露的同名 recoverable() 透传（供设置页/测试只查询不恢复）。两者读同一份判据，
  // 差别只在"查完是否接着结稿"。
  // 只挂一个 unref 定时器，启动路径上零同步工作；恢复内部的任何失败都不向外冒泡。
  _scheduleStartupRecovery() {
    const timer = this._setTimeoutFn(() => {
      this.recoverPending().catch((e) => {
        console.error(
          "[courses/manager] 启动恢复流程异常退出，本次启动不再恢复（重启或手动结稿仍可重试）:",
          (e && e.stack) || e
        );
      });
    }, STARTUP_RECOVERY_DELAY_MS);
    if (timer && timer.unref) timer.unref(); // 恢复定时器不得拖住进程退出
    return timer;
  }

  // 恢复可恢复会话（finalizing / failed / complete+summary_error）。
  // 幂等三重保证：① _recoveryStarted 闸门，同一进程只执行一次；
  // ② 逐个走 finishSession(id)——它对"complete 且无 summary_error"直接返回，
  //    重复调用不会重复导出、也不会重复调 LLM；
  // ③ 恢复成功的会话自动离开 recoverable()，下次启动只会再看到仍然坏着的那些。
  // 上界 MAX_RECOVERY_PER_STARTUP，串行执行（不并发打 LLM），未处理的留日志。
  async recoverPending() {
    const result = { recovered: 0, retried: 0, skipped: 0 };
    if (this._recoveryStarted) return result;
    this._recoveryStarted = true;
    let pending;
    try {
      pending = this.repo.recoverable();
    } catch (e) {
      console.error(
        "[courses/manager] 列举可恢复会话失败，本次启动跳过恢复:",
        (e && e.stack) || e
      );
      return result;
    }
    const targets = (pending || []).filter(
      (s) => s && s.id && !(this.currentSession && this.currentSession.id === s.id)
    );
    if (!targets.length) return result; // 正常启动的常态：不留任何日志
    // 需要重跑总结的会话才吃 LLM 门禁；"只差导出"的（summary 完好、只是导出/落盘失败）
    // 沿用已有 summary 直接重导，未配置提供商也照样能恢复。
    // 判据见 needsSummaryRerun（原先的 `s.status === "recording"` 是死分支：recoverable()
    // 只返回 finalizing/failed/complete+summary_error，永远不含 recording；真有滞留的
    // recording 会话由 handleCoursePerception 的僵尸收养接手，不走恢复）。
    // 转写为空的会话虽然 summary 也为空，但 _generateFinalSummary 读到空转写会直接返回、
    // 一次 LLM 都不打，所以未配置提供商时它照样该被恢复导出——门禁额外要求转写非空。
    const needsLlm = (s) => needsSummaryRerun(s) && !!this.repo.readTranscript(s.id).trim();
    const summarizerReady = targets.some(needsLlm) ? this._hasSummarizer() : true;
    const batch = [];
    const overBound = [];
    const noProvider = [];
    for (const session of targets) {
      if (needsLlm(session) && !summarizerReady) {
        noProvider.push(session.id);
      } else if (batch.length >= MAX_RECOVERY_PER_STARTUP) {
        overBound.push(session.id);
      } else {
        batch.push(session);
      }
    }
    if (noProvider.length) {
      // 只一条提示，不逐会话刷屏：未配置提供商时重跑总结必然失败
      console.warn(
        `[courses/manager] 尚未配置 LLM 提供商，${noProvider.length} 个待重跑总结的会话本次跳过` +
          `（${noProvider.join(", ")}）：配置后重启或手动结稿即会重试`
      );
    }
    if (overBound.length) {
      console.warn(
        `[courses/manager] 单次启动最多恢复 ${MAX_RECOVERY_PER_STARTUP} 个会话，` +
          `本次剩余 ${overBound.length} 个留待下次启动（${overBound.join(", ")}）`
      );
    }
    const stillBroken = [];
    for (const session of batch) {
      result.retried += 1;
      let state = null;
      try {
        state = await this.finishSession(session.id);
      } catch (e) {
        // finishSession 内部已兜住绝大多数异常；这里防它自身的编程错误拖垮整批恢复
        console.error(
          `[courses/manager] 恢复会话 ${session.id} 时发生意外异常，跳过该会话继续恢复:`,
          (e && e.stack) || e
        );
      }
      if (state && state.status === "complete" && !state.summary_error) result.recovered += 1;
      else stillBroken.push(session.id);
    }
    result.skipped = noProvider.length + overBound.length;
    console.warn(
      `[courses/manager] 启动恢复完成：尝试 ${result.retried} 个、成功 ${result.recovered} 个、` +
        `仍失败 ${stillBroken.length} 个（${stillBroken.join(", ") || "无"}）、` +
        `跳过 ${result.skipped} 个`
    );
    return result;
  }

  // 恢复前的 LLM 门禁：未配置提供商时重跑总结必然失败（每个会话都会写一次 summary_error
  // 并留一条 warn），所以整批跳过并只提示一次。配置读取本身失败按"未配置"降级。
  _hasSummarizer() {
    try {
      return !!providers.hasChatProvider();
    } catch (e) {
      console.error(
        "[courses/manager] 查询 LLM 提供商配置失败，按未配置降级（本次跳过需重跑总结的会话）:",
        (e && e.stack) || e
      );
      return false;
    }
  }

  // 开始录制；已有录制中的会话时直接复用（幂等）
  startSession({ title, manual = false } = {}) {
    if (this.currentSession) return this.currentSession;
    const stamp = utcStamp();
    title = String(title || "").trim() ||
      (manual ? `手动课程记录 ${stamp}` : `自动网课记录 ${stamp}`);
    const state = this.repo.createSession({
      title,
      sessionId: manual ? undefined : `auto-${stamp}`,
    });
    this.currentSession = { ...state, manual: !!manual };
    this._lastTranscript = "";
    this._lastNote = "";
    this._keyframeRequestedAt = 0;
    this._lastCourseSignalAt = this._nowFn();
    this._armWatchdog();
    this.emit("session-started", state);
    return state;
  }

  // ---- 无课程信号看门狗（仅自动会话）----
  _armWatchdog() {
    if (this._watchdog || !this.currentSession || this.currentSession.manual) return;
    this._watchdog = this._setIntervalFn(() => this._checkSilence(), WATCHDOG_INTERVAL_MS);
    if (this._watchdog && this._watchdog.unref) this._watchdog.unref();
  }

  _disarmWatchdog() {
    if (!this._watchdog) return;
    this._clearIntervalFn(this._watchdog);
    this._watchdog = null;
  }

  _checkSilence() {
    const session = this.currentSession;
    if (!session || session.manual) {
      this._disarmWatchdog();
      return;
    }
    if (this._nowFn() - this._lastCourseSignalAt >= SILENCE_TIMEOUT_MS) {
      console.warn(
        `[courses] 超过 ${SILENCE_TIMEOUT_MS}ms 无课程感知信号，自动结束会话（看门狗兜底）`
      );
      // async 调用，异常（如 state.json 损坏）不能变成 unhandledRejection
      this.finishSession().catch((e) => {
        console.warn("[courses] 看门狗结束会话失败:", e?.message || e);
      });
    }
  }

  // 感知模块确认 course 场景后的入口（payload 为统一感知 JSON 的课程字段）
  handleCoursePerception(result = {}) {
    this._nonCourseStreak = 0;
    this._nonCourseStartedAt = 0;
    this._lastCourseSignalAt = this._nowFn(); // 喂看门狗：课程信号活跃

    const note = transcript.cleanCourseNote(result.course_note);
    const validTranscript = transcript.cleanCourseTranscript(result.course_transcript);
    const captureKeyframe = result.capture_keyframe === true;

    if (note || validTranscript || captureKeyframe) {
      // 无录制会话时：先收养重启后滞留的 recording 会话（jarvis 复用 recording[-1]），
      // 没有再自动开启新会话（标题取模型给的课程名）
      if (!this.currentSession) {
        const zombie = this.repo.findRecordingSession();
        if (zombie) {
          this.currentSession = { ...zombie, manual: false };
          this._armWatchdog();
          this.emit("session-started", zombie);
        } else {
          this.startSession({ title: String(result.course_title || "").trim() });
        }
      }
      const id = this.currentSession.id;

      // 转写增量入库
      const delta = transcript.transcriptDelta(this._lastTranscript, validTranscript);
      if (delta) {
        const state = this.repo.appendTranscript(id, delta);
        this._lastTranscript = validTranscript;
        this.emit("transcript-recorded", { id, transcript: delta, state });
      }
      // 笔记清洗入库（追加进 transcript.md，连续重复不入）
      if (note && note !== this._lastNote) {
        this.repo.appendTranscript(id, note);
        this._lastNote = note;
        this.emit("note-recorded", { id, note });
      }
      // 关键帧：节流通过后发事件，由主会话截屏后回调 recordKeyframe
      if (captureKeyframe) {
        this._requestKeyframe(String(result.keyframe_note || ""));
      }
    }

    this._handleInteraction(result, note, validTranscript);
  }

  // 课程互动气泡：清洗 + 30s 冷却 + 去重后经 openSpeak 播报
  _handleInteraction(result, note, validTranscript) {
    const knowledgeSource = note || validTranscript;
    const rawInteraction = String(result.course_interaction || "");
    let message = knowledgeSource
      ? transcript.cleanCourseInteraction(rawInteraction)
      : "";
    if (!message && knowledgeSource && !rawInteraction.trim()) {
      message = transcript.noteInteractionFallback(knowledgeSource);
    }
    const now = Date.now();
    if (
      message &&
      message !== this._lastInteraction &&
      now - this._lastInteractionAt >= INTERACTION_COOLDOWN_MS
    ) {
      this._lastInteraction = message;
      this._lastInteractionAt = now;
      speakBubble(message);
      this.emit("interaction", { text: message, confidence: result.confidence });
    }
  }

  // 关键帧节流：每会话 ≤40 张、间隔 ≥30s
  _requestKeyframe(note) {
    const session = this.currentSession;
    if (!session) return;
    const state = this.repo.getState(session.id);
    if (state.keyframes.length >= MAX_KEYFRAMES) return;
    const now = Date.now();
    if (now - this._keyframeRequestedAt < KEYFRAME_MIN_INTERVAL_MS) return;
    this._keyframeRequestedAt = now;
    const createdMs = Date.parse(state.created_at) || now;
    const timestampMs = Math.max(0, now - createdMs);
    this.emit("keyframe-capture", {
      id: state.id,
      timestampMs,
      note: String(note || "").trim().slice(0, 300),
    });
  }

  // 主会话截屏完成后的回调：PNG 原字节入库
  recordKeyframe({ timestampMs, pngBuffer, note } = {}) {
    if (!this.currentSession) return null;
    return this.repo.addKeyframe(this.currentSession.id, {
      timestampMs,
      pngBuffer,
      note,
    });
  }

  // 非 course 场景计数：连续 4 次且距首次 ≥90s 自动结束（仅自动会话）。
  // 注意本方法只在 activity 桥（aiWiring）被调，感知结果被 confidence/observation
  // 门槛滤掉时永远不会走到这里——那种"完全无信号"的情形由看门狗（_checkSilence）兜底。
  handleNonCourse() {
    const session = this.currentSession;
    if (!session || session.manual) return;
    const now = Date.now();
    if (!this._nonCourseStartedAt) this._nonCourseStartedAt = now;
    this._nonCourseStreak += 1;
    if (
      this._nonCourseStreak >= EXIT_SAMPLES &&
      now - this._nonCourseStartedAt >= EXIT_GRACE_MS
    ) {
      // async 调用，异常（如 state.json 损坏）不能变成 unhandledRejection
      this.finishSession().catch((e) => {
        console.warn("[courses] 自动结束会话失败:", e?.message || e);
      });
    }
  }

  // 结束会话：入口即把 status 置 finalizing（任何 await 之前）→ 生成终稿总结 →
  // 导出 Markdown → complete；导出/落盘失败 → failed（可重试）。
  // 总结失败不阻断导出，但会写 state.summary_error，使会话保持"可重试总结"。
  async finishSession(sessionId) {
    const session = this.currentSession;
    const id = sessionId || (session && session.id);
    if (!id) return null;
    if (session && session.id === id) {
      // 这段必须留在任何 await 之前：否则看门狗会在总结期间反复触发 finishSession
      this.currentSession = null;
      this._disarmWatchdog();
      this._nonCourseStreak = 0;
      this._nonCourseStartedAt = 0;
      this._lastInteraction = "";
      this._lastInteractionAt = 0;
    }

    let state;
    try {
      state = this.repo.getState(id);
      // 已完成且总结齐备的会话直接返回（幂等，避免重复导出）；
      // 但"总结失败的 complete 会话"必须放行重试，否则 complete 会永久掩盖缺失的总结
      if (state.status === "complete" && !state.summary_error) return state;
      // 需要（重）生成总结：尚未真的产出过 summary（新会话、或总结途中崩溃遗留的
      // finalizing/failed 会话），或上次总结失败留下了 summary_error。
      // summary 完好而 status 是 finalizing/failed 时才是纯导出环节失败，沿用已有 summary 直接重导。
      const needSummary = needsSummaryRerun(state);
      // 关键：置 finalizing 必须发生在 _generateFinalSummary 之前。总结是串行 N 次 LLM
      // 调用（每次上限 CHAT_TIMEOUT_MS），期间若 status 仍是 recording，
      // repo.findRecordingSession() 会把正在结稿的会话再"收养"回去 → 新转写写进已总结的
      // transcript.md（导出稿看不到），随后 appendTranscript 因状态断言全部抛错。
      state.status = "finalizing";
      state.error = null;
      this.repo.saveState(id, state);
      if (needSummary) await this._generateFinalSummary(id);
    } catch (e) {
      // state.json 损坏/磁盘错误：不能变成调用方的 unhandledRejection，
      // 记日志并尽力把会话置为 failed（置失败本身也可能因磁盘问题再抛，兜底返回 null）
      console.error("[courses] 结束会话失败:", e?.message || e);
      try {
        const failed = this.repo.getState(id);
        failed.status = "failed";
        failed.error = `${e.name || "Error"}: ${e.message || e}`;
        this.repo.saveState(id, failed);
        this.emit("session-failed", failed);
      } catch (e2) {
        console.error("[courses] 标记会话 failed 失败:", e2?.message || e2);
      }
      return null;
    }
    try {
      const outputPath = this._exportMarkdown(id);
      state = this.repo.getState(id);
      state.status = "complete";
      state.output_path = outputPath;
      this.repo.saveState(id, state);
      this.emit("session-finished", state);
      return state;
    } catch (e) {
      state = this.repo.getState(id);
      state.status = "failed";
      state.error = `${e.name || "Error"}: ${e.message || e}`;
      this.repo.saveState(id, state);
      this.emit("session-failed", state);
      return state;
    }
  }

  // 分块总结：单块直接终稿；多块逐块提取后拼接再终稿；截 6000 存 state.summary。
  // 失败时不抛错（不阻断导出），但一定留日志 + 写 state.summary_error（可诊断、可重试）。
  async _generateFinalSummary(id) {
    const text = this.repo.readTranscript(id).trim();
    if (!text) {
      // 无转写 = 没有可总结的内容，不算"总结缺失"；顺手清掉历史失败标记，
      // 免得这类会话被 recoverable() 永久判为待重试
      const empty = this.repo.getState(id);
      if (empty.summary_error) {
        empty.summary_error = null;
        this.repo.saveState(id, empty);
      }
      this.repo.clearSummaryChunkCache(id); // 无内容可总结 → 陈旧块缓存没有留存意义
      return;
    }
    try {
      const chunks = transcript.splitTranscript(text);
      let source;
      if (chunks.length === 1) {
        source = chunks[0];
      } else {
        // 块级结果逐块落盘暂存：任一块遇 429/超时/Key 失效时，重试跳过已成功的块，
        // 不再把前 N-1 块的钱和时间重花一遍。缓存缺失（老会话）等价于全部重跑。
        const cache = this.repo.readSummaryChunkCache(id, chunks.length);
        const extracted = [];
        let reused = 0;
        for (let i = 0; i < chunks.length; i++) {
          const cached = this.repo.cachedChunkSummary(cache, i, chunks[i]);
          if (cached) {
            extracted.push(cached);
            reused += 1;
            continue;
          }
          const part = await this._askSummarizer(prompts.buildCourseChunkPrompt(chunks[i]));
          this.repo.saveSummaryChunk(cache, id, i, chunks[i], part);
          extracted.push(part);
        }
        if (reused) {
          console.warn(
            `[courses/manager] 会话 ${id} 复用了 ${reused}/${chunks.length} 块上次已成功的分块提取结果`
          );
        }
        source = extracted.filter(Boolean).join("\n");
      }
      let summary = await this._askSummarizer(
        prompts.buildFinalCourseSummaryPrompt(source)
      );
      const headings = [];
      for (const m of summary.matchAll(/^###\s+(.+)$/gm)) headings.push(m[1]);
      if (
        headings.length === 1 &&
        headings[0] === "课程概览" &&
        !summary.includes("尚未进入具体知识讲解")
      ) {
        summary += "\n\n本段尚未进入具体知识讲解。";
      }
      const state = this.repo.getState(id);
      state.summary = summary.slice(0, SUMMARY_LIMIT);
      state.summary_error = null; // 重试成功后必须清掉失败标记
      this.repo.saveState(id, state);
      // 终稿已落盘 → 块级缓存使命结束，立刻删除（不让它成为第 4 个只增不减的写入）
      this.repo.clearSummaryChunkCache(id);
    } catch (e) {
      // 总结失败不阻断导出，但绝不能静默：summary-failed 事件目前没有监听者，
      // 只发事件等于失败消失（导出稿缺"课程总结"小节、state 却是 complete）。
      const message = (e && e.message) || String(e);
      if (isExpectedSummaryError(e)) {
        console.warn(
          `[courses/manager] 生成课程总结失败（会话 ${id}），本次导出无总结小节、可稍后重试:`,
          message
        );
      } else {
        console.error(
          `[courses/manager] 生成课程总结时发生意外异常（会话 ${id}），` +
            "本次导出无总结小节、可稍后重试:",
          (e && e.stack) || e
        );
      }
      // 把失败事实落进 state：导出稿据此写明"总结生成失败"，
      // repo.recoverable() 据此把 complete 会话也列为可重试
      try {
        const state = this.repo.getState(id);
        state.summary_error = `${(e && e.name) || "Error"}: ${message}`.slice(
          0,
          SUMMARY_ERROR_LIMIT
        );
        this.repo.saveState(id, state);
      } catch (e2) {
        console.error(
          `[courses/manager] 记录会话 ${id} 的总结失败标记时出错（该会话将无法被识别为待重试）:`,
          (e2 && e2.stack) || e2
        );
      }
      this.emit("summary-failed", { id, error: message });
    }
  }

  // 调用云端模型做总结：纯文本对话，剥掉可能的代码围栏
  async _askSummarizer(instruction) {
    const providerCfg = providers.getChatProvider();
    if (!providerCfg) throw new Error("尚未配置 LLM 提供商，请先在设置中添加");
    let text = await providers.chat({
      providerCfg,
      messages: [{ role: "user", content: instruction }],
      maxTokens: 2000,
      timeoutMs: CHAT_TIMEOUT_MS,
    });
    text = String(text || "")
      .trim()
      .replace(/^```(?:markdown)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    if (!text) throw new Error("course summary response is empty");
    return text;
  }

  // Markdown 导出（格式照 jarvis MarkdownRenderer）：
  // 桌面/QQ-Courses/<id>/README.md，frames 复制到 images/
  _exportMarkdown(id) {
    const state = this.repo.getState(id);
    const lines = [
      `# ${state.title}`,
      "",
      `- Session: \`${state.id}\``,
      `- Created: ${state.created_at}`,
      "",
    ];
    if (state.summary) {
      lines.push("## 课程总结", "", state.summary, "");
    } else if (state.summary_error) {
      // 总结缺失必须写进导出稿：只省掉小节的话，用户看到的是一份"没有总结的完整课程"，
      // 完全无从知道少了什么、更不知道可以重试
      lines.push(
        "## 课程总结",
        "",
        `> 总结生成失败：${state.summary_error}`,
        ">",
        "> 原始转写仍保存在本地课程会话目录，修好上述原因后可重新生成总结。",
        ""
      );
    }
    const outDir = path.join(this._desktopPath(), "QQ-Courses", state.id);
    const assetDir = path.join(outDir, "images");
    fs.mkdirSync(assetDir, { recursive: true });
    if (state.keyframes && state.keyframes.length) {
      lines.push("## Keyframes", "");
      for (const frame of state.keyframes) {
        const source = path.join(this.repo._framesDir(id), frame.filename);
        const target = path.join(assetDir, frame.filename);
        atomicWrite(target, fs.readFileSync(source));
        const seconds = (frame.timestamp_ms / 1000).toFixed(3);
        lines.push(
          `### ${seconds}s`,
          "",
          `![Keyframe at ${seconds}s](images/${frame.filename})`,
          ""
        );
        const note = String((frame.metadata || {}).note || "").trim();
        if (note) lines.push(`**画面说明：** ${note}`, "");
      }
    }
    const destination = path.join(outDir, "README.md");
    atomicWrite(destination, lines.join("\n").replace(/\s+$/, "") + "\n");
    this._warnIfExportOverflow(path.join(this._desktopPath(), "QQ-Courses"));
    return destination;
  }

  // 导出根目录：生产走 desktopPath()，测试可注入 desktopDir 避免写进真实桌面
  _desktopPath() {
    return this._desktopDir || desktopPath();
  }

  // 桌面导出目录只做上限告知：超过 MAX_EXPORTED_COURSES 就提示用户清理。
  // 不主动删除——桌面文件是用户可见资产，删除不可逆。
  _warnIfExportOverflow(coursesRoot) {
    let count = 0;
    try {
      count = fs.readdirSync(coursesRoot).length;
    } catch (e) {
      console.warn("[courses] 统计桌面导出目录失败:", e?.message || e);
      return 0;
    }
    if (count > MAX_EXPORTED_COURSES) {
      console.warn(
        `[courses] 桌面 QQ-Courses 已有 ${count} 个课程目录（超过提示上限 ` +
          `${MAX_EXPORTED_COURSES}），请自行清理不再需要的导出以释放磁盘`
      );
      // 只 console.warn 等于没有护栏（用户看不到日志）。这里复用课程互动已在用的
      // openSpeak 气泡——本模块唯一现成的用户可见通道，不新造机制。
      // 每进程只提示一次：每次导出都弹会变成骚扰（一节课结束就导出一次）；
      // 重启后允许再提示一次，正好覆盖"用户一直没清理"的情形。
      if (!this._exportOverflowNotified) {
        this._exportOverflowNotified = true;
        speakBubble(
          `桌面的 QQ-Courses 里已经堆了 ${count} 个课程记录啦，` +
            "有空清理一下不需要的吧～（我不会自己删你的桌面文件哦）"
        );
      }
    }
    return count;
  }

  recoverable() {
    return this.repo.recoverable();
  }
}

module.exports = {
  CourseManager,
  needsSummaryRerun,
  STARTUP_RECOVERY_DELAY_MS,
  MAX_RECOVERY_PER_STARTUP,
  MAX_EXPORTED_COURSES,
};
