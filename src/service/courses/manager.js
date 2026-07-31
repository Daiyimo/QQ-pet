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
const SUMMARY_LIMIT = 6000;
const CHAT_TIMEOUT_MS = 120000;
// 桌面导出目录（桌面/QQ-Courses）的课程数上限提示。依据：桌面是用户可见资产，
// 删除不可逆，这里只在超限时告警提示用户自行清理，不代替用户删桌面文件。
// 取 30 与本地会话上限（repo.MAX_SESSION_COUNT=20）留出余量，避免刚导出就刷告警。
const MAX_EXPORTED_COURSES = 30;

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

function speakBubble(text) {
  if (typeof openSpeak !== "function") return;
  openSpeak({
    data: { type: "text", data: text, submitText: "" },
    nextActiveStr: "speak",
  });
}

class CourseManager extends EventEmitter {
  constructor({ repo } = {}) {
    super();
    this.repo = repo || new CourseRepo();
    this.currentSession = null; // 当前录制中的 state 快照（含 manual 标记）
    this._lastTranscript = ""; // 上一轮全量转写（增量提取基准）
    this._lastNote = ""; // 上一条入库笔记（连续去重）
    this._lastInteraction = "";
    this._lastInteractionAt = 0;
    this._keyframeRequestedAt = 0;
    this._nonCourseStreak = 0;
    this._nonCourseStartedAt = 0;
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
    this.emit("session-started", state);
    return state;
  }

  // 感知模块确认 course 场景后的入口（payload 为统一感知 JSON 的课程字段）
  handleCoursePerception(result = {}) {
    this._nonCourseStreak = 0;
    this._nonCourseStartedAt = 0;

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

  // 非 course 场景计数：连续 4 次且距首次 ≥90s 自动结束（仅自动会话）
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

  // 结束会话：生成总结 → finalizing → 导出 Markdown → complete；失败 → failed（可重试）
  async finishSession(sessionId) {
    const session = this.currentSession;
    const id = sessionId || (session && session.id);
    if (!id) return null;
    if (session && session.id === id) {
      this.currentSession = null;
      this._nonCourseStreak = 0;
      this._nonCourseStartedAt = 0;
      this._lastInteraction = "";
      this._lastInteractionAt = 0;
    }

    let state = this.repo.getState(id);
    // 已完成的会话直接返回（幂等，避免重复导出）
    if (state.status === "complete") return state;
    // 录制中的会话先生成终稿总结（finalizing/failed 重试时跳过，沿用已有 summary）
    if (state.status === "recording") {
      await this._generateFinalSummary(id);
      state = this.repo.getState(id);
    }

    state.status = "finalizing";
    state.error = null;
    this.repo.saveState(id, state);
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

  // 分块总结：单块直接终稿；多块逐块提取后拼接再终稿；截 6000 存 state.summary
  async _generateFinalSummary(id) {
    const text = this.repo.readTranscript(id).trim();
    if (!text) return;
    try {
      const chunks = transcript.splitTranscript(text);
      let source;
      if (chunks.length === 1) {
        source = chunks[0];
      } else {
        const extracted = [];
        for (const chunk of chunks) {
          extracted.push(await this._askSummarizer(prompts.buildCourseChunkPrompt(chunk)));
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
      this.repo.saveState(id, state);
    } catch (e) {
      // 总结失败不阻断导出，仅上报（jarvis 同样只发 course.summary.failed 事件）
      this.emit("summary-failed", { id, error: e.message || String(e) });
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
    }
    const outDir = path.join(desktopPath(), "QQ-Courses", state.id);
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
    this._warnIfExportOverflow(path.join(desktopPath(), "QQ-Courses"));
    return destination;
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
    }
    return count;
  }

  recoverable() {
    return this.repo.recoverable();
  }
}

module.exports = { CourseManager };
