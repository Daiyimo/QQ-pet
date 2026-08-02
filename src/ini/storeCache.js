"use strict";

/**
 * storeCache.js —— $Store（src/ini/store.js，webpack 压缩产物）的内存镜像 + 写防抖。
 *
 * 为什么需要它（第一性问题）：$Store 直通 electron-store(conf 10.2.0)，而 conf 的
 *   - `get store`  每次访问都 `fs.readFileSync(this.path)` + `JSON.parse`
 *                  （node_modules/conf/dist/source/index.js:274-276）
 *   - `set(k,v)`   = 一次 `get store`（读+解析）+ 合并 + `atomically.writeFileSync`
 *                  （同文件 :170-189）
 * 全部是**主进程同步 IO**。稳态每分钟：60s 心跳 1 次 setItem("pet")、成就巡检 1 次
 * getItem，加上 dataWatcher 的回声读，每小时就是几百次全文件读 + 上百次全文件写。
 * 存档还没有体积上界（fishing.fishes / cache.store 背包 / 34 省收集 / achievements
 * 都只增不减），存档越大每次同步写盘卡顿越明显 —— 直接表现为桌宠掉帧。
 *
 * 本模块把逻辑放在这个多行文件里、在压缩产物 store.js 中只留一行接入点，遵循本项目
 * pathGuard.js / ipcInputGuard.js / security.js 的既定模式（压缩单行内禁止塞复杂逻辑）。
 *
 * ── 前提：本进程是存档文件的唯一写者 ────────────────────────────────────────────
 * 2026-08 核查：全仓仅 src/ini/store.js 一处 `require("electron-store")`（渲染层与
 * preload 都没有），且没有任何代码对 config-qq-local.json 做 writeFileSync；
 * src/ini/dataWatcher.js 监听该文件但**只读**。因此"内存即权威"成立。
 * 唯一的外部写者是用户/第三方工具手工改档 —— 那条路径由 dataWatcher 检测到内容变化后
 * 调用本模块的 invalidate() 使镜像失效（见 dataWatcher.reload）。
 *
 * ── 镜像失效策略（缓存变量 _values_cache / _pending_cache 的注释即此段）────────────
 *   1) 本进程 setItem   → 同步更新镜像（镜像永不落后于内存）；
 *   2) removeItem(key)  → drop(key) 只清该键；
 *   3) clear()          → reset() 整表清空（含待落盘写入，因为存档整体被抹掉）；
 *   4) 外部改档         → dataWatcher 调 invalidate()：先把 pending 落盘（避免丢本进程
 *                         的新数据），再整表清空，下次 getItem 重新读磁盘；
 *   5) 读穿（cache miss）前也 flush 一次：conf 支持点号路径（本项目用了
 *      "tool.floatStyle"），读 "tool" 这类前缀键时磁盘可能落后于同一棵树上的待落盘写入。
 *
 * ── 崩溃语义（明确的取舍）───────────────────────────────────────────────────────
 * 只有 DEBOUNCED_KEYS 里的键走防抖；进程被强杀 / 断电时最多丢 DEBOUNCE_MS（5 秒）内的
 * 属性变化，绝不会丢"更早"的数据（用的是首次写入即开窗的固定窗口防抖，不是每次写入都
 * 重置窗口的尾防抖，所以最大陈旧度恒为 DEBOUNCE_MS，与写入频率无关）。
 * 5 秒的代价上限是 5 秒的饥饿/清洁/心情衰减，而正常退出路径全部 flush（见 hookQuit）。
 *
 * ── 一个必须知道的语义细节 ──────────────────────────────────────────────────────
 * 镜像命中时返回的是**同一个对象引用**（不做深拷贝：深拷贝会吃掉本模块大部分收益）。
 * 调用方若原地改动 getItem 的返回值却不回写 setItem，改动会被本进程后续 getItem 看见
 * （旧行为是每次读都重新 JSON.parse，看不见）。2026-08 已逐一核查主进程全部读点：
 * doMain.js（改完即 setPetInfo 回写）、achievement.js（Object.assign 到新对象）、
 * travel.js（filter 出新数组）、setup/main.js 与 tool/floatStyle（只读/浅拷贝），
 * 均不违反该约定。新增读点若要原地改值，请自己先深拷贝。
 */

const nodeFs = require("fs");

