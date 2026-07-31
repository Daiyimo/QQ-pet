"use strict";

/**
 * storeMallData.js —— 商店商城数据组装（官方 1.2.5 风格：推荐/元宝双区 + 三类分页）
 *
 * ## 背景
 * 旧版商店弹窗（src/windows/popups/store）是单区 tabs + 全量列表，
 * 卡片图标只有 emoji。官方 1.2.5 的商店是：
 *   - 四区：shopTj(推荐) / shopWy(喂养) / shopGN(功能-玩具) / shopZB(装扮-背景)
 *   - shopTj/shopWy 下分 food / clean / medicine 三类，shopGN 为 toy，shopZB 为 background，
 *     每页固定 8 个商品（shopGN.nums 充值、shopZB.skin 皮肤为在线数据，不做）
 * 官方分区配置已落盘在 src/assets/config/shop_tabs.json（与官方 1.2.5 逐字节一致），
 * 本模块负责把它和 Goods.js 的商品数据组装成渲染层可直接消费的「一页数据」。
 *
 * ## 关键映射与约定
 * - 官方 type `clean` 对应本项目 shop.js 的 category `commodity`；
 *   getGoodsInfo 查的是 `shop[category][key]`，所以组装 goodNames 时用
 *   `commodity*<id>`，但分页分组仍按官方 `clean` 维度。
 * - goodNames 形如 `food*_100010031`（Goods.getGoodsInfo 按 "*" 切分）。
 * - price ≤ 0 的商品直接过滤（不可购不上架）；官方分页里混有少数不可购商品，
 *   过滤后该页可能不足 8 个，页码仍保持官方分页不变。
 * - 没有 shop_tabs 对应分区（或配置文件缺失/损坏）时，回退到旧的
 *   getOurGoods 全量逻辑并自行分页，保证不比以前差。
 * - 粉钻：每个返回载荷带 `pinkDiamond` 布尔（取自
 *   global.getPetInfoOne("pinkDiamond","otherOptions")，取不到默认 false），
 *   折扣展示由渲染层负责，购买侧折扣由另一任务在 Goods.buy 内处理。
 *
 * 运行环境：主进程 CommonJS 模块，由 src/windows/popups/store/main.js 经
 * `_require("../../util/storeMallData")` 引入。
 */

const fs = require("fs");
const path = require("path");
const { isPdGood } = require("./pet/pinkDiamondShop.js");

/** 官方每页商品数（shop_tabs.json 每页 8 个，最后一页可不足） */
const DEFAULT_PAGE_SIZE = 8;

/** 官方 type → 本项目 shop.js category 的映射 */
const TYPE_TO_CATEGORY = Object.freeze({
  food: "food",
  clean: "commodity",
  medicine: "medicine",
  toy: "toy",
  background: "background",
});

/** 四区 type → 渲染层仍用旧事件字段 type 回发，故这里只做入参白名单 */
const MALL_TYPES = Object.freeze(["shopTj", "shopWy", "shopGN", "shopZB"]);

/** shop_tabs.json 只读一次并缓存；文件缺失/损坏时保持 null，走回退逻辑 */
let _shopTabsCache = undefined;
function loadShopTabs() {
  if (_shopTabsCache !== undefined) return _shopTabsCache;
  try {
    const file = path.join(__dirname, "../../assets/config/shop_tabs.json");
    _shopTabsCache = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.log("[storeMallData] shop_tabs.json 读取失败，回退全量列表:", e?.message || e);
    _shopTabsCache = null;
  }
  return _shopTabsCache;
}

/** 取粉钻状态；全局函数不可用时默认 false（不展示粉钻价） */
function getPinkDiamond() {
  try {
    if (typeof global.getPetInfoOne === "function") {
      return !!global.getPetInfoOne("pinkDiamond", "otherOptions");
    }
  } catch (e) {
    /* 忽略，默认非粉钻 */
  }
  return false;
}

/** 过滤出可购商品（price > 0 且查询未出错），并打上 PD（粉钻专属）标志 */
function pickBuyable(infos) {
  if (!Array.isArray(infos)) return [];
  return infos
    .filter((it) => it && it.state !== "err" && +it.price > 0)
    .map((it) => ({ ...it, pd: isPdGood(it.keyName) }));
}

