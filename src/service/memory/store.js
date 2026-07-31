// 记忆存储层：移植自 jarvis_backend/memory/store.py。
// 目录结构：userData/memory/{events.jsonl,summary.json,facts.json,daily/,daily-images/}
// 所有写操作均为原子写（tmp + fsync + rename），事件日志为追加式 JSONL。
// 本文件只依赖 Node 内置模块，Electron 惰性获取（普通 node 下可直接 require 单测）。
// 注意：本文件必须保持普通 require —— 间接动态 require 的写法与原子写逻辑组合
// 会被本机安全软件误判删除（实测），请勿改动。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// —— 磁盘增长边界：事件日志轮转（追加式 JSONL 无上界会长期吃满磁盘）——
// 现役 events.jsonl 的字节上限。依据：入库门槛（confidence≥0.6 + 同场景 120s 节流
// + 900s 相似去重）下估算约 720 事件/天，单条事件 JSON 约 400 字节 → 约 280 KB/天，
// 4 MiB 约覆盖 14 天原始事件，足够 daily 总结回补最近若干历史天。
const EVENTS_MAX_BYTES = 4 * 1024 * 1024;
// 轮转归档保留份数（events.1.jsonl … events.<KEEP>.jsonl）。依据：更早的原始事件
// 已被 daily/<day>.md 摘要固化，归档只用于故障排查；
// 磁盘上界 = (KEEP + 1) × EVENTS_MAX_BYTES = 12 MiB（约 42 天）。
const EVENTS_ROTATE_KEEP = 2;
// JSONL 行分隔符字节（按字节切行，避免多字节字符在增量读边界被截断）
const NEWLINE_BYTE = 0x0a;

// 记忆根目录：Electron 下取 userData/memory；普通 node（单测）退到 cwd/memory
function defaultMemoryRoot() {
  try {
    const app = require("electron").app;
    if (app && app.getPath) return path.join(app.getPath("userData"), "memory");
  } catch (e) {
    // 无 Electron（单测/纯 node）属预期分支，退回 cwd 继续跑
    console.warn(
      "[memory/store] 未取到 Electron userData，记忆根目录退回 cwd/memory:",
      e && e.message ? e.message : e
    );
  }
  return path.join(process.cwd(), "memory");
}

// —— 时间工具（UTC ISO 落盘，本地时区划分"天"）——
function pad2(n) {
  return String(n).padStart(2, "0");
}

// Date → UTC ISO（YYYY-MM-DDTHH:mm:ss.sssZ），与 jarvis 的 _iso 等价
function toUtcIso(date) {
  return date.toISOString();
}

