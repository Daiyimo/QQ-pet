// 记忆存储层：移植自 jarvis_backend/memory/store.py。
// 目录结构：userData/memory/{events.jsonl,summary.json,daily/,daily-images/}
//   （不含 facts.json——jarvis 原实现有事实库，本项目未移植，只留了一个从不被读写的
//     this.factsPath 字段，见 :127；磁盘上永远不会出现这个文件）
// 所有写操作均为原子写（tmp + fsync + rename），事件日志为追加式 JSONL。
// 本文件只依赖 Node 内置模块，Electron 惰性获取（普通 node 下可直接 require 单测）。
// 注意：本文件必须保持普通 require —— 间接动态 require 的写法与原子写逻辑组合
// 会被本机安全软件误判删除（实测），请勿改动。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getElectronPath } = require("../electronPaths.js");

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

// —— 磁盘增长边界：日记配图裁剪 ——
// 每点一次"生成今日记忆图"就新增一张图 + 一个 .json，此前全库无任何裁剪，
// 单图上限 25 MiB（imageGen.MAX_IMAGE_BYTES）→ 点 20 次最坏 500 MiB 无上界。
// 单天保留张数。依据：同一天重复生成基本是"对首图不满意再来一张"的重试，保留最近 3 张
// 足够用户比较取舍；更早的重试图没有回看价值（当天正文已固化在 daily/<day>.md）。
const DAILY_IMAGES_KEEP_PER_DAY = 3;
// daily-images/ 全库字节上限（含 .json 元数据）。依据：单图硬上限 25 MiB，1536x1024
// 的实际产物约 2–3 MiB；200 MiB ≈ 8 张最坏体积 / ≈70 张典型体积（每天 1 张可存两个多月），
// 与课程录制的 ≈520 MiB 同一量级但更保守，配图是可再生成的衍生物，删旧的代价低。
const DAILY_IMAGES_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

