"use strict";

/**
 * 粉钻（Pink Diamond）商城与开通规则，对齐官方 1.2.5：
 * - 粉钻生效期间商城购物 8 折（price * 0.8，四舍五入）。
 * - PD 专属商品未开通粉钻不可购买（商品表来自 goods_all_categories.json 的 PD:true 条目，
 *   shop.js 条目本身没有 PD 字段，故在此惰性加载一张 PD id 表）。
 * - 开通价格梯度：首开（粉钻成长值 growth 为 0）666 元宝/5 天；
 *   续费 pinkDiamondLevel * 888 元宝/5 天（level 为 0 时按 888 计）。
 *
 * 本模块是普通多行源码（非压缩产物），被 Goods.js / control/main.js 等压缩文件
 * 通过 eval("require") 以一行接入点引用；压缩区只留接入，逻辑都放这里。
 */

// 官方原文案（1.2.5 renderer.index.js）
const PD_ONLY_MSG = "你要帮我开通粉钻贵族才能购买哦~~";
const FIRST_OPEN_PRICE = 666;
const RENEW_BASE_PRICE = 888;
const FIRST_OPEN_TEXT = "限时花费666（原价888）元宝，开通粉钻5天，机不可失！~~";
const RENEW_TEXT = (price) => `开通粉钻需要${price}元宝，开通粉钻5天，助力宝宠成长玩耍~~`;

let pdGoodIds = null;

// 惰性加载 PD 商品 id 表（键统一为带前导下划线形式，与 shop.js 的 key 一致）
function loadPdGoodIds() {
  if (pdGoodIds) return pdGoodIds;
  pdGoodIds = new Set();
  try {
    const data = require("../../../assets/config/goods_all_categories.json");
    for (const cat of Object.keys(data)) {
      const items = data[cat];
      if (!items || typeof items !== "object") continue;
      for (const key of Object.keys(items)) {
        const item = items[key];
        if (item && item.PD === true && item.id) {
          pdGoodIds.add("_" + item.id);
        }
      }
    }
  } catch (err) {
    console.error("[pinkDiamondShop] 加载 PD 商品表失败:", err?.message || err);
  }
  return pdGoodIds;
}

// key 可能是 "_102010074"（shop.js 键）或 "102010074"（裸 id）
function isPdGood(key) {
  if (!key) return false;
  const k = String(key);
  const ids = loadPdGoodIds();
  return ids.has(k) || ids.has(k.startsWith("_") ? k : "_" + k);
}

// 粉钻是否生效中（petInfo.globals 由 ini/pet.js 注入；过期结算由 level.js 处理）
function isPinkDiamondActive() {
  try {
    return typeof getPetInfoOne === "function"
      ? !!getPetInfoOne("pinkDiamond", "otherOptions")
      : false;
  } catch (err) {
    return false;
  }
}

// 商城 8 折：仅对正价商品生效，未开通时原样返回
function applyPinkDiamondPrice(price) {
  price = +price;
  if (!(price > 0)) return price;
  return isPinkDiamondActive() ? Math.round(price * 0.8) : price;
}

// PD 专属商品购买门槛
function canBuy(key) {
  if (isPdGood(key) && !isPinkDiamondActive()) {
    return { ok: false, msg: PD_ONLY_MSG };
  }
  return { ok: true };
}

// otherOptions 即 getPetInfoOne("", "otherOptions") 的返回
function pinkDiamondPrice(otherOptions = {}) {
  const growth = +otherOptions.growth || 0;
  if (growth === 0) return FIRST_OPEN_PRICE;
  const level = +otherOptions.pinkDiamondLevel || 0;
  return (level >= 1 ? level : 1) * RENEW_BASE_PRICE;
}

function pinkDiamondText(otherOptions = {}) {
  const growth = +otherOptions.growth || 0;
  if (growth === 0) return FIRST_OPEN_TEXT;
  return RENEW_TEXT(pinkDiamondPrice(otherOptions));
}

module.exports = {
  PD_ONLY_MSG,
  FIRST_OPEN_PRICE,
  RENEW_BASE_PRICE,
  isPdGood,
  isPinkDiamondActive,
  applyPinkDiamondPrice,
  canBuy,
  pinkDiamondPrice,
  pinkDiamondText,
  // 仅供测试复位缓存
  _resetCache() {
    pdGoodIds = null;
  },
};
