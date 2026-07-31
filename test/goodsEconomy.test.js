// Goods.js 经济链路回归测试：购买扣款/入库原子性、背包定位精确性、落盘同步性。
//
// Goods.js 是 webpack 压缩产物，运行期依赖一批全局函数（getPetInfoOne/setPetInfo/
// getCache/setCache/...），本文件按项目惯例用全局桩注入，不依赖任何三方包。
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

// ---- 全局桩：模仿 src/ini/pet.js 与 src/ini/tool.js 的对外契约 ----
let petInfo;
let cache;
let setCacheCalls;
let failSetCache = false;

global.getPetInfoOne = (k, g) => (g ? (k ? petInfo?.[g]?.[k] || "" : petInfo?.[g] || {}) : "");
global.setPetInfo = (d) => {
  for (const g of Object.keys(d)) Object.assign(petInfo[g], d[g]);
};
global.getCache = (k, up) => (up ? cache[up]?.[k] : cache[k]);
global.setCache = ({ name, value }) => {
  setCacheCalls.push(name);
  if (failSetCache) throw new Error("模拟磁盘写入失败");
  cache[name] = value;
};
global.isNumber = (e) => (+e == +e && +e) || 0;
global.countMaxPageSize = (e, t) => Math.ceil(e / t);
global.JSONto = (e) => JSON.parse(JSON.stringify(e));
global.getRandom = (a, b) => a;
global.getRandomArr = () => [];
global.tool = { getTime: () => "2026-07-31", getDayHourTime: () => 0 };
global.$test = false;

const { Goods } = require(path.join(SRC, "windows/util/pet/Goods.js"));
const { shop } = require(path.join(SRC, "windows/util/pet/shop.js"));

// 每个用例一套干净状态；backUseConsumables 默认「结算成功」，并记录是否被调用过
function makeGoods(store, opts = {}) {
  petInfo = {
    info: { yb: opts.yb === undefined ? 1000 : opts.yb },
    maxInfo: {},
    otherOptions: {},
  };
  cache = { store };
  setCacheCalls = [];
  failSetCache = false;
  const calls = { backUse: 0 };
  const g = new Goods({
    backUseConsumables: (e) => {
      calls.backUse++;
      return opts.backUseResult === undefined ? { type: e.type } : opts.backUseResult;
    },
  });
  return { g, calls };
}

function emptyStore(over = {}) {
  return { food: [], commodity: [], medicine: [], background: [], toy: [], ...over };
}

// 找一个真实的可购背景 key（price>0）
const bgKey = Object.keys(shop.background).find((k) => +shop.background[k].price > 0);

// ---------------------------------------------------------------- buy

test("buy 入库失败时不扣元宝且返回失败", () => {
  // 制造入库失败：background 类目缺失（历史上 cleanOurStoreGoods 会漏掉该键）
  const { g } = makeGoods(emptyStore());
  delete g.storeGoods.background;
  const before = petInfo.info.yb;
  const r = g.buy("background*" + bgKey);
  assert.equal(r.ok, false, "入库失败必须返回 ok:false");
  assert.equal(petInfo.info.yb, before, "入库失败不得扣除元宝");
});

test("buy 落盘失败时不扣元宝", () => {
  const { g } = makeGoods(emptyStore());
  failSetCache = true; // setCache 抛异常 -> toSaveGoodsCache 返回 false
  const before = petInfo.info.yb;
  const r = g.buy("background*" + bgKey);
  assert.equal(r.ok, false);
  assert.equal(petInfo.info.yb, before, "背包没落盘就扣钱会导致钱物两空");
});

test("buy 成功时扣款金额与入库数量一致", () => {
  const { g } = makeGoods(emptyStore());
  const price = +shop.background[bgKey].price;
  const r = g.buy("background*" + bgKey);
  assert.equal(r.ok, true);
  assert.equal(petInfo.info.yb, 1000 - price);
  assert.deepEqual(g.storeGoods.background, [bgKey + "-1"]);
});

test("buy 余额不足时既不扣款也不入库", () => {
  const { g } = makeGoods(emptyStore(), { yb: 0 });
  const r = g.buy("background*" + bgKey);
  assert.equal(r.ok, false);
  assert.equal(petInfo.info.yb, 0);
  assert.deepEqual(g.storeGoods.background, []);
});

test("cleanOurStoreGoods 保留 background 类目", () => {
  const { g } = makeGoods(emptyStore({ background: [bgKey + "-1"] }));
  g.cleanOurStoreGoods();
  assert.ok(Array.isArray(g.storeGoods.background), "background 键不能丢，否则买背景会扣钱不给货");
  assert.deepEqual(g.storeGoods.background, []);
  // 重置后仍能正常购买
  const r = g.buy("background*" + bgKey);
  assert.equal(r.ok, true);
  assert.deepEqual(g.storeGoods.background, [bgKey + "-1"]);
});

test("buy 已拥有的背景不重复扣款", () => {
  const { g } = makeGoods(emptyStore({ background: [bgKey + "-1"] }));
  const before = petInfo.info.yb;
  const r = g.buy("background*" + bgKey);
  assert.equal(r.ok, false);
  assert.equal(petInfo.info.yb, before);
});

