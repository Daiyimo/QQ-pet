// 一次性脚本：把 shop.js 里 11 个背景商品 price:-1 回填为官方价（goods_all_categories.json）。
// 官方 1.2.5 装扮商城按页出售背景（shop_tabs.json shopZB.background 第 1 页就是这批），
// 本地此前全部 price:-1 导致装扮区第 1 页空页、第 2 页只剩 2 件。
// 用法：node .tools/patch_background_prices.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const shopPath = path.join(ROOT, "src/windows/util/pet/shop.js");
const goodsPath = path.join(ROOT, "src/assets/config/goods_all_categories.json");

const goods = JSON.parse(fs.readFileSync(goodsPath, "utf8"));
const official = goods.background;

let src = fs.readFileSync(shopPath, "utf8");
const changes = [];

for (const key of Object.keys(official)) {
  const price = official[key].price;
  if (typeof price !== "number" || price <= 0) continue;
  // 仅处理 shop.js 中现存的、price 为 -1 的背景条目（PD 背景此前已回填，跳过）
  const re = new RegExp(`(${key.replace("_", "\\_")}:\\{[^}]*?price:)(-1)([,\\}])`);
  const m = src.match(re);
  if (!m) continue; // 已回填或不存在
  src = src.replace(re, `$1${price}$3`);
  changes.push(`${key} ${official[key].name}: -1 -> ${price}`);
}

if (changes.length === 0) {
  console.log("没有需要回填的条目");
} else {
  fs.writeFileSync(shopPath, src);
  console.log(`已回填 ${changes.length} 个背景价格：`);
  changes.forEach((c) => console.log(" ", c));
}

// 写后校验：shop.js 可加载且背景价格与官方一致
delete require.cache[require.resolve(shopPath)];
const { shop } = require(shopPath);
let bad = 0;
for (const key of Object.keys(official)) {
  const want = official[key].price;
  const got = shop.background?.[key]?.price;
  if (got !== want) {
    console.log(`MISMATCH ${key}: shop.js=${got} 官方=${want}`);
    bad++;
  }
}
console.log(bad === 0 ? "校验通过：全部背景价格与官方一致" : `校验失败 ${bad} 处`);
process.exit(bad === 0 ? 0 : 1);
