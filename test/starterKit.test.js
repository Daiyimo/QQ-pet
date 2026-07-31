"use strict";

/**
 * 新手礼包（默认元宝 + 全道具各 10 个）的契约测试。
 *
 * buildStarterStore 本身可直接行为测试（shop.js 是纯数据模块，node 可直接 require）；
 * doMain.js 是 webpack 压缩单行文件，只能按项目惯例做结构断言，守住接入点不被后续改动误伤。
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { buildStarterStore, STARTER_ITEM_COUNT } = require("../src/windows/util/pet/starterKit.js");
const { shop } = require("../src/windows/util/pet/shop.js");

test("新手背包覆盖 shop.js 全部五类道具，每类各 10 个", () => {
  const store = buildStarterStore();
  for (const category of ["food", "commodity", "medicine", "background", "toy"]) {
    const expected = Object.keys(shop[category]);
    assert.strictEqual(store[category].length, expected.length, `${category} 数量应与 shop.js 商品数一致`);
    assert.deepStrictEqual(
      store[category],
      expected.map((key) => `${key}-${STARTER_ITEM_COUNT}`),
      `${category} 每个道具应为 <key>-10`
    );
  }
});

test("新手礼包不含 service / work / study / trip（非道具类目）", () => {
  const store = buildStarterStore();
  assert.deepStrictEqual(Object.keys(store), ["food", "commodity", "medicine", "background", "toy"]);
});

test("doMain.js 新宠物默认元宝为 999999999", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ini/doMain.js"), "utf8");
  assert.match(src, /yb:999999999/, "doMain.js 新宠物默认 yb 应为 999999999");
});

test("doMain.js 默认背包走 starterKit 接入点", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/ini/doMain.js"), "utf8");
  assert.match(
    src,
    /starterKit\.js"\)\.buildStarterStore\(\)/,
    "doMain.js 的默认背包应调用 starterKit.buildStarterStore()"
  );
  assert.ok(!src.includes('"_102010001-2"'), "旧的硬编码新手背包应已移除");
});
