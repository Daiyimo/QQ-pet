/**
 * ipcInputGuard.js —— 主进程 IPC 入参归一化/白名单（纯 node，无 electron / 无第三方依赖）
 *
 * 背景：多个窗口的 ipcMain 处理器直接采信渲染层 payload（下标、URL、元宝数值、数组），
 * 一旦渲染层被注入或自身有 bug，主进程要么抛未捕获异常，要么把非法值写进存档。
 * 本模块把这些「不可信入参 → 可用值」的判定抽成纯函数，便于真实行为测试。
 *
 * 约定：所有函数都不抛异常；拒绝时通过返回值告知调用方（调用方必须记日志）。
 */

/** 允许在窗口内导航的协议白名单（tool/urlWindow 用） */
const ALLOWED_NAV_PROTOCOLS = ["http:", "https:"];

/** 钓鱼存档里 fishes 数组的长度上限，防渲染层刷超长数组撑爆存档 */
const MAX_FISHES = 200;

/** 礼包类型白名单（popups/control 的 gift 缓存 key） */
const GIFT_USE_TYPES = ["sign", "online"];

/**
 * 判断 URL 是否允许在窗口里加载。
 * 只放 http/https：file:/javascript:/data: 等都会被拒绝。
 * @param {unknown} url
 * @returns {boolean}
 */
function isAllowedNavUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch (e) {
    // 非法 URL 属于调用方入参问题，返回 false 由调用方记日志，这里不抛
    return false;
  }
  return ALLOWED_NAV_PROTOCOLS.indexOf(parsed.protocol) !== -1;
}

/**
 * 把不可信数值归一化为「可写入存档的非负整数」。
 *
 * 规则：
 * - 非 number/string 类型 → 拒绝。注意 `Number([])===0`、`Number([5])===5`，
 *   不做类型判断的话数组会被当成合法数值。
 * - 空字符串 / 纯空白 / null / undefined → 拒绝（reason:"empty"）。
 *   钓鱼渲染层的 canusecnt/harvestfish 是 `getCookie(...)` 原样透传，cookie 缺失时是 ""，
 *   而 `Number("")===0`，不拦住就会把「读不到」当成「归零」。
 * - 非有限数（NaN/Infinity）→ 拒绝。
 * - 负数 → 钳到 0，但**不写入**（reason:"negative"）：负值只可能来自渲染层 bug 或篡改，
 *   把钳后的 0 写进去会直接清空玩家数值，拒绝写入才是安全方向。
 * - 0 → 是否写入由 allowZero 决定（见 normalizeFishingSave 的逐字段策略）。
 *
 * @param {unknown} raw
 * @param {{allowZero?:boolean}} [options]
 * @returns {{apply:boolean, value:number, reason?:string, clamped?:boolean}}
 */
function normalizePositiveNumber(raw, options = {}) {
  const allowZero = options.allowZero === true;
  if (raw === null || raw === undefined) return { apply: false, value: 0, reason: "empty" };
  if (typeof raw !== "number" && typeof raw !== "string") {
    return { apply: false, value: 0, reason: "bad-type" };
  }
  if (typeof raw === "string" && raw.trim() === "") {
    return { apply: false, value: 0, reason: "empty" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return { apply: false, value: 0, reason: "not-finite" };
  let value = Math.trunc(n);
  if (value < 0) return { apply: false, value: 0, reason: "negative", clamped: true };
  if (value === 0) return { apply: allowZero, value: 0, reason: allowZero ? undefined : "zero" };
  let clamped = false;
  if (value > Number.MAX_SAFE_INTEGER) {
    value = Number.MAX_SAFE_INTEGER;
    clamped = true;
  }
  return { apply: true, value, clamped };
}

/** fishes 允许是数组，或是能 JSON.parse 成数组的字符串 */
function normalizeFishes(raw) {
  let arr = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      return { apply: false, value: null, reason: "bad-json" };
    }
  }
  if (!Array.isArray(arr)) return { apply: false, value: null, reason: "not-array" };
  if (arr.length > MAX_FISHES) return { apply: false, value: null, reason: "too-long" };
  return { apply: true, value: arr };
}

/**
 * 钓鱼存档的数值字段策略。
 * allowZero=true：渲染层显式传 0 必须落盘。canusecnt 用完会被减到 0
 * （indexOnLine.js 的 `setCookie("canusecnt",0,true)`），丢弃 0 会让存档里留着旧的 1，
 * 关窗重开后主进程又把 1 种回 cookie → 白送一次粉钻钓鱼次数。harvestfish 归零同理。
 *
 * yb 也是 allowZero=true。曾一度按「渲染层 `yb:+getCookie("yb")` 会把空 cookie 变成
 * 数字 0，与真实归零不可区分」而保守设为 false，但那个 `+` 不在 IPC 路径上 —— 它属于
 * `ResultData`，出口是 `player.PETEventOnReceived(...)`，送给 Flash/Ruffle 游戏本体。
 * 真正的落盘路径是 `setCookie(k, v, true)` → `saveOpt[k] = v + ""`（恒为字符串）
 * → `saveInfoData` → fishing/main.js 的 saveDatas，所以主进程收到的是 `"0"`，
 * 与空值可区分；且 yb 只由算术结果写入，cookie 缺失时的失败态是 `"NaN"`
 * （由下面的 not-finite 分支拦掉，不会被当成 0）。
 */
const FISHING_NUMERIC_FIELDS = [
  { key: "harvestfish", target: "fishing", allowZero: true },
  { key: "canusecnt", target: "fishing", allowZero: true },
  { key: "yb", target: "info", allowZero: true },
];