/* 防抖窗口。依据：唯一的高频写来源是 GrowUp.js 的 growTime=6e4 心跳（60s 一次，且
   同一 tick 内常连着 2~3 次 setPetInfo：doChangeMaxInfo / lastLoginTime 翻天 / 主更新），
   窗口只要能盖住"同一次交互产生的连串写"就够，不需要接近心跳周期；5s 同时把崩溃丢失
   上界压在"5 秒的属性衰减"这个用户完全无感的量级。 */
const DEBOUNCE_MS = 5000;

/* 只有这些键走防抖，其余键一律写穿（立即落盘）。
   依据：
     - "pet" 是唯一高频写入键（心跳 + 每次交互都写），收益全在它身上；
     - 其他键（sys / cache / achievements / toSex / tool.floatStyle）都是用户动作触发的
       低频写，防抖收益接近零，风险却实在：setup/main.js 的性别重置走
       `$Store.clear(); $Store.setItem("toSex",x); app.relaunch(); app.exit(0)`，
       而 app.exit() 按 Electron 文档不触发 before-quit / will-quit —— 任何延迟落盘都
       可能让这次写入消失。写穿从设计上消除这一类问题。
   注意：写穿会顺带 flush 掉所有 pending（包括 pet），所以任何一次低频写都会把心跳数据
   一起落盘，进一步压低实际丢失窗口。 */
const DEBOUNCED_KEYS = new Set(["pet"]);

/* 存档体积告警阈值。依据：健康存档（宠物属性 + 34 省收集 + 成就 + 背包）实测在几十 KB
   量级；2MB 已是它的 ~30 倍，此时每次落盘的"同步 readFileSync + JSON.parse +
   JSON.stringify + 原子写"合计约 20~40ms，超过 60fps 一帧预算（16.7ms）的两倍，用户能
   直接看到桌宠卡顿。取 2MB 而不是更大值，是为了在真正卡之前就留下可检索的告警。 */
const SAVE_SIZE_WARN_BYTES = 2 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;

/* 体积抽检周期（按成功落盘次数计）。依据：稳态落盘频率由 GrowUp.js 的 60s 心跳主导，
   每 20 次成功 flush ≈ 20 分钟检查一次 —— 存档是"只增不减"的慢变量（背包 / 鱼 / 成就），
   分钟级的发现延迟毫无代价，而每次 flush 都 statSync 等于在热路径上加一次同步 IO，
   恰恰是本模块存在的理由所要消除的东西。20 次 statSync 摊到 20 分钟，开销可忽略。
   只在启动期查一次是不够的：桌宠常驻数小时到数天，长会话内涨过阈值会完全无感。 */
const SAVE_SIZE_CHECK_EVERY_FLUSHES = 20;

/* 用户可见告知（气泡）。console.warn 用户根本看不到，等于没有护栏 —— 与 courses/manager.js
   的桌面导出上限用的是同一条通道、同一套"每进程只提示一次"的取舍：每次落盘都弹会变成骚扰，
   重启后允许再提示一次，正好覆盖"用户一直没清理"的情形。 */
function speakBubble(text) {
  if (typeof openSpeak !== "function") return false;
  try {
    openSpeak({
      data: { type: "text", data: text, submitText: "" },
      nextActiveStr: "speak",
    });
    return true;
  } catch (e) {
    logError("存档体积提示气泡弹出失败（仅日志可见）:", e);
    return false;
  }
}

function logError(message, error) {
  console.error(`[ini/storeCache] ${message}`, error && error.stack ? error.stack : error);
}

/**
 * 按 conf 的点号路径取值（本项目用了 "tool.floatStyle" 这种键）。
 * 只做纯对象逐层下探，路径中断即返回 undefined —— 与 conf 的 dot-prop 语义一致。
 */