// 记忆根目录：Electron 下取 userData/memory；普通 node（单测）退到 cwd/memory。
// 可用性判定与降级日志统一走 electronPaths（原内联实现漏了"require 成功但 app 为
// undefined"这条静默降级，见该模块注释）。
function defaultMemoryRoot() {
  return path.join(getElectronPath("userData", process.cwd(), "memory/store"), "memory");
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
  // options.eventsMaxBytes / options.eventsRotateKeep / options.dailyImagesKeepPerDay /
  // options.dailyImagesMaxTotalBytes 仅用于注入测试用的小阈值，生产不传，
  // 走 EVENTS_MAX_BYTES / EVENTS_ROTATE_KEEP / DAILY_IMAGES_* 常量
  constructor(root, options = {}) {
    this.root = root || defaultMemoryRoot();
    this.eventsMaxBytes = options.eventsMaxBytes > 0 ? options.eventsMaxBytes : EVENTS_MAX_BYTES;
    this.eventsRotateKeep =
      options.eventsRotateKeep > 0 ? options.eventsRotateKeep : EVENTS_ROTATE_KEEP;
    this.dailyImagesKeepPerDay =
      options.dailyImagesKeepPerDay > 0
        ? options.dailyImagesKeepPerDay
        : DAILY_IMAGES_KEEP_PER_DAY;
    this.dailyImagesMaxTotalBytes =
      options.dailyImagesMaxTotalBytes > 0
        ? options.dailyImagesMaxTotalBytes
        : DAILY_IMAGES_MAX_TOTAL_BYTES;
    this.eventsPath = path.join(this.root, "events.jsonl");
    this.summaryPath = path.join(this.root, "summary.json");
    // 死字段：全仓零读零写（jarvis 的事实库未移植），文件永不产生。保留仅为占位，
    // 别据此以为 memory 目录下会有 facts.json。
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
    // timestamp 校验与 kind/text 对称：非法值（Invalid Date）时 toISOString 会抛
    // RangeError。这里选择回退当前时间而非拒绝——事件内容本身有效，记错时间比
    // 整条丢弃损失小；按"降级必须记日志"约定留 warn。
    let tsDate = timestamp ? new Date(timestamp) : new Date();
    if (Number.isNaN(tsDate.getTime())) {
      console.warn(
        `[memory/store] 事件时间戳非法（${timestamp}），已回退为当前时间`
      );
      tsDate = new Date();
    }
    const event = {
      id: eventId || crypto.randomUUID().replace(/-/g, ""),
      timestamp: toUtcIso(tsDate),
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
        if (!isValidDay(name)) continue;
        try {
          if (!fs.statSync(path.join(this.dailyImagesRoot, name)).isDirectory()) continue;
        } catch (e) {
          // 目录在扫描间隙被删 / 无权限：该天配图不计入，但不能让整份记忆列表崩掉
          console.warn(
            `[memory/store] daily-images/${name} 状态读取失败，该天配图未计入:`,
            e && e.message ? e.message : e
          );
          continue;
        }
        days.add(name);
        this._warnOrphanDailyImages(name);
      }
    }
    return [...days].sort().reverse();
  }

  // 孤儿配图（有图无 .json）扫描：容忍——该天照常计入记忆天，只告警。
  // 元数据写入失败已在 writeDailyImage 里回滚删图，孤儿只可能来自写入中途断电等极端情况，
  // 且后续 _pruneDailyImages 会把它当普通条目回收。
  _warnOrphanDailyImages(day) {
    let names;
    try {
      names = fs.readdirSync(path.join(this.dailyImagesRoot, day));
    } catch (e) {
      console.warn(
        `[memory/store] 读取 daily-images/${day} 失败，孤儿配图检查跳过:`,
        e && e.message ? e.message : e
      );
      return [];
    }
    const metas = new Set(names.filter((n) => n.endsWith(".json")));
    const orphans = names.filter((n) => !n.endsWith(".json") && !metas.has(n + ".json"));
    if (orphans.length) {
      console.warn(
        `[memory/store] daily-images/${day} 有 ${orphans.length} 张缺少 .json 元数据的孤儿配图，` +
          `已按无元数据容忍: ${orphans.join(", ")}`
      );
    }
    return orphans;
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

  // 日程信息图落盘：daily-images/<day>/<filename> + 同名 .json 元数据（均原子写）。
  // 顺序为"先图片后元数据"，元数据失败则回滚删除刚写的图片（要么都在要么都不留）：
  // 反过来（先元数据）失败时若删不掉元数据，会留下指向不存在图片的悬空记录，
  // 比留一个无人引用的图片文件更糟（后者只是占字节，且会被 _pruneDailyImages 回收）。
  // 写成功后按上限裁剪磁盘（见 _pruneDailyImages）。
  writeDailyImage(day, filename, content, metadata) {
    if (!isValidDay(day)) throw new Error(`invalid day: ${day}`);
    if (!/^[A-Za-z0-9_.-]+$/.test(filename) || filename.includes("..")) {
      throw new Error("invalid daily image filename");
    }
    const imagePath = path.join(this.dailyImagesRoot, day, filename);
    atomicWriteBuffer(imagePath, content);
    try {
      atomicWriteJson(imagePath + ".json", { ...metadata });
    } catch (e) {
      console.error(
        `[memory/store] 日记配图元数据写入失败，已回滚删除刚写入的图片 ${day}/${filename}:`,
        e && e.stack ? e.stack : e
      );
      try {
        fs.rmSync(imagePath, { force: true });
      } catch (e2) {
        // 回滚删除也失败：只剩一个孤儿图片（memoryDays 会容忍并告警，裁剪会回收），
        // 原始的元数据写入错误照常抛给调用方
        console.warn(
          `[memory/store] 回滚删除图片 ${day}/${filename} 失败，将残留孤儿图片:`,
          e2 && e2.message ? e2.message : e2
        );
      }
      throw e;
    }
    try {
      this._pruneDailyImages(day, filename);
    } catch (e) {
      // 裁剪只是磁盘回收，意外失败不能改变"配图已成功落盘"这个主流程结果
      console.error(
        "[memory/store] 日记配图裁剪意外失败，本次未回收磁盘（下次生成时重试）:",
        e && e.stack ? e.stack : e
      );
    }
    return imagePath;
  }

  // 文件字节数；不存在按 0 计（孤儿图片没有 .json 属正常情况，不刷日志）
  _fileBytes(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch (e) {
      if (!e || e.code !== "ENOENT") {
        console.warn(
          `[memory/store] 读取 ${path.basename(filePath)} 大小失败，按 0 字节计入配图裁剪:`,
          e && e.message ? e.message : e
        );
      }
      return 0;
    }
  }

  // 列举 daily-images/ 下所有配图条目：{day, filename, imagePath, metaPath, sortKey, bytes}。
  // sortKey 优先取 .json 的 created_at（落盘时的 UTC ISO），元数据缺失/损坏（孤儿图片）时
  // 退到文件名的 UTC 时间戳前缀；两者都归一为纯数字串，可直接按字符串升序比较。
  // bytes 同时计入图片与 .json，使字节上限就是该目录真实的磁盘上界。
  _listDailyImages() {
    const entries = [];
    let dayNames;
    try {
      dayNames = fs.readdirSync(this.dailyImagesRoot);
    } catch (e) {
      if (!e || e.code !== "ENOENT") {
        // 目录还不存在属正常（尚未生成过配图）；其余错误不能静默，本次跳过裁剪
        console.error(
          "[memory/store] 列举 daily-images 失败，本次跳过配图裁剪:",
          e && e.stack ? e.stack : e
        );
      }
      return entries;
    }
    for (const day of dayNames) {
      if (!isValidDay(day)) continue;
      const dayDir = path.join(this.dailyImagesRoot, day);
      let names;
      try {
        if (!fs.statSync(dayDir).isDirectory()) continue;
        names = fs.readdirSync(dayDir);
      } catch (e) {
        console.error(
          `[memory/store] 读取 daily-images/${day} 失败，该天配图本次不参与裁剪:`,
          e && e.stack ? e.stack : e
        );
        continue;
      }
      for (const filename of names) {
        if (filename.endsWith(".json")) continue;
        const imagePath = path.join(dayDir, filename);
        const metaPath = imagePath + ".json";
        let createdAt = "";
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          createdAt = meta && meta.created_at ? String(meta.created_at) : "";
        } catch (e) {
          // 元数据缺失（孤儿）或损坏：不阻断裁剪，按文件名时间戳排序并告警
          console.warn(
            `[memory/store] daily-images/${day}/${filename} 的 .json 元数据不可用，` +
              "裁剪改按文件名时间戳排序:",
            e && e.message ? e.message : e
          );
        }
        entries.push({
          day,
          filename,
          imagePath,
          metaPath,
          // 文件名形如 <UTC时间戳>-<uuid8>.<ext>，只取第一段避免 uuid 里的数字混入排序键
          sortKey: String(createdAt || filename.split("-")[0]).replace(/\D/g, ""),
          bytes: this._fileBytes(imagePath) + this._fileBytes(metaPath),
        });
      }
    }
    return entries;
  }

  // daily-images 裁剪：① 每天只留最近 dailyImagesKeepPerDay 张；② 全库字节降到
  // dailyImagesMaxTotalBytes 以内，从最旧往新删。keepDay/keepFilename（本次刚写入的那张）
  // 永不删，因此单天最多短暂多留一张、总量最多为上限或"仅剩这一张"。
  // 模式与 courses/repo.js 的 _pruneOldSessions 一致：created_at 升序删最旧、跳过正在使用的、
  // 单个删除失败只记日志并继续、最终仍超限只 warn 不强删。返回删除的配图张数。
  _pruneDailyImages(keepDay, keepFilename) {
    const entries = this._listDailyImages();
    if (!entries.length) return 0;
    const isKeep = (e) => e.day === keepDay && e.filename === keepFilename;
    const oldestFirst = (a, b) =>
      a.sortKey.localeCompare(b.sortKey) || a.filename.localeCompare(b.filename);

    const doomed = new Set();
    // ① 单天张数上限
    const perDay = new Map();
    for (const e of entries) {
      const list = perDay.get(e.day);
      if (list) list.push(e);
      else perDay.set(e.day, [e]);
    }
    for (const [, list] of perDay) {
      if (list.length <= this.dailyImagesKeepPerDay) continue;
      const sorted = [...list].sort(oldestFirst);
      for (const e of sorted.slice(0, sorted.length - this.dailyImagesKeepPerDay)) {
        if (!isKeep(e)) doomed.add(e);
      }
    }
    // ② 全库字节上限（①已判死的不计入总量，它们即将被删）
    const remaining = entries.filter((e) => !doomed.has(e)).sort(oldestFirst);
    let total = remaining.reduce((sum, e) => sum + e.bytes, 0);
    for (const e of remaining) {
      if (total <= this.dailyImagesMaxTotalBytes) break;
      if (isKeep(e)) continue;
      doomed.add(e);
      total -= e.bytes;
    }
    if (total > this.dailyImagesMaxTotalBytes) {
      console.warn(
        `[memory/store] daily-images 仍超过 ${this.dailyImagesMaxTotalBytes} 字节上限` +
          "（可删的都已清理，本次刚生成的配图不强删）"
      );
    }

    let removed = 0;
    const touchedDays = new Set();
    for (const e of doomed) {
      try {
        fs.rmSync(e.imagePath, { force: true });
        fs.rmSync(e.metaPath, { force: true });
        removed += 1;
        touchedDays.add(e.day);
        console.warn(
          `[memory/store] daily-images 超出上限（每天 ${this.dailyImagesKeepPerDay} 张 / ` +
            `全库 ${this.dailyImagesMaxTotalBytes} 字节），已清理最旧配图 ${e.day}/${e.filename}`
        );
      } catch (err) {
        // 单张删不掉（占用/权限）不影响继续清理下一张，但必须留完整堆栈
        console.error(
          `[memory/store] 清理配图 ${e.day}/${e.filename} 失败，本次跳过（下次生成时重试）:`,
          err && err.stack ? err.stack : err
        );
      }
    }
    for (const day of touchedDays) this._removeDailyImageDirIfEmpty(day);
    return removed;
  }

  // 裁剪后清掉空的天目录，避免 memoryDays 继续把没有任何配图的天算作"有记忆的天"
  _removeDailyImageDirIfEmpty(day) {
    const dayDir = path.join(this.dailyImagesRoot, day);
    try {
      if (fs.readdirSync(dayDir).length === 0) fs.rmdirSync(dayDir);
    } catch (e) {
      console.warn(
        `[memory/store] 清理空目录 daily-images/${day} 失败，已忽略:`,
        e && e.message ? e.message : e
      );
    }
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
  DAILY_IMAGES_KEEP_PER_DAY,
  DAILY_IMAGES_MAX_TOTAL_BYTES,
};
