const nodeFs = require("fs");
const path = require("path");

// macOS 下原子写（tmp + rename）会更换 inode，fs.watch(file) 监听旧 inode 会失效；
// 改为监听父目录，在回调里按文件名过滤。
//
// pet.js 的 setPetInfo 对每个键都用 `!=` 比较（对对象/数组就是引用比较），JSON.parse 每次
// 产生新对象，即使值完全相等也会被判定为"变更"并触发一次 $Store.setItem 全量回写。
//
// ⚠️ 本注释此前断言"只传 info / maxInfo / activeOption（基本都是原始类型或 null）"就能规避
// 这个问题 —— 那是**错的**，而且是这个仓库第 N 次因"注释断言了代码不做的事"吃亏：
//   - pet.js 的默认 info 表里 `travel_china:[]`、`achievements:{}` 就是数组和对象；
//   - activeOption 的 work / study / trip / ill 取值是对象或 null，非 null 时同样是引用比较。
// 后果不是无限循环（链条止于下面第 4 步的 lastRaw 刷新），而是**每次心跳写被放大成两次
// 全量写 + 额外两次全文件读**：心跳写盘 → watch 事件 → reload → 引用类型键恒被判为变更 →
// 再写一次。存档层是主进程同步 IO，这直接体现为桌宠掉帧。
//
// 现行策略（代码即此处所述，改代码务必同步改这段）：
//   1) 只把 info / maxInfo / activeOption 传入 setPetInfo（activeValue / fishing /
//      otherOptions 仍完全不传）；
//   2) 传入前逐键过滤：原始类型（含 null）直接放行（setPetInfo 的 `!=` 对它们是值比较，
//      不会误判）；引用类型（数组/对象）先与 pet.js 内存现值做**深度值比较**，真的变了
//      才放进 payload —— 这才是消除写放大的那一刀；
//   3) 用 lastRaw 去重整体文件内容；
//   4) setPetInfo 结束后重新读一次磁盘，把 Electron 自己的回写纳入 lastRaw，
//      防止下一次 watch 事件回源触发；
//   5) 确认是外部改动后，让 $Store 的内存镜像失效（src/ini/storeCache.js）：镜像的前提是
//      "本进程是唯一写者"，外部改档正是打破该前提的唯一场景。
//
// 可观测性要求（本模块此前整链路静默吞异常：readFile / JSON.parse / fs.watch 创建失败
// 以及 watcher.on("error", () => {}) 全是空处理，导致"外部改档同步"死掉后无人可知）：
//   - 除"文件还不存在"（ENOENT，首次启动的正常态）外，任何异常都必须打完整堆栈；
//   - fs.watch 建立失败与 watcher 运行期报错都不得静默 return，必须按退避重建监听。
//
// electron 与 fs 均可注入（deps），使本模块在纯 node 下可单测——生产调用仍是
// startDataWatcher() 不传参。

const FILE_NAME = "config-qq-local.json";

// 监听建立失败 / watcher 报错后的重建退避序列（毫秒）；用尽后按最后一档持续重试。
// 计数刻意不在重建成功后归零：watcher 反复 flapping（句柄被安全软件反复回收等）时
// 应逐步拉长间隔，而不是每秒重建一次把主进程拖死。
const REBUILD_DELAYS_MS = [1000, 5000, 15000, 60000];

function logError(message, error) {
  console.error(`[ini/dataWatcher] ${message}`, error && error.stack ? error.stack : error);
}

/**
 * JSON 值的深度相等比较（键顺序无关）。
 * 只用于比较来自 JSON.parse 的数据与 pet.js 的内存表：不会有环、函数、NaN 与
 * Date/Map/Set，所以不需要通用深比较库那套开销。
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * 过滤出"真的需要交给 setPetInfo 的键"，消除引用比较造成的写放大（见文件头第 2 步）。
 *
 * @param {object} incoming 磁盘上这一节的内容（JSON.parse 的产物）
 * @param {object|null} memory pet.js 内存里对应这一节的现值；拿不到时为 null
 * @param {Function} onUncomparable 引用类型键因为拿不到内存现值而被丢弃时的回调（用于告警）
 * @returns {object} 过滤后的 payload 片段
 */
function pickChangedKeys(incoming, memory, onUncomparable) {
  const picked = {};
  for (const key of Object.keys(incoming)) {
    const value = incoming[key];
    // 原始类型与 null：setPetInfo 的 `!=` 对它们就是值比较，交给它自己判断即可
    if (value === null || typeof value !== "object") {
      picked[key] = value;
      continue;
    }
    // 引用类型：拿不到内存现值就无法判断是否真变了。此时**宁可不传**——传了必然造成一次
    // 无意义的全量回写（写放大），不传只是这一个键的外部改动本轮不同步。
    if (!memory) {
      onUncomparable(key);
      continue;
    }
    if (deepEqual(value, memory[key])) continue;
    picked[key] = value;
  }
  return picked;
}