function readByDotPath(root, key) {
  if (!key.includes(".")) return root[key];
  let node = root;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

class StoreCache {
  /**
   * @param {object} owner  St 实例（src/ini/store.js）。每次用时读 owner.ElectronStore，
   *                        不缓存该引用：损坏恢复流程与测试都会整体替换它。
   * @param {object} [deps] 仅供单测注入：fs / app / setTimeout / clearTimeout / debounceMs
   */
  constructor(owner, deps = {}) {
    this.owner = owner;
    this._fs = deps.fs || nodeFs;
    this._setTimer = deps.setTimeout || setTimeout;
    this._clearTimer = deps.clearTimeout || clearTimeout;
    this._debounceMs = deps.debounceMs === undefined ? DEBOUNCE_MS : deps.debounceMs;
    /** 读镜像 key -> conf 返回值。失效策略见文件头"镜像失效策略"。 */
    this._values_cache = new Map();
    /** 待落盘写入 key -> value。flush 成功即清空；flush 失败保留原值以便下次重试。 */
    this._pending_cache = new Map();
    this._timer = null;
    /** 体积抽检：成功落盘计数（每 SAVE_SIZE_CHECK_EVERY_FLUSHES 次查一次，不在热路径 statSync）。 */
    this._flushesSinceSizeCheck = 0;
    /** 超阈值日志只记一次（每 20 分钟重复一条只会淹没日志，而用户根本看不到日志）。 */
    this._sizeWarnLogged = false;
    /** 超阈值气泡只弹一次（每进程）；只有气泡真的送达才置位，见 warnIfSaveTooLarge。 */
    this._sizeOverflowNotified = false;
    /** 可观测性：线上排查与测试都靠它判断"读写到底降没降"。 */
    this.stats = { backendReads: 0, backendWrites: 0, flushes: 0, coalesced: 0 };
  }

  /**
   * 读：命中镜像直接返回，未命中才穿到 conf（一次全文件读）并记入镜像。
   * @param {string} key
   * @param {Function} readThrough 由 store.js 传入的 `()=>this.ElectronStore.get(key)`，
   *   保持异常语义不变（读失败仍由 store.js 记日志后上抛给启动隔离逻辑）。
   */
  get(key, readThrough) {
    if (this._values_cache.has(key)) return this._values_cache.get(key);
    // 点号路径下前缀键的磁盘内容可能落后于待落盘写入，读穿前先落盘（无 pending 时是空操作）
    this.flush("read-through:" + key);
    const value = readThrough();
    this.stats.backendReads += 1;
    this._values_cache.set(key, value);
    return value;
  }

  /** 写：立即进镜像；高频键排入防抖窗口，其余键写穿。 */
  set(key, value) {
    this._values_cache.set(key, value);
    if (this._pending_cache.has(key)) this.stats.coalesced += 1;
    this._pending_cache.set(key, value);
    if (!DEBOUNCED_KEYS.has(key)) {
      this.flush("write-through:" + key);
      return;
    }
    // 固定窗口（首写开窗，后续写不重排）：保证最大陈旧度恒为 _debounceMs，
    // 不会因为写入不断到来而无限推迟落盘。
    if (this._timer) return;
    this._timer = this._setTimer(() => {
      this._timer = null;
      this.flush("debounce");
    }, this._debounceMs);
    // 刻意**不** unref：这是数据落盘定时器，不是 dataWatcher 那种可丢弃的重建定时器；
    // 让它在最后 5s 内保持事件循环存活，胜过为了"干净退出"丢掉玩家进度。
  }

  /** 把待落盘写入合并成一次 conf.set 落盘。返回是否真的写了盘。 */
  flush(reason) {
    if (this._timer) {
      try {
        this._clearTimer(this._timer);
      } catch (e) {
        logError("清理防抖定时器失败（不影响本次落盘）:", e);
      }
      this._timer = null;
    }
    if (!this._pending_cache.size) return false;
    const batch = this._pending_cache;
    this._pending_cache = new Map();

    const backend = this.owner && this.owner.ElectronStore;
    if (!backend || typeof backend.set !== "function") {
      this._restorePending(batch);
      logError(
        `底层存储不可用，${batch.size} 个键继续留在内存等下次 flush（reason=${reason}）:`,
        new Error("ElectronStore.set is not a function")
      );
      return false;
    }
    try {
      const entries = Array.from(batch);
      if (entries.length === 1) backend.set(entries[0][0], entries[0][1]);
      // conf 的 set(object) 是一次读 + 一次原子写（conf/dist/source/index.js:170-189），
      // 批量落盘比逐键 set 少 N-1 次全文件读写。
      else backend.set(Object.fromEntries(entries));
      this.stats.flushes += 1;
      this.stats.backendWrites += 1;
      this._maybeCheckSaveSize();
      return true;
    } catch (e) {
      this._restorePending(batch);
      logError(
        `存档落盘失败，${batch.size} 个键保留在内存等下次 flush 重试（reason=${reason}）:`,
        e
      );
      return false;
    }
  }

  /** 落盘失败时把这批写入放回 pending；已被更新的键不覆盖（新值更权威）。 */
  _restorePending(batch) {
    for (const [key, value] of batch) {
      if (!this._pending_cache.has(key)) this._pending_cache.set(key, value);
    }
  }

  /** removeItem 用：只清单个键的镜像与待落盘写入（删除本身由 store.js 立即执行）。 */
  drop(key) {
    this._values_cache.delete(key);
    this._pending_cache.delete(key);
  }

  /** clear() 用：整份存档被抹掉，镜像与待落盘写入一起丢弃（此时保留 pending 是错的）。 */
  reset() {
    if (this._timer) {
      try {
        this._clearTimer(this._timer);
      } catch (e) {
        logError("清理防抖定时器失败（clear 路径）:", e);
      }
      this._timer = null;
    }
    this._values_cache.clear();
    this._pending_cache.clear();
  }

  /**
   * 外部改档时使镜像失效（钝刀：整表清空）。dataWatcher 拿不到 reconcile 时的兜底。
   * 先 flush 再清空：本进程 pending 里的值比磁盘新，conf.set 只合并我们写的那些键，
   * 所以结果是"本进程改过的键以内存为准、其余键以外部改动为准"，且不丢数据。
   */
  invalidate(reason) {
    this.flush("invalidate:" + (reason || "external-change"));
    this._values_cache.clear();
  }

  /**
   * 用磁盘上的实际内容校准镜像（dataWatcher 检测到文件内容变化时调用）。
   *
   * 为什么不直接整表清空：存档文件的绝大多数变化其实是**本进程自己**落盘的回声
   * （每 60s 心跳一次），整表清空会把镜像的读收益白白还回去 —— 成就巡检那类每分钟一次的
   * getItem 又会退化成每分钟一次全文件读。这里只丢弃"与磁盘不一致"的键。
   *
   * 判定方向是安全的：判成"不一致"最坏只是多读一次盘（保守）；判成"一致"要求逐值相等，
   * 而不一致的键必然被丢弃，所以不会留下脏镜像。
   *
   * @param {object} diskData 磁盘内容（dataWatcher 已 JSON.parse 好的整份对象）
   * @param {Function} isEqual 深度值比较函数（由 dataWatcher 传入，避免本模块重复实现）
   * @param {string} [reason]
   * @returns {string[]} 被丢弃的键
   */
  reconcile(diskData, isEqual, reason) {
    this.flush("reconcile:" + (reason || "external-change"));
    if (!diskData || typeof diskData !== "object" || typeof isEqual !== "function") {
      // 拿不到可比较的磁盘内容就退回保守做法：整表清空
      const dropped = [...this._values_cache.keys()];
      this._values_cache.clear();
      return dropped;
    }
    const dropped = [];
    for (const [key, mirrored] of [...this._values_cache]) {
      if (isEqual(mirrored, readByDotPath(diskData, key))) continue;
      this._values_cache.delete(key);
      dropped.push(key);
    }
    return dropped;
  }

  /** 供测试与线上排查 */
  status() {
    return {
      mirrored: this._values_cache.size,
      pending: this._pending_cache.size,
      debouncePending: !!this._timer,
      ...this.stats,
    };
  }

  /**
   * 存档体积检查（启动时一次 + 落盘后周期抽检；不阻断任何流程）。
   * 超阈值时除了 warn 还会经 openSpeak 气泡告知用户一次 —— 只写日志等于没有护栏。
   * @returns {number|null} 字节数；取不到返回 null
   */
  warnIfSaveTooLarge() {
    let filePath;
    try {
      filePath = this.owner.configFilePath();
    } catch (e) {
      logError("取存档路径失败，跳过本次体积检查:", e);
      return null;
    }
    let size;
    try {
      size = this._fs.statSync(filePath).size;
    } catch (e) {
      // ENOENT 是首次启动的正常态（存档还没写出）
      if (!e || e.code !== "ENOENT") {
        logError(`读取存档体积失败（${filePath}），跳过本次体积检查:`, e);
      }
      return null;
    }
    if (size > SAVE_SIZE_WARN_BYTES) {
      if (!this._sizeWarnLogged) {
        this._sizeWarnLogged = true;
        console.warn(
          `[ini/storeCache] 存档体积 ${(size / BYTES_PER_MB).toFixed(2)}MB 已超过告警阈值 ` +
            `${(SAVE_SIZE_WARN_BYTES / BYTES_PER_MB).toFixed(2)}MB（${filePath}）：每次落盘都是` +
            `主进程同步全量读写，会造成桌宠卡顿。常见成因：fishing.fishes、cache.store 背包、` +
            `achievements 只增不减且无体积上界。`
        );
      }
      /* 气泡送达才算"已告知"：启动期这次检查跑在 openSpeak 挂上全局之前（store.js 由
         init.js 最早加载），此时置位会让用户永远收不到提示；留着标志位，下一次周期抽检补上。 */
      if (!this._sizeOverflowNotified) {
        this._sizeOverflowNotified = speakBubble(
          `[host]，我的存档已经涨到 ${(size / BYTES_PER_MB).toFixed(1)}MB 啦，` +
            "每次存进度都会卡一下～有空清一清背包和钓到的鱼吧（我不会自己删你的东西哦）"
        );
      }
    }
    return size;
  }

  /**
   * 落盘后的周期性体积抽检。
   * 为什么不每次 flush 都查：statSync 是同步 IO，而 flush 正是本模块要保护的热路径
   *（心跳 + 每次交互都会走到），在这里加一次无节流的同步 IO 等于重犯本模块要治的病。
   */
  _maybeCheckSaveSize() {
    this._flushesSinceSizeCheck += 1;
    if (this._flushesSinceSizeCheck < SAVE_SIZE_CHECK_EVERY_FLUSHES) return null;
    this._flushesSinceSizeCheck = 0;
    return this.warnIfSaveTooLarge();
  }

  /**
   * 安装退出前的 flush 钩子。**这是硬要求**：丢存档比慢严重得多。
   * 三层保险，缺一层就有真实丢数据路径：
   *   1) before-quit：正常退出的第一站；
   *   2) before-quit 之后的 setImmediate：main/main.js 的 before-quit 监听器注册得比本模块
   *      晚（它在窗口创建回调里注册），Electron 按注册顺序**同步**派发，所以它写
   *      lastX/lastY 的 setPetInfo 发生在第 1 层 flush 之后 —— 不补这一次就会丢坐标；
   *   3) will-quit / quit + 包装 app.exit：app.exit() 按 Electron 文档不触发 before-quit /
   *      will-quit，而本项目真正的终止点正是 ruffleBridge.js:70 与 main/main.js 的
   *      app.exit(0)（含 15s 兜底）。不包一层，退出动画期间的写入会全部丢掉。
   * main.js 不在本次可改范围，所以钩子全部挂在这里，不需要主线配合改 main.js。
   */
  hookQuit(app) {
    if (!app) return;
    if (typeof app.on === "function") {
      app.on("before-quit", () => {
        this.flush("app:before-quit");
        try {
          setImmediate(() => this.flush("app:before-quit:after-listeners"));
        } catch (e) {
          logError("注册退出补充 flush 失败，退出瞬间的写入可能丢失:", e);
        }
      });
      app.on("will-quit", () => this.flush("app:will-quit"));
      app.on("quit", () => this.flush("app:quit"));
    }
    try {
      const origExit = app.exit;
      if (typeof origExit === "function" && !origExit.__qqStoreFlushWrapped) {
        const self = this;
        const wrapped = function (...args) {
          self.flush("app.exit");
          return origExit.apply(app, args);
        };
        wrapped.__qqStoreFlushWrapped = true;
        app.exit = wrapped;
      }
    } catch (e) {
      logError("包装 app.exit 失败，强制退出路径可能丢掉未落盘的写入:", e);
    }
  }
}

/**
 * store.js 的唯一接入点（压缩产物里只有这一行调用）。
 * @param {object} owner St 实例
 * @param {object} [deps] 仅供单测注入
 */
function createStoreCache(owner, deps = {}) {
  const cache = new StoreCache(owner, deps);
  cache.warnIfSaveTooLarge();
  let app = deps.app;
  if (app === undefined) {
    try {
      app = require("electron").app;
    } catch (e) {
      // 非 Electron 运行时（跑测试 / 被工具直接 require）属正常态，只 warn 不 error
      console.warn(
        "[ini/storeCache] 拿不到 electron.app，退出前 flush 钩子未安装（非 Electron 运行时属正常）:",
        e && e.message ? e.message : e
      );
      app = null;
    }
  }
  if (app) cache.hookQuit(app);
  return cache;
}

module.exports = {
  createStoreCache,
  StoreCache,
  DEBOUNCE_MS,
  DEBOUNCED_KEYS,
  SAVE_SIZE_WARN_BYTES,
  SAVE_SIZE_CHECK_EVERY_FLUSHES,
};