/**
 * 按官方 shop_tabs 分区组装分页数据。
 * @returns {Array<Array<object>>|null} 页数组（每页为商品数组）；无对应分区时返回 null
 */
function buildOfficialPages(petControl, mallType, type) {
  const tabs = loadShopTabs();
  const category = TYPE_TO_CATEGORY[type];
  const zone = tabs?.[mallType]?.[type];
  if (!zone || !category) return null;

  // 页码是字符串数字键，按数值排序保证翻页顺序与官方一致
  const pageKeys = Object.keys(zone).sort((a, b) => +a - +b);
  if (pageKeys.length === 0) return null;

  // 一次性查出本类全部 id 的商品信息，再按页回填，避免逐页重复查询
  const ids = [...new Set(pageKeys.flatMap((p) => zone[p] || []))];
  const goodNames = ids.map((id) => `${category}*${id}`);
  const infos = pickBuyable(petControl.Goods.getGoodsInfo({ goodNames }));
  const byId = {};
  for (const it of infos) byId[it.keyName] = it;

  // 不可购商品（price<=0）被过滤后可能出现整页空白（如 shopZB.background 第 1 页
  // 全是 price=-1 的免费背景），空页直接剔除，避免出现「翻过去一片空白」
  const pages = pageKeys.map((p) => (zone[p] || []).map((id) => byId[id]).filter(Boolean));
  const nonEmpty = pages.filter((page) => page.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : pages;
}

/**
 * 回退逻辑：旧的 getOurGoods 全量列表（按数值排序保证稳定），自行分页。
 * @returns {Array<Array<object>>} 页数组（至少一页，可能为空页）
 */
function buildFallbackPages(petControl, type, pageSize) {
  const category = TYPE_TO_CATEGORY[type] || type;
  const keys = petControl.Goods.getOurGoods(category);
  const infos = pickBuyable(petControl.Goods.getGoodsInfo({ goodNames: keys }));
  infos.sort((a, b) => +a.price - +b.price);
  const pages = [];
  for (let i = 0; i < infos.length; i += pageSize) pages.push(infos.slice(i, i + pageSize));
  return pages.length > 0 ? pages : [[]];
}

/**
 * 商店列表主入口（store_h_listGoods_m 调用）。
 *
 * @param {object} petControl 主进程宠物控制器（需含 Goods）
 * @param {object} opt
 * @param {string} opt.mallType 分区：shopTj(推荐) / shopWy(喂养) / shopGN(功能) / shopZB(装扮)，缺省 shopTj
 * @param {string} opt.type    类目：food / clean / medicine / toy / background（官方命名）
 * @param {number} [opt.current=1] 页码（1 基，越界自动钳制）
 * @param {number} [opt.pageSize=8] 每页数量（仅回退逻辑使用；官方分页恒为配置页）
 * @returns {{items:object[], total:number, current:number, pageSize:number,
 *            mallType:string, type:string, pinkDiamond:boolean}}
 */
function listGoods(petControl, opt = {}) {
  const mallType = MALL_TYPES.includes(opt.mallType) ? opt.mallType : "shopTj";
  const type = opt.type;
  const pageSize = +opt.pageSize > 0 ? +opt.pageSize : DEFAULT_PAGE_SIZE;

  if (!type || !petControl?.Goods) {
    return { items: [], total: 0, current: 0, pageSize, mallType, type: type || "", pinkDiamond: getPinkDiamond() };
  }

  const pages = buildOfficialPages(petControl, mallType, type) || buildFallbackPages(petControl, type, pageSize);

  const total = pages.length;
  let current = Math.floor(+opt.current) || 1;
  current = Math.min(Math.max(current, 1), total);

  return {
    items: pages[current - 1] || [],
    total,
    current,
    pageSize,
    mallType,
    type,
    pinkDiamond: getPinkDiamond(),
  };
}

module.exports = { listGoods, DEFAULT_PAGE_SIZE, TYPE_TO_CATEGORY, MALL_TYPES };