/**
 * 启动"存档文件被外部修改 → 同步进内存"的监听。
 *
 * @param {object} [deps] 仅供单元测试注入
 * @param {object} [deps.fs]            fs 替身（需 watch / readFileSync）
 * @param {object} [deps.app]           electron app 替身（需 getPath，可选 on）
 * @param {Function} [deps.setTimeout]  定时器替身
 * @param {Function} [deps.clearTimeout]
 * @returns {{stop:Function,reload:Function,status:Function}|null} 句柄；拿不到 app 时返回 null
 */
function startDataWatcher(deps = {}) {
  const fs = deps.fs || nodeFs;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;

  let app = deps.app;
  if (!app) {
    try {
      app = require("electron").app;
    } catch (e) {
      // 拿不到 electron.app 就没有 userData 路径可监听；这是致命降级，必须留堆栈
      logError("无法获取 electron.app，存档外部改动同步未启动:", e);
      return null;
    }
  }

  // 非 Electron 运行时（例如纯 Node 下跑测试、或被别的工具直接 require）
  // require("electron") 能成功但导出的 app 为 undefined，不会抛错。
  // 因此只靠上面的 try/catch 不足以判定可用性，必须显式校验拿到的对象
  // （注意这里必须用可选链：app 为 undefined 时 app.getPath 本身就会抛）。
  if (typeof app?.getPath !== "function") {
    logError(
      "无法获取 electron.app（不在 Electron 运行时，app.getPath 不可用），存档外部改动同步未启动:",
      new Error("app.getPath is not a function")
    );
    return null;
  }

  const dir = app.getPath("userData");
  const filePath = path.join(dir, FILE_NAME);

  let watcher = null;
  let lastRaw = "";
  let stopped = false;
  let rebuildTimer = null;
  let rebuildAttempt = 0;

  const readFile = () => {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      // ENOENT 是首次启动（存档尚未写出）的正常态；其余（EACCES / EBUSY / EIO…）
      // 会让同步静默失效，必须记完整堆栈
      if (!e || e.code !== "ENOENT") {
        logError(`读取存档文件失败（${filePath}），本次同步跳过:`, e);
      }
      return "";
    }
  };

  /** pet.js 的内存现值（引用类型键的比较基准）。拿不到时返回 null，由调用方降级处理。 */
  const readMemoryPet = () => {
    if (typeof global.getPetInfo !== "function") return null;
    try {
      const info = global.getPetInfo();
      return info && typeof info === "object" ? info : null;
    } catch (e) {
      logError("读取内存宠物数据（getPetInfo）失败，本轮引用类型键不做同步:", e);
      return null;
    }
  };

  /**
   * 外部改档后校准 $Store 的内存镜像。镜像成立的前提是"本进程是唯一写者"
   * （src/ini/storeCache.js 文件头有核实记录），外部改档是唯一打破该前提的场景。
   *
   * 用 reconcile 而不是整表 invalidate：能走到这里的文件变化里，绝大多数其实是**本进程
   * 自己**落盘的回声（每 60s 心跳一次），整表清空会把镜像的读收益白白还回去。
   * reconcile 只丢弃与磁盘不一致的键；拿不到它（旧版 storeCache）时退回 invalidate。
   */
  const syncStoreMirror = (data) => {
    const cache = global.$Store && global.$Store._cache;
    if (!cache) return;
    try {
      if (typeof cache.reconcile === "function") {
        cache.reconcile(data, deepEqual, "dataWatcher:file-changed");
      } else if (typeof cache.invalidate === "function") {
        cache.invalidate("dataWatcher:file-changed");
      }
    } catch (e) {
      logError("校准 $Store 内存镜像失败，后续 getItem 可能读到改档前的旧值:", e);
    }
  };

  const reload = () => {
    const raw = readFile();
    if (!raw || raw === lastRaw) return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // 原子写的中间态会走到这里，真·损坏也走这里，必须留证据
      logError("存档文件 JSON 解析失败，本次同步跳过（持续出现说明文件已损坏）:", e);
      return;
    }

    lastRaw = raw;
    // 到这里已确认磁盘内容与上次不同：镜像可能落后，必须先校准（内部会先把待落盘写入落盘）
    syncStoreMirror(data);

    const pet = (data && data.pet) || {};
    const memory = readMemoryPet();
    const uncomparable = [];
    const onUncomparable = (key) => uncomparable.push(key);
    const payload = {};
    if (pet.info) payload.info = pickChangedKeys(pet.info, memory && memory.info, onUncomparable);
    if (pet.maxInfo) {
      payload.maxInfo = pickChangedKeys(pet.maxInfo, memory && memory.maxInfo, onUncomparable);
    }
    if (pet.activeOption) {
      payload.activeOption = pickChangedKeys(
        pet.activeOption,
        memory && memory.activeOption,
        onUncomparable
      );
    }
    if (uncomparable.length) {
      // 可预期的降级（例如 pet.js 尚未加载完），但必须可见：否则"外部改档同步部分失效"无人可知
      console.warn(
        `[ini/dataWatcher] 拿不到内存宠物数据，以下引用类型键本轮未同步（避免无意义的全量回写）: ${uncomparable.join(
          ", "
        )}`
      );
    }

    if (typeof global.setPetInfo === "function" && Object.keys(payload).length) {
      try {
        global.setPetInfo(payload);
      } catch (e) {
        // 写内存失败不该拖垮监听器，但绝不能静默
        logError("把外部改动写入内存（setPetInfo）失败:", e);
        return;
      }
      // setPetInfo 会触发 Electron 自己的 $Store.setItem 回写文件，刷新 lastRaw
      // 以免下一次 watch 事件把这次的"回写"重新当作外部变更处理。
      lastRaw = readFile() || lastRaw;
    }
  };

  const scheduleRebuild = (reason) => {
    if (stopped || rebuildTimer) return;
    const delay = REBUILD_DELAYS_MS[Math.min(rebuildAttempt, REBUILD_DELAYS_MS.length - 1)];
    rebuildAttempt += 1;
    console.error(
      `[ini/dataWatcher] ${reason}，将在 ${delay}ms 后第 ${rebuildAttempt} 次重建存档监听`
    );
    rebuildTimer = setTimer(() => {
      rebuildTimer = null;
      build();
    }, delay);
    // 重建定时器不该拖住进程退出
    if (rebuildTimer && typeof rebuildTimer.unref === "function") rebuildTimer.unref();
  };

  const build = () => {
    if (stopped) return false;
    try {
      watcher = fs.watch(dir, { persistent: false }, (_eventType, changedName) => {
        if (changedName && changedName !== FILE_NAME) return;
        reload();
      });
    } catch (e) {
      watcher = null;
      logError(`创建存档监听失败（目录 ${dir}）:`, e);
      scheduleRebuild("存档监听创建失败");
      return false;
    }

    if (watcher && typeof watcher.on === "function") {
      // 闭包捕获本次创建的实例：旧 watcher 被替换后仍可能补发 error（Node 的 FSWatcher
      // 在句柄失效时可能多次触发），若处理器操作外层的 `watcher` 变量，就会把刚重建好的
      // **新** watcher 关掉并再排一次重建 —— 能自愈但会无谓抖动。
      // 与 src/service/perception/loop.js 用 `this._abort === controller` 比对身份同理。
      const self = watcher;
      self.on("error", (e) => {
        if (watcher !== self) {
          console.warn(
            "[ini/dataWatcher] 忽略已被替换的旧监听器补发的错误（当前监听器不受影响）:",
            e && e.message ? e.message : e
          );
          return;
        }
        logError("存档监听运行期报错，将重建:", e);
        try {
          self.close();
        } catch (e2) {
          logError("关闭出错的存档监听器失败:", e2);
        }
        watcher = null;
        scheduleRebuild("存档监听器报错");
      });
    }

    // 初始化 lastRaw 为当前磁盘内容，避免启动/重建阶段把既有内容误判为外部变更。
    lastRaw = readFile();
    return true;
  };

  const stop = () => {
    stopped = true;
    if (rebuildTimer) {
      try {
        clearTimer(rebuildTimer);
      } catch (e) {
        logError("清理重建定时器失败:", e);
      }
      rebuildTimer = null;
    }
    try {
      watcher && watcher.close();
    } catch (e) {
      logError("关闭存档监听器失败:", e);
    }
    watcher = null;
  };

  build();

  if (app && typeof app.on === "function") {
    app.on("before-quit", stop);
  }

  return {
    stop,
    reload,
    /** 供测试与线上排查：当前是否有活跃 watcher、已尝试重建多少次 */
    status: () => ({ watching: !!watcher, rebuildAttempt, rebuildPending: !!rebuildTimer }),
  };
}

module.exports = { startDataWatcher, REBUILD_DELAYS_MS, FILE_NAME, deepEqual, pickChangedKeys };
