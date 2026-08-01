// Goods.buy 扣款失败的背包回滚测试（修复点：入库成功但 setPetInfo 抛错时"免费拿货"）。
// 运行：node --test test/buyRollback.test.js
//
// 桩 harness 与 test/goodsEconomy.test.js 同风格（全局桩注入，不依赖三方包）。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

let petInfo;
let cache;
let failSetPetInfo = false;

global.getPetInfoOne = (k, g) => (g ? (k ? petInfo?.[g]?.[k] || "" : petInfo?.[g] || {}) : "");
global.setPetInfo = (d) => {
  if (failSetPetInfo) throw new Error("模拟存档写入失败");
  for (const g of Object.keys(d)) Object.assign(petInfo[g], d[g]);
};
global.getCache = (k, up) => (up ? cache[up]?.[k] : cache[k]);
global.setCache = ({ name, value }) => {
  cache[name] = value;
};
global.isNumber = (e) => (+e == +e && +e) || 0;
global.countMaxPageSize = (e, t) => Math.ceil(e / t);
global.JSONto = (e) => JSON.parse(JSON.stringify(e));
global.getRandom = (a, b) => a;
global.getRandomArr = () => [];
global.tool = { getTime: () => "2026-08-01", getDayHourTime: () => 0 };
global.$test = false;

const { Goods } = require(path.join(SRC, "windows/util/pet/Goods.js"));
const { shop } = require(path.join(SRC, "windows/util/pet/shop.js"));

function makeGoods(store, opts = {}) {
  petInfo = { info: { yb: opts.yb === undefined ? 1000 : opts.yb }, maxInfo: {}, otherOptions: {} };
  cache = { store };
  failSetPetInfo = false;
  return new Goods({});
}

function emptyStore(over = {}) {
  return { food: [], commodity: [], medicine: [], background: [], toy: [], ...over };
}

const bgKey = Object.keys(shop.background).find((k) => +shop.background[k].price > 0);

test("buy 扣款抛错时返回失败、不扣元宝、背包内存回滚", () => {
  const g = makeGoods(emptyStore({ food: ["_100010031-2"] }));
  failSetPetInfo = true;
  const origErr = console.error;
  let logged = "";
  console.error = (...a) => {
    logged += a.join(" ");
  };
  let r;
  try {
    r = g.buy("background*" + bgKey);
  } finally {
    console.error = origErr;
  }
  assert.equal(r.ok, false, "扣款失败必须返回 ok:false");
  assert.equal(petInfo.info.yb, 1000, "没扣成款就不能改余额");
  assert.deepEqual(g.storeGoods.background, [], "内存里不得留下白拿的背景");
  assert.deepEqual(g.storeGoods.food, ["_100010031-2"], "回滚不得误伤其它类目");
  assert.match(logged, /扣款失败，已回滚背包/, "回滚必须留完整日志");
});

test("buy 扣款抛错时回滚会重新落盘，缓存里也不残留", () => {
  const g = makeGoods(emptyStore());
  failSetPetInfo = true;
  const origErr = console.error;
  console.error = () => {};
  try {
    assert.equal(g.buy("background*" + bgKey).ok, false);
  } finally {
    console.error = origErr;
  }
  assert.deepEqual(cache.store.background, [], "落盘的背包也必须是回滚后的状态");
});

test("buy 扣款失败后再正常购买，不会把上次白拿的物品带进背包", () => {
  const g = makeGoods(emptyStore());
  failSetPetInfo = true;
  const origErr = console.error;
  console.error = () => {};
  try {
    assert.equal(g.buy("background*" + bgKey).ok, false);
  } finally {
    console.error = origErr;
  }
  // 存档恢复后正常买另一件（避开粉钻专属商品）
  failSetPetInfo = false;
  const { canBuy } = require(path.join(SRC, "windows/util/pet/pinkDiamondShop.js"));
  const foodKey = Object.keys(shop.food).find((k) => +shop.food[k].price > 0 && canBuy(k).ok);
  const r = g.buy("food*" + foodKey);
  assert.equal(r.ok, true);
  assert.deepEqual(g.storeGoods.background, [], "上次失败购买的物品不得残留");
  assert.deepEqual(g.storeGoods.food, [foodKey + "-1"]);
});

test("buy 正常路径不受快照回滚影响", () => {
  const g = makeGoods(emptyStore());
  const price = +shop.background[bgKey].price;
  const r = g.buy("background*" + bgKey);
  assert.equal(r.ok, true);
  assert.equal(petInfo.info.yb, 1000 - price);
  assert.deepEqual(g.storeGoods.background, [bgKey + "-1"]);
  assert.deepEqual(cache.store.background, [bgKey + "-1"], "成功时背包应已落盘");
});