/**
 * 归一化钓鱼窗 saveDatas 的入参，产出可直接交给 setPetInfo 的 patch。
 * @param {unknown} data 渲染层传来的 data（可能是 undefined / 非对象）
 * @returns {{patch:object, rejected:string[], skipped:string[], hasChange:boolean, fishes:(Array|null)}}
 */
function normalizeFishingSave(data) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const patch = {};
  const rejected = [];
  const skipped = [];
  let fishes = null;

  if (d.fishes !== undefined && d.fishes !== null) {
    const r = normalizeFishes(d.fishes);
    if (r.apply) {
      patch.fishing = patch.fishing || {};
      patch.fishing.fishes = r.value;
      fishes = r.value;
    } else {
      rejected.push("fishes:" + r.reason);
    }
  }

  for (const field of FISHING_NUMERIC_FIELDS) {
    if (d[field.key] === undefined || d[field.key] === null) continue;
    const r = normalizePositiveNumber(d[field.key], { allowZero: field.allowZero });
    if (r.apply) {
      patch[field.target] = patch[field.target] || {};
      patch[field.target][field.key] = r.value;
    } else if (r.reason === "zero") {
      // yb 的 0 是按策略跳过，不是异常，单列出来避免污染 rejected 日志
      skipped.push(field.key + ":zero");
    } else {
      rejected.push(field.key + ":" + r.reason);
    }
  }

  return { patch, rejected, skipped, hasChange: Object.keys(patch).length > 0, fishes };
}

/** 渲染层是否要求回传最新宠物数据 */
function wantsPetInfo(data) {
  return !!(data && typeof data === "object" && data.getPetInfo);
}

/**
 * 从 activeOption 里挑出当前进行中的活动 key。
 * 三元链落到空串会导致 `obj[""]` 为 undefined，写属性直接 TypeError，这里统一返回 null。
 * @param {unknown} activeOption
 * @returns {"work"|"study"|"trip"|null}
 */
function pickActiveOptionKey(activeOption) {
  if (!activeOption || typeof activeOption !== "object") return null;
  if (activeOption.work) return "work";
  if (activeOption.study) return "study";
  if (activeOption.trip) return "trip";
  return null;
}

/**
 * 校验礼包领取的下标（inIndex + (current-1)*pageSize）是否落在列表内。
 * @param {unknown} payload {useType,inIndex,current,pageSize}
 * @param {unknown} list 当前礼包列表
 * @returns {{ok:true,index:number}|{ok:false,reason:string}}
 */
function resolveGiftIndex(payload, list) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (GIFT_USE_TYPES.indexOf(p.useType) === -1) return { ok: false, reason: "bad-useType" };
  if (!Array.isArray(list)) return { ok: false, reason: "no-list" };
  const inIndex = Number(p.inIndex);
  const current = Number(p.current);
  const pageSize = Number(p.pageSize);
  if (!Number.isInteger(inIndex) || inIndex < 0) return { ok: false, reason: "bad-inIndex" };
  if (!Number.isInteger(current) || current < 1) return { ok: false, reason: "bad-current" };
  if (!Number.isInteger(pageSize) || pageSize < 1) return { ok: false, reason: "bad-pageSize" };
  const index = inIndex + (current - 1) * pageSize;
  if (index >= list.length) return { ok: false, reason: "out-of-range" };
  if (!list[index] || typeof list[index] !== "object") return { ok: false, reason: "empty-item" };
  return { ok: true, index };
}

/**
 * 归一化 stateInfo 窗 stateInfo_bus-upData 的入参，产出可直接交给 setPetInfo 的 patch。
 *
 * 渲染层（popups/stateInfo/index.js）实际只会发两种 payload：
 * - {type:"openPetFile"}            —— 打开宠物资料卡（main.js 的 openPetFile 分支，不走本函数）
 * - {otherOptions:{sweetHeart:bool}} —— 开关甜心守护（doSweetHeart(true/false)）
 * 因此这里只放行 otherOptions.sweetHeart 一个布尔字段，其余一律丢弃，
 * 防止被注入的渲染层借 setPetInfo 全量改写宠物存档（yb/growth 等）。
 *
 * @param {unknown} data
 * @returns {{patch:object, rejected:string[], hasChange:boolean}}
 */
function normalizeStateInfoUpdate(data) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const patch = {};
  const rejected = [];
  for (const key of Object.keys(d)) {
    if (key === "type") continue; // type 仅用于 openPetFile 分支判别，本身不写入存档
    if (key !== "otherOptions") {
      rejected.push(key);
      continue;
    }
    const oo = d.otherOptions;
    if (!oo || typeof oo !== "object" || Array.isArray(oo)) {
      rejected.push("otherOptions:bad-type");
      continue;
    }
    for (const k of Object.keys(oo)) {
      if (k === "sweetHeart" && typeof oo[k] === "boolean") {
        patch.otherOptions = { sweetHeart: oo[k] };
      } else {
        rejected.push("otherOptions." + k);
      }
    }
  }
  return { patch, rejected, hasChange: Object.keys(patch).length > 0 };
}

module.exports = {
  ALLOWED_NAV_PROTOCOLS,
  MAX_FISHES,
  GIFT_USE_TYPES,
  FISHING_NUMERIC_FIELDS,
  isAllowedNavUrl,
  normalizePositiveNumber,
  normalizeFishes,
  normalizeFishingSave,
  normalizeStateInfoUpdate,
  wantsPetInfo,
  pickActiveOptionKey,
  resolveGiftIndex,
};
