// 课程会话仓库：移植 jarvis courses/core.py 的 CourseRepository / CourseSession。
// 目录结构：<root>/<id>/{state.json, transcript.md（追加+fsync）, frames/}
// state.json 原子写（tmp+fsync+rename）；root 默认 userData/courses/sessions，
// Electron 惰性获取，无 Electron 环境退回 cwd 便于单测。
const _require = eval("require");
const fs = _require("fs");
const path = _require("path");
const crypto = _require("crypto");

// —— 磁盘增长边界常量（会话目录 / 关键帧 / 转写都是只增不减的写入，必须有上界）——
// 本地保留的会话总数上限。依据：每天最多几节课，20 个会话约覆盖 2~3 周；
// 更早的会话已导出到桌面 QQ-Courses/<id>/README.md，本地副本无需长留。
const MAX_SESSION_COUNT = 20;
// 单会话关键帧张数上限（原为 addKeyframe 内的字面量 40，与 manager.MAX_KEYFRAMES 同源）
const MAX_KEYFRAMES_PER_SESSION = 40;
// 单会话 frames/ 总字节上限。依据：关键帧由 aiWiring 以 maxWidth=1280 截屏为 PNG，
// 单张约 0.6 MiB，40 张 ≈ 24 MiB → 以此兜住最坏情况（超限后拒绝新帧）。
const FRAMES_MAX_TOTAL_BYTES = 24 * 1024 * 1024;
// 单会话 transcript.md 字节上限。依据：课程感知约 2 秒一轮、每轮追加约 100 字节
// → 约 180 KB/小时，2 MiB 约覆盖 11 小时连续录制，超限后停止追加并告警。
const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

function isoNow() {
  return new Date().toISOString(); // 形如 2026-07-28T09:05:56.230Z
}

// 原子写：同目录临时文件 + fsync + rename，崩溃不留半截文件
function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw e;
  }
}

function atomicJson(filePath, value) {
  atomicWrite(filePath, JSON.stringify(value, null, 2) + "\n");
}

// 会话根目录：Electron 下 userData/courses/sessions；无 Electron 退 cwd（单测用）
function defaultRoot() {
  try {
    const { app } = _require("electron");
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), "courses", "sessions");
    }
  } catch (e) {}
  return path.join(process.cwd(), "courses", "sessions");
}

class CourseRepo {
  // options.* 仅用于注入测试用的小阈值，生产不传，走上方常量
  constructor(root, options = {}) {
    this.root = root || defaultRoot();
    this.maxSessionCount =
      options.maxSessionCount > 0 ? options.maxSessionCount : MAX_SESSION_COUNT;
    this.maxKeyframes = options.maxKeyframes > 0 ? options.maxKeyframes : MAX_KEYFRAMES_PER_SESSION;
    this.framesMaxTotalBytes =
      options.framesMaxTotalBytes > 0 ? options.framesMaxTotalBytes : FRAMES_MAX_TOTAL_BYTES;
    this.transcriptMaxBytes =
      options.transcriptMaxBytes > 0 ? options.transcriptMaxBytes : TRANSCRIPT_MAX_BYTES;
    fs.mkdirSync(this.root, { recursive: true });
  }

