"use strict";

/**
 * 一次性数据脚本（不进 src）：对 shop.js 做两类"数据段定点替换"——
 * ① 在 background 类目前插入官方 1.2.5 的 toy 类目（8 条，字段对齐 shop.js 现有
 *    name/type/charm/intel/strong/clean/starve/desc/id/price/rectype 格式，保留 mood）；
 * ② 把 20 个 PD 粉钻专属商品（food 8 / commodity 6 / background 6）的 price:-1
 *    回填为 goods_all_categories.json 里的官方正价。
 *
 * 每处替换前验证锚在 shop.js 中恰好出现 1 次，否则中止不写盘。
 * 运行：node .tools/patch_shop_toy_and_pd.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SHOP_PATH = path.join(ROOT, "src/windows/util/pet/shop.js");
const goodsAll = require(path.join(ROOT, "src/assets/config/goods_all_categories.json"));

let src = fs.readFileSync(SHOP_PATH, "utf8");

function replaceOnce(anchor, replacement, label) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    console.error(`[中止] 锚不唯一（${count} 次）: ${label}`);
    process.exit(1);
  }
  src = src.split(anchor).join(replacement);
  console.log(`[ok] ${label}（锚 x1）`);
}

// ---------- ① toy 类目 ----------

// 字段对齐：官方 json 的 needLevel/useTimeing/group/url/PD 不进入 shop.js
// （shop.js 全库无这些字段；PD 门槛由 pinkDiamondShop.js 从 json 惰性加载）。
const toyKeys = Object.keys(goodsAll.toy);
const toyEntries = toyKeys.map((key) => {
  const it = goodsAll.toy[key];
  const entry =
    `${key}:{name:"${it.name}",type:"toy",charm:${it.charm},intel:${it.intel},` +
    `strong:${it.strong},clean:${it.clean},starve:0,mood:${it.mood},desc:"",` +
    `id:"${it.id}",price:${it.price},rectype:""}`;
  return entry;
});

console.log("--- toy 字段对齐表（官方 json -> shop.js） ---");
for (const key of toyKeys) {
  const it = goodsAll.toy[key];
  console.log(
    `${key} ${it.name} mood=${it.mood} price=${it.price}` +
      `${it.PD ? " PD" : ""}${it.needLevel ? ` needLevel=${it.needLevel}(不入库)` : ""}` +
      `${it.useTimeing ? ` useTimeing=${it.useTimeing}(不入库)` : ""}`
  );
}

const TOY_ANCHOR = 'rectype:"hot"}},background:{_b0000000:';
replaceOnce(
  TOY_ANCHOR,
  `rectype:"hot"}},toy:{${toyEntries.join(",")}},background:{_b0000000:`,
  "插入 toy 类目（8 条，位于 medicine 与 background 之间）"
);

// ---------- ② PD 价格回填 ----------

const PD_IDS = [
  "_100010070", "_100010297", "_100010394",
  "_102010074", "_102010075", "_102010076", "_102010077", "_102010078",
  "_100020101", "_102020051", "_102020052", "_102020053", "_102020054", "_102020055",
  "_b0000011", "_b0000012", "_b0000013", "_b0000014", "_b0000015", "_b0000016",
];

console.log("--- PD 价格回填对照表（-1 -> 官方价） ---");
for (const key of PD_IDS) {
  const cat = Object.keys(goodsAll).find((c) => goodsAll[c][key]);
  const it = cat && goodsAll[cat][key];
  if (!it || it.PD !== true) {
    console.error(`[中止] ${key} 在 goods_all_categories.json 中不存在或非 PD`);
    process.exit(1);
  }
  const anchor = `id:"${it.id}",price:-1`;
  replaceOnce(anchor, `id:"${it.id}",price:${it.price}`, `${key} ${it.name}: -1 -> ${it.price}`);
}

fs.writeFileSync(SHOP_PATH, src);
console.log(`[完成] shop.js 已写盘（${src.length} 字节）`);

// 写后校验：重新 require 确认数据形态
delete require.cache[require.resolve(SHOP_PATH)];
const { shop } = require(SHOP_PATH);
console.log("--- 写后校验 ---");
console.log("toy 条数:", Object.keys(shop.toy).length);
let bad = 0;
for (const key of PD_IDS) {
  for (const cat of Object.keys(shop)) {
    if (shop[cat][key]) {
      const p = shop[cat][key].price;
      if (!(p > 0)) { console.error(`${key} 价格仍非正: ${p}`); bad++; }
      else console.log(`${key} (${cat}) price=${p}`);
    }
  }
}
process.exit(bad ? 1 : 0);