// ---------------------------------------------------------------- toAddGoods

test("toAddGoods 按 key 精确匹配，不把 _10001030 串到 _100010300 上", () => {
  // shop.food 里 _10001030 是 _100010300.._100010309 的前缀，
  // 旧实现用 indexOf 前缀匹配会把它加到 _100010300 头上。
  assert.ok(shop.food["_10001030"], "前置：_10001030 必须存在于 shop.food");
  assert.ok(shop.food["_100010300"], "前置：_100010300 必须存在于 shop.food");
  const { g } = makeGoods(emptyStore({ food: ["_100010300-10"] }));
  assert.equal(g.toAddGoods({ good: "food*_10001030" }), true);
  assert.deepEqual(g.storeGoods.food, ["_100010300-10", "_10001030-1"]);
});

test("toAddGoods 同一 key 累加数量", () => {
  const { g } = makeGoods(emptyStore({ food: ["_10001030-2"] }));
  g.toAddGoods({ good: "food*_10001030" });
  assert.deepEqual(g.storeGoods.food, ["_10001030-3"]);
});

test("toAddGoods 未知类目返回 false 而不是异常对象", () => {
  const { g } = makeGoods(emptyStore());
  const r = g.toAddGoods({ good: "work*_bz" }); // work 不是背包类目
  assert.equal(r, false, "必须返回布尔 false，调用方靠它决定是否扣款");
});

// ---------------------------------------------------------------- useConsumables

test("useConsumables 背包里没有该道具时不结算效果", () => {
  const { g, calls } = makeGoods(emptyStore({ food: ["_100010032-7"] }));
  const r = g.useConsumables({ type: "food", keyName: "_100010031", num: "3" });
  assert.equal(r.ok, false);
  assert.equal(r.msg, "背包数据已变化，请刷新");
  assert.ok(r.overType, "必须带 overType，否则 store/control 的成功分支会误判为使用成功");
  assert.equal(calls.backUse, 0, "校验必须发生在结算属性效果之前");
  assert.deepEqual(g.storeGoods.food, ["_100010032-7"], "背包不得被改动");
});

test("useConsumables num 快照过期时按背包真实数量扣减，不误伤其它道具", () => {
  // 渲染层缓存的 num=3，但期间背包已变成 4（工作奖励发了同款道具）
  const { g } = makeGoods(emptyStore({ food: ["_100010031-4", "_100010032-7"] }));
  const r = g.useConsumables({ type: "food", keyName: "_100010031", num: "3" });
  assert.equal(r, true);
  assert.deepEqual(
    g.storeGoods.food,
    ["_100010031-3", "_100010032-7"],
    "应按真实数量 4->3，且 _100010032 不受影响"
  );
});

test("useConsumables 用掉最后一个时整条移除且不动其它道具", () => {
  const { g } = makeGoods(emptyStore({ food: ["_100010031-1", "_100010032-7"] }));
  const r = g.useConsumables({ type: "food", keyName: "_100010031", num: "1" });
  assert.equal(r, true);
  assert.deepEqual(g.storeGoods.food, ["_100010032-7"]);
});

test("useConsumables 数量为 0 的残留条目视为无货", () => {
  const { g, calls } = makeGoods(emptyStore({ food: ["_100010031-0"] }));
  const r = g.useConsumables({ type: "food", keyName: "_100010031", num: "0" });
  assert.equal(r.ok, false);
  assert.equal(calls.backUse, 0);
});

test("useConsumables 效果结算被拒时不扣减背包", () => {
  const { g } = makeGoods(emptyStore({ food: ["_100010031-2"] }), {
    backUseResult: { overType: "dead", msg: "您的宠物已死亡~~ " },
  });
  const r = g.useConsumables({ type: "food", keyName: "_100010031", num: "2" });
  assert.equal(r.overType, "dead");
  assert.deepEqual(g.storeGoods.food, ["_100010031-2"], "拒绝使用时数量不能减");
});

// ---------------------------------------------------------------- 落盘

test("toSaveGoodsCache 同步落盘，不留 1 秒防抖窗口", () => {
  const { g } = makeGoods(emptyStore({ food: ["_100010031-2"] }));
  g.useConsumables({ type: "food", keyName: "_100010031", num: "2" });
  // 不等任何定时器：调用返回时就必须已经写进 cache（否则进程立刻退出会丢改动 -> 道具可复制）
  assert.deepEqual(cache.store.food, ["_100010031-1"]);
  assert.ok(setCacheCalls.includes("store"));
});

test("toSaveGoodsCache 落盘失败返回 false 并留痕", () => {
  const { g } = makeGoods(emptyStore());
  failSetCache = true;
  const origErr = console.error;
  let logged = "";
  console.error = (...a) => {
    logged += a.join(" ");
  };
  try {
    assert.equal(g.toSaveGoodsCache(), false);
  } finally {
    console.error = origErr;
  }
  assert.match(logged, /背包落盘失败/);
});