  _sessionDir(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id || ""))) {
      throw new Error(`invalid session id: ${id}`);
    }
    return path.join(this.root, String(id));
  }

  _statePath(id) {
    return path.join(this._sessionDir(id), "state.json");
  }

  _transcriptPath(id) {
    return path.join(this._sessionDir(id), "transcript.md");
  }

  _framesDir(id) {
    return path.join(this._sessionDir(id), "frames");
  }

  // 新建会话：status=recording，transcript.md 置空，frames/ 就位
  createSession({ title, sessionId } = {}) {
    title = String(title || "").trim();
    if (!title) throw new Error("title must be non-empty");
    const id = sessionId || crypto.randomBytes(16).toString("hex");
    const dir = this._sessionDir(id);
    fs.mkdirSync(this._framesDir(id), { recursive: true });
    const now = isoNow();
    const state = {
      id,
      title,
      status: "recording", // recording → finalizing → complete | failed
      created_at: now,
      updated_at: now,
      summary: "",
      keyframes: [], // [{filename, timestamp_ms, metadata:{note}}]
      error: null,
      output_path: null,
    };
    atomicJson(this._statePath(id), state);
    atomicWrite(this._transcriptPath(id), "");
    this._pruneOldSessions(id);
    return state;
  }

  // 会话总数上限裁剪：超过 maxSessionCount 时按 created_at 升序删除最旧的会话目录。
  // 正在 recording 的会话与 keepId 不删（可能正被写入）；若剩余全不可删只告警，不强删。
  _pruneOldSessions(keepId) {
    let sessions;
    try {
      sessions = this.listSessions();
    } catch (e) {
      console.error("[courses/repo] 会话裁剪前列举失败，跳过本次裁剪:", e && e.stack ? e.stack : e);
      return 0;
    }
    let overflow = sessions.length - this.maxSessionCount;
    if (overflow <= 0) return 0;
    const removable = sessions
      .filter((s) => s && s.id && s.id !== keepId && s.status !== "recording")
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    let removed = 0;
    for (const session of removable) {
      if (overflow <= 0) break;
      try {
        fs.rmSync(this._sessionDir(session.id), { recursive: true, force: true });
        removed += 1;
        overflow -= 1;
        console.warn(
          `[courses/repo] 会话数超过上限 ${this.maxSessionCount}，已清理最旧会话 ${session.id}`
        );
      } catch (e) {
        // 单个目录删不掉（占用/权限）不影响继续清理下一个，但必须留完整堆栈
        console.error(
          `[courses/repo] 清理会话 ${session.id} 失败:`,
          e && e.stack ? e.stack : e
        );
      }
    }
    if (overflow > 0) {
      console.warn(
        `[courses/repo] 仍有 ${overflow} 个会话超出上限（录制中或删除失败），本次未清理`
      );
    }
    return removed;
  }

  // 读取会话状态；state.json 损坏时记完整堆栈并抛出可识别错误。
  // 单个会话不可用，但 listSessions / recoverable 会跳过它，不阻断整条链路。
  getState(id) {
    const raw = fs.readFileSync(this._statePath(id), "utf8");
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error(
        `[courses/repo] state.json 解析失败（会话 ${id}），该会话已跳过:`,
        e && e.stack ? e.stack : e
      );
      throw new Error(`course state.json corrupted: ${id}`);
    }
  }

  saveState(id, state) {
    state.updated_at = isoNow();
    atomicJson(this._statePath(id), state);
    return state;
  }

  readTranscript(id) {
    try {
      return fs.readFileSync(this._transcriptPath(id), "utf8");
    } catch (e) {
      return "";
    }
  }

  // 单个文件的已占用字节数；不存在按 0 计
  _fileBytes(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch (e) {
      if (e && e.code === "ENOENT") return 0;
      console.warn(`[courses/repo] 读取 ${path.basename(filePath)} 大小失败，按 0 计:`, e.message || e);
      return 0;
    }
  }

  // frames/ 已占用总字节。O(n) 遍历可接受：n ≤ maxKeyframes（40），且每会话最多调 40 次
  _framesTotalBytes(id) {
    const dir = this._framesDir(id);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      if (e && e.code === "ENOENT") return 0;
      console.error(
        `[courses/repo] 统计会话 ${id} 的 frames/ 占用失败，按 0 计:`,
        e && e.stack ? e.stack : e
      );
      return 0;
    }
    let total = 0;
    for (const name of names) total += this._fileBytes(path.join(dir, name));
    return total;
  }

  // 追加转写文本：保证换行结尾，写后立即 fsync 落盘。
  // 超过 transcriptMaxBytes 后丢弃本次追加并告警——录制不该因为文本超长而中断。
  appendTranscript(id, deltaText) {
    const state = this.getState(id);
    if (state.status !== "recording") {
      throw new Error("session is not recording");
    }
    let text = String(deltaText || "");
    if (text && !text.endsWith("\n")) text += "\n";
    const transcriptPath = this._transcriptPath(id);
    if (
      this._fileBytes(transcriptPath) + Buffer.byteLength(text, "utf8") >
      this.transcriptMaxBytes
    ) {
      console.warn(
        `[courses/repo] 会话 ${id} 的 transcript.md 已达 ${this.transcriptMaxBytes} 字节上限，` +
          "本次追加已丢弃"
      );
      return state;
    }
    const fd = fs.openSync(transcriptPath, "a");
    try {
      fs.writeSync(fd, text, null, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return this.saveState(id, state);
  }

  // 关键帧入库：PNG 原字节写入 frames/，文件名 {序号:06d}-{timestamp_ms:012d}.png
  addKeyframe(id, { timestampMs, pngBuffer, note } = {}) {
    const state = this.getState(id);
    if (state.status !== "recording") {
      throw new Error("session is not recording");
    }
    // 兜底上限（正常由 manager._requestKeyframe 节流挡住，这里防直接调用绕过）
    if (state.keyframes.length >= this.maxKeyframes) {
      throw new Error("keyframe limit reached");
    }
    const buffer = Buffer.isBuffer(pngBuffer) ? pngBuffer : Buffer.from(pngBuffer || []);
    if (!(timestampMs >= 0) || !buffer.length) {
      throw new Error("timestamp must be non-negative and frame non-empty");
    }
    // 字节上限：单张 PNG 体积不可控（分辨率/内容），只靠张数挡不住磁盘增长
    if (this._framesTotalBytes(id) + buffer.length > this.framesMaxTotalBytes) {
      throw new Error("keyframe size limit reached");
    }
    const number = state.keyframes.length + 1;
    const filename =
      `${String(number).padStart(6, "0")}-` +
      `${String(Math.floor(timestampMs)).padStart(12, "0")}.png`;
    atomicWrite(path.join(this._framesDir(id), filename), buffer); // 原字节，不转码
    const item = {
      filename,
      timestamp_ms: Math.floor(timestampMs),
      metadata: { note: String(note || "").trim().slice(0, 300) },
    };
    state.keyframes.push(item);
    this.saveState(id, state);
    return item;
  }

  // 全部会话（按目录名排序），返回 state 数组；损坏的目录跳过并告警（不静默吞）
  listSessions() {
    const out = [];
    for (const name of fs.readdirSync(this.root).sort()) {
      try {
        if (fs.statSync(path.join(this.root, name)).isDirectory()) {
          out.push(this.getState(name));
        }
      } catch (e) {
        // 单个会话缺 state.json / JSON 损坏不能拖垮整个列表，但必须告警
        console.warn(`[courses/repo] 跳过无法读取的会话目录 ${name}: ${e.message || e}`);
      }
    }
    return out;
  }

  // 最近一个仍在录制中的会话（对应 jarvis recording[-1]）
  findRecordingSession() {
    const recording = this.listSessions().filter((s) => s.status === "recording");
    return recording.length ? recording[recording.length - 1] : null;
  }

  // 可恢复会话：finalizing/failed 状态可重试 finalize
  recoverable() {
    return this.listSessions().filter(
      (s) => s.status === "finalizing" || s.status === "failed"
    );
  }
}

module.exports = {
  CourseRepo,
  atomicWrite,
  atomicJson,
  MAX_SESSION_COUNT,
  MAX_KEYFRAMES_PER_SESSION,
  FRAMES_MAX_TOTAL_BYTES,
  TRANSCRIPT_MAX_BYTES,
};
