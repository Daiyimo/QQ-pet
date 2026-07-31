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

// ---- 落盘失败必须回滚内存（否则物品白拿）----
// 只「不扣元宝」是不够的：a() 已经把物品写进 this.storeGoods，若不回滚，
// 之后任意一次成功的 toSaveGoodsCache()（例如用掉另一件道具）会把这件
// 没付钱的物品持久化下来。

test("buy 落盘失败时内存不残留物品", () => {
  const { g } = makeGoods(emptyStore());
  failSetCache = true;
  const r = g.buy("background*" + bgKey);
  assert.equal(r.ok, false);
  assert.deepEqual(g.storeGoods.background, [], "落盘失败必须回滚内存，不能留下白拿的物品");
});

test("buy 落盘失败后再成功落盘，不会把白拿的物品带进存档", () => {
  const { g } = makeGoods(emptyStore({ food: ["_100010031-2"] }));
  failSetCache = true;
  assert.equal(g.buy("background*" + bgKey).ok, false);
  // 恢复磁盘后做一次正常操作，触发成功落盘
  failSetCache = false;
  assert.equal(g.useConsumables({ type: "food", keyName: "_100010031", num: "2" }), true);
  assert.deepEqual(cache.store.background, [], "上一次失败购买的物品不得被后续落盘顺带持久化");
  assert.deepEqual(cache.store.food, ["_100010031-1"]);
});

test("toAddGoods 落盘失败时返回 false 且内存回滚到原样", () => {
  // 期望值必须与传进 store 的数组解耦：emptyStore 是浅展开，storeGoods.food 与
  // 传入的数组是同一对象，就地改写会连带污染期望值。
  const { g } = makeGoods(emptyStore({ food: ["_100010031-2", "_100010032-7"] }));
  failSetCache = true;
  const r = g.toAddGoods({ good: "food*_100010031" });
  assert.equal(r, false, "落盘失败必须返回 false");
  assert.deepEqual(
    g.storeGoods.food,
    ["_100010031-2", "_100010032-7"],
    "数量不得停留在 +1 后的状态"
  );
});

test("toAddGoods 落盘失败时新建条目也被回滚", () => {
  const { g } = makeGoods(emptyStore({ food: [] }));
  failSetCache = true;
  assert.equal(g.toAddGoods({ good: "food*_100010031" }), false);
  assert.deepEqual(g.storeGoods.food, [], "新 push 的条目必须一并回滚");
});

test("toAddGoods 批量入库中途抛错时整批回滚", () => {
  const { g } = makeGoods(emptyStore({ food: ["_100010031-1"], toy: [] }));
  // 第 2 件的类目不存在 -> a() 抛错，此时第 1 件已经写进内存
  const r = g.toAddGoods({
    goods: ["food*_100010031", "work*_bz", "toy*_t0001"],
  });
  assert.equal(r, false);
  assert.deepEqual(g.storeGoods.food, ["_100010031-1"], "抛错前已入库的那件必须回滚");
  assert.deepEqual(g.storeGoods.toy, [], "抛错后未处理的那件当然不该入库");
});

test("toAddGoods 回滚是就地还原，共享同一数组的缓存持有者也不残留", () => {
  // getConsumables 用 {...默认值, ...getCache("store")} 浅展开，storeGoods 的类目数组
  // 与 $Store 里的是同一对象；回滚若用整体赋值，别名持有者会留着 +1 后的脏数据。
  const store = emptyStore({ food: ["_100010031-1"] });
  const aliased = store.food;
  const { g } = makeGoods(store);
  assert.equal(g.storeGoods.food, aliased, "前置：确认存在别名共享");
  failSetCache = true;
  assert.equal(g.toAddGoods({ good: "food*_100010031" }), false);
  assert.deepEqual(aliased, ["_100010031-1"], "别名持有的数组也必须被还原");
});

test("toAddGoods 成功路径不受回滚快照影响", () => {
  const { g } = makeGoods(emptyStore({ food: ["_100010031-2"], toy: [] }));
  const r = g.toAddGoods({ goods: ["food*_100010031", "toy*_t0001"] });
  assert.equal(r, true);
  assert.deepEqual(g.storeGoods.food, ["_100010031-3"]);
  assert.deepEqual(g.storeGoods.toy, ["_t0001-1"]);
  assert.deepEqual(cache.store.food, ["_100010031-3"], "成功时应已落盘");
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
