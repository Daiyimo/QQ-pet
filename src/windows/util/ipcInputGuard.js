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
 * 把不可信数值归一化为「可写入存档的正数」。
 * 规则：非有限数 → 拒绝；负数 → 钳到 0；0 视为「不写入」（与历史真值语义一致，
 * 避免渲染层每次都带 0 把既有值清掉）。
 * @param {unknown} raw
 * @returns {{apply:boolean, value:number, reason?:string, clamped?:boolean}}
 */
function normalizePositiveNumber(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return { apply: false, value: 0, reason: "not-finite" };
  let value = Math.trunc(n);
  let clamped = false;
  if (value < 0) {
    value = 0;
    clamped = true;
  }
  if (value === 0) return { apply: false, value: 0, reason: "zero", clamped };
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
 * 归一化钓鱼窗 saveDatas 的入参，产出可直接交给 setPetInfo 的 patch。
 * @param {unknown} data 渲染层传来的 data（可能是 undefined / 非对象）
 * @returns {{patch:object, rejected:string[], hasChange:boolean, fishes:(Array|null)}}
 */
function normalizeFishingSave(data) {
  const d = data && typeof data === "object" ? data : {};
  const patch = {};
  const rejected = [];
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

  for (const key of ["harvestfish", "canusecnt"]) {
    if (d[key] === undefined || d[key] === null) continue;
    const r = normalizePositiveNumber(d[key]);
    if (r.apply) {
      patch.fishing = patch.fishing || {};
      patch.fishing[key] = r.value;
    } else if (r.reason !== "zero") {
      rejected.push(key + ":" + r.reason);
    }
  }

  if (d.yb !== undefined && d.yb !== null) {
    const r = normalizePositiveNumber(d.yb);
    if (r.apply) {
      patch.info = { yb: r.value };
    } else if (r.reason !== "zero") {
      rejected.push("yb:" + r.reason);
    }
  }

  return { patch, rejected, hasChange: Object.keys(patch).length > 0, fishes };
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

module.exports = {
  ALLOWED_NAV_PROTOCOLS,
  MAX_FISHES,
  GIFT_USE_TYPES,
  isAllowedNavUrl,
  normalizePositiveNumber,
  normalizeFishes,
  normalizeFishingSave,
  wantsPetInfo,
  pickActiveOptionKey,
  resolveGiftIndex,
};