// Date → 本地 "YYYY-MM-DD"
function localDayString(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// Date → 本地 "HH:MM"
function localTimeString(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function isValidDay(day) {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day);
}

// —— 原子写：先写同目录临时文件并 fsync，再 rename 覆盖 ——
function atomicWriteBuffer(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`
  );
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, buffer);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (e2) {
      // 清理失败只影响残留一个 .tmp 文件，原始写入错误照常抛给调用方
      console.warn(
        `[memory/store] 原子写失败后清理临时文件 ${path.basename(tmp)} 失败:`,
        e2 && e2.message ? e2.message : e2
      );
    }
    throw e;
  }
}

function atomicWriteText(filePath, text) {
  // jarvis 的 _atomic_text：内容去尾部空白后补一个换行
  atomicWriteBuffer(filePath, Buffer.from(String(text).replace(/\s+$/, "") + "\n", "utf8"));
}

function atomicWriteJson(filePath, value) {
  atomicWriteBuffer(
    filePath,
    Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8")
  );
}

class MemoryStore {
  // options.eventsMaxBytes / options.eventsRotateKeep 仅用于注入测试用的小阈值，
  // 生产不传，走 EVENTS_MAX_BYTES / EVENTS_ROTATE_KEEP 常量
  constructor(root, options = {}) {
    this.root = root || defaultMemoryRoot();
    this.eventsMaxBytes = options.eventsMaxBytes > 0 ? options.eventsMaxBytes : EVENTS_MAX_BYTES;
    this.eventsRotateKeep =
      options.eventsRotateKeep > 0 ? options.eventsRotateKeep : EVENTS_ROTATE_KEEP;
    this.eventsPath = path.join(this.root, "events.jsonl");
    this.summaryPath = path.join(this.root, "summary.json");
    this.factsPath = path.join(this.root, "facts.json");
    this.dailyRoot = path.join(this.root, "daily");
    this.dailyImagesRoot = path.join(this.root, "daily-images");
    // 事件索引缓存（结构见 _loadEventsIndex 的注释，失效策略同处说明）
    this._events_cache = null;
    fs.mkdirSync(this.root, { recursive: true });
  }

  // 轮转归档路径：events.1.jsonl（最新归档）… events.<EVENTS_ROTATE_KEEP>.jsonl（最旧）
  _eventsArchivePath(n) {
    return path.join(this.root, `events.${n}.jsonl`);
  }

  // 追加前检查轮转：现役文件 + 本次行超过 EVENTS_MAX_BYTES 就把 events.jsonl 归档。
  // 归档全部用 rename（原子操作，与本文件其他写入的原子写风格一致），最旧的一份丢弃。
  _rotateEventsIfNeeded(incomingBytes) {
    let size = 0;
    try {
      size = fs.statSync(this.eventsPath).size;
    } catch (e) {
      if (!e || e.code !== "ENOENT") {
        // 首次写入时文件不存在属正常；其余错误不能静默，记完整堆栈后跳过本次轮转
        console.error(
          "[memory/store] 轮转前读取 events.jsonl 大小失败，跳过本次轮转:",
          e && e.stack ? e.stack : e
        );
      }
      return false;
    }
    if (size + incomingBytes <= this.eventsMaxBytes) return false;
    try {
      // 从最旧往回搬：超出保留份数的直接删，其余依次后移，最后现役文件 → events.1.jsonl
      fs.rmSync(this._eventsArchivePath(this.eventsRotateKeep), { force: true });
      for (let n = this.eventsRotateKeep - 1; n >= 1; n--) {
        const from = this._eventsArchivePath(n);
        if (fs.existsSync(from)) fs.renameSync(from, this._eventsArchivePath(n + 1));
      }
      fs.renameSync(this.eventsPath, this._eventsArchivePath(1));
      this._events_cache = null; // 现役文件已被换掉，索引缓存整体失效
      console.warn(
        `[memory/store] events.jsonl 达到 ${this.eventsMaxBytes} 字节上限，已轮转归档` +
          `（保留 ${this.eventsRotateKeep} 份）`
      );
      return true;
    } catch (e) {
      // 轮转失败不能吞掉待写入的事件：记完整堆栈后继续追加，下次写入再尝试轮转
      console.error(
        "[memory/store] events.jsonl 轮转失败，本次继续追加写:",
        e && e.stack ? e.stack : e
      );
      return false;
    }
  }

  // 追加一条事件：{id, timestamp(UTC ISO Z), kind, text, metadata}
  appendEvent({ kind, text, metadata, timestamp, eventId }) {
    if (!String(kind || "").trim() || !String(text || "").trim()) {
      throw new Error("kind and text must be non-empty");
    }
    const event = {
      id: eventId || crypto.randomUUID().replace(/-/g, ""),
      timestamp: toUtcIso(timestamp ? new Date(timestamp) : new Date()),
      kind: String(kind),
      text: String(text),
      metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
    };
    const line = JSON.stringify(event) + "\n";
    this._rotateEventsIfNeeded(Buffer.byteLength(line, "utf8"));
    // 追加写 + fsync，保证崩溃安全
    const fd = fs.openSync(this.eventsPath, "a");
    try {
      fs.writeSync(fd, line, null, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return event;
  }

  // 事件索引（进程内缓存 this._events_cache）：
  //   {ino, size, lineNo, pendingBuf, events:[], byDay: Map<"YYYY-MM-DD", event[]>}
  // 失效策略：每次读取前 statSync 比对 (ino, size)——
  //   ino 变化（轮转后新建的现役文件）或 size 变小（截断/外部改写）→ 整体重建；
  //   size 变大 → 只读取 [cache.size, size) 的新增尾部并增量解析；size 相等 → 直接复用。
  // 选型依据见 readEvents 上方注释。内存上界由 EVENTS_MAX_BYTES 封顶
  //（只缓存现役文件，归档 events.N.jsonl 不入缓存）。
  _loadEventsIndex() {
    const emptyIndex = () => ({
      ino: -1,
      size: 0,
      lineNo: 0,
      pendingBuf: null,
      events: [],
      byDay: new Map(),
    });
    let st;
    try {
      st = fs.statSync(this.eventsPath);
    } catch (e) {
      if (e && e.code === "ENOENT") {
        this._events_cache = null; // 文件被删/尚未创建：缓存作废，按空事件集返回
        return emptyIndex();
      }
      // 非"文件不存在"的意外错误：降级为空事件集，但必须留完整堆栈
      console.error(
        "[memory/store] 读取 events.jsonl 状态失败，本次按空事件集降级:",
        e && e.stack ? e.stack : e
      );
      return emptyIndex();
    }

    const cache = this._events_cache;
    const canReuse = !!cache && cache.ino === st.ino && st.size >= cache.size;
    if (canReuse && st.size === cache.size) return cache;
    const index = canReuse ? cache : Object.assign(emptyIndex(), { ino: st.ino });

    // 只读现役文件在 [index.size, st.size) 的增量区间
    const length = st.size - index.size;
    let chunk;
    try {
      const buf = Buffer.alloc(length);
      const fd = fs.openSync(this.eventsPath, "r");
      try {
        let offset = 0;
        while (offset < length) {
          const read = fs.readSync(fd, buf, offset, length - offset, index.size + offset);
          if (read <= 0) break; // 读到文件尾（并发追加导致的短读），本次只处理已读到的字节
          offset += read;
        }
        chunk = offset === length ? buf : buf.subarray(0, offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      console.error(
        "[memory/store] 读取 events.jsonl 增量失败，沿用上次索引:",
        e && e.stack ? e.stack : e
      );
      return canReuse ? cache : emptyIndex();
    }

    // pendingBuf：上一次读到的、还没等到换行的尾部字节（断电残留半行 / 增量读边界）
    const data = index.pendingBuf ? Buffer.concat([index.pendingBuf, chunk]) : chunk;
    let start = 0;
    let nl;
    while ((nl = data.indexOf(NEWLINE_BYTE, start)) !== -1) {
      index.lineNo += 1;
      const line = data.subarray(start, nl).toString("utf8").trim();
      start = nl + 1;
      if (line) this._indexEventLine(index, line, index.lineNo);
    }
    index.pendingBuf = start < data.length ? data.subarray(start) : null;
    index.size += chunk.length;
    this._events_cache = index;
    return index;
  }

  // 解析并索引一行事件；损坏行跳过并告警，不拖垮整个文件的读取
  _indexEventLine(index, line, lineNo) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (e) {
      // 单行损坏（如异常断电残留半行）跳过并告警，不拖垮整天读取
      console.warn(`[memory/store] 跳过损坏的事件行 ${lineNo}: ${e.message}`);
      return;
    }
    if (!event || typeof event !== "object") {
      console.warn(`[memory/store] 跳过非对象的事件行 ${lineNo}`);
      return;
    }
    index.events.push(event);
    const day = localDayString(new Date(event.timestamp));
    if (!isValidDay(day)) {
      console.warn(`[memory/store] 事件行 ${lineNo} 时间戳无法归日，不进按天索引:`, event.timestamp);
      return;
    }
    const bucket = index.byDay.get(day);
    if (bucket) bucket.push(event);
    else index.byDay.set(day, [event]);
  }

  // 读取事件；day 为本地 "YYYY-MM-DD" 时只返回当天事件（按本地时区归日）。
  // 方案：按天索引 + 增量尾部读缓存（见 _loadEventsIndex）。
  //   选它——events.jsonl 是追加式、时间单调的日志，稳态下每次读只需解析新追加的字节，
  //   按天查询退化为 Map 命中 O(1)+O(当天条数)，memoryDays 也不再解析全量。
  //   不选"按天分片文件（daily-events/<day>.jsonl）"——要改落盘格式并迁移历史文件，
  //   轮转语义也要重定义，改动面远超本次需要。
  //   不选"磁盘上的天→偏移索引文件"——索引与日志的一致性需要额外崩溃安全设计
  //   （索引落后/损坏时仍要回退全扫），复杂度更高而收益与进程内缓存相同（本应用为长驻单进程）。
  // 返回的数组是副本，但事件对象与索引缓存共享——调用方只读，不要就地修改。
  readEvents({ day } = {}) {
    const index = this._loadEventsIndex();
    if (day && isValidDay(day)) {
      const bucket = index.byDay.get(day);
      return bucket ? bucket.slice() : [];
    }
    return index.events.slice();
  }

  // 聚合所有"有记忆的天"：事件 + daily/*.md + daily-images/<day>/ 的并集，倒序
  memoryDays() {
    const days = new Set();
    // 直接取按天索引的键，不再解析全量事件
    for (const day of this._loadEventsIndex().byDay.keys()) days.add(day);
    if (fs.existsSync(this.dailyRoot)) {
      for (const name of fs.readdirSync(this.dailyRoot)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
        if (m) days.add(m[1]);
      }
    }
    if (fs.existsSync(this.dailyImagesRoot)) {
      for (const name of fs.readdirSync(this.dailyImagesRoot)) {
        if (
          isValidDay(name) &&
          fs.statSync(path.join(this.dailyImagesRoot, name)).isDirectory()
        ) {
          days.add(name);
        }
      }
    }
    return [...days].sort().reverse();
  }

  dailyPath(day) {
    if (!isValidDay(day)) throw new Error(`invalid day: ${day}`);
    return path.join(this.dailyRoot, `${day}.md`);
  }

  writeDaily(day, markdown) {
    const p = this.dailyPath(day);
    atomicWriteText(p, markdown);
    return p;
  }

  readDaily(day) {
    const p = this.dailyPath(day);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  }

  // 日程信息图落盘：daily-images/<day>/<filename> + 同名 .json 元数据（均原子写）
  writeDailyImage(day, filename, content, metadata) {
    if (!isValidDay(day)) throw new Error(`invalid day: ${day}`);
    if (!/^[A-Za-z0-9_.-]+$/.test(filename)) {
      throw new Error("invalid daily image filename");
    }
    const imagePath = path.join(this.dailyImagesRoot, day, filename);
    atomicWriteBuffer(imagePath, content);
    atomicWriteJson(imagePath + ".json", { ...metadata });
    return imagePath;
  }

  // 滚动总结（summary.json）：{text, through_event_id, updated_at}
  writeSummary(text, throughEventId) {
    atomicWriteJson(this.summaryPath, {
      text: String(text),
      through_event_id: throughEventId || null,
      updated_at: toUtcIso(new Date()),
    });
  }

  readSummary() {
    if (!fs.existsSync(this.summaryPath)) return null;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.summaryPath, "utf8"));
    } catch (e) {
      // summary.json 损坏（半截写入 / 外部改写）：降级为"暂无总结"，但必须留完整堆栈告警
      console.error(
        "[memory/store] summary.json 解析失败，本次按无总结降级:",
        e && e.stack ? e.stack : e
      );
      return null;
    }
    return parsed && parsed.text != null ? String(parsed.text) : null;
  }
}

module.exports = {
  MemoryStore,
  defaultMemoryRoot,
  atomicWriteBuffer,
  atomicWriteText,
  atomicWriteJson,
  toUtcIso,
  localDayString,
  localTimeString,
  isValidDay,
  EVENTS_MAX_BYTES,
  EVENTS_ROTATE_KEEP,
};
