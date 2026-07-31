"use strict";

/**
 * 商店弹窗官方 1.2.5 化（四区 + 真图标 + 官方贴图卡片 + 购物车）的防回归测试。
 * - 压缩区接入点（popups/store/main.js）做结构断言：接入点被误删即红；
 * - storeMallData 主进程模块做行为断言（官方分页 / 回退 / 粉钻字段 / PD 标志）；
 * - shop_tabs.json 与 shop.js 的一致性做数据断言（官方配置改动即红）；
 * - 渲染层（index.html/index.js/index.css）做官方结构类名断言。
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { listGoods } = require("../src/windows/util/storeMallData.js");
const { shop } = require("../src/windows/util/pet/shop.js");
const shopTabs = JSON.parse(readSource("src/assets/config/shop_tabs.json"));

/** 用真实 shop.js 数据模拟 Goods 接口（与 Goods.getGoodsInfo 同构的最小实现） */
const mockPetControl = () => ({
  Goods: {
    getOurGoods(cat) {
      const out = [];
      for (const k in shop[cat] || {}) out.push(cat + "*" + k);
      return out;
    },
    getGoodsInfo({ goodNames }) {
      return goodNames.map((g) => {
        const [c, k] = g.split("*");
        const o = shop[c] && shop[c][k];
        if (!o) return { name: g, state: "err" };
        return { ...o, keyName: k, icon: `../assets/img_res/${o.type}/${k.split("_")[1]}.gif`, valueList: {} };
      });
    },
  },
});

test("压缩区接入点：store_h_listGoods_m 走 storeMallData.listGoods", () => {
  const src = readSource("src/windows/popups/store/main.js");
  assert.ok(
    src.includes('store_h_listGoods_m:(e,t)=>{try{const type=t?.type;if(!type||!petControl?.Goods)return;const result=_require("../../util/storeMallData").listGoods(petControl,t||{});'),
    "store/main.js 的 store_h_listGoods_m 应调用 _require(\"../../util/storeMallData\").listGoods"
  );
  assert.ok(src.includes('s.webContents.send("store_m_goods_h",{type,...result})'), "回发事件 store_m_goods_h 结构应保持 {type,...result}");
});

test("压缩区接入点：购物车清空彩蛋（官方台词）走 openSpeak", () => {
  const src = readSource("src/windows/popups/store/main.js");
  assert.ok(src.includes('"cartCleared"==t.event'), "store/main.js 应处理 cartCleared 总线事件");
  assert.ok(
    src.includes("谢谢[host],帮我清空了购物车~~"),
    "彩蛋台词应与官方 1.2.5 原文一致"
  );
  assert.ok(src.includes("global.openSpeak"), "彩蛋应通过 global.openSpeak 气泡播放");
});

test("shop_tabs.json 各区分页与 shop.js 一致", () => {
  for (const mall of ["shopTj", "shopWy"]) {
    assert.ok(shopTabs[mall], `shop_tabs.json 缺少 ${mall}`);
    for (const type of ["food", "clean", "medicine"]) {
      const zone = shopTabs[mall][type];
      assert.ok(zone, `${mall} 缺少 ${type} 类`);
      const cat = type === "clean" ? "commodity" : type;
      for (const page of Object.keys(zone)) {
        assert.ok(zone[page].length <= 8, `${mall}.${type} 第 ${page} 页超过 8 个商品`);
        for (const id of zone[page]) {
          assert.ok(shop[cat][id], `${mall}.${type} 商品 ${id} 在 shop.js 的 ${cat} 类中不存在`);
        }
      }
    }
  }
  // 功能区（玩具）与装扮区（背景）：shopGN.nums / shopZB.skin 为在线数据，不在本地断言范围
  for (const [mall, type] of [["shopGN", "toy"], ["shopZB", "background"]]) {
    const zone = shopTabs[mall]?.[type];
    assert.ok(zone, `shop_tabs.json 缺少 ${mall}.${type}`);
    for (const page of Object.keys(zone)) {
      assert.ok(zone[page].length <= 8, `${mall}.${type} 第 ${page} 页超过 8 个商品`);
      for (const id of zone[page]) {
        assert.ok(shop[type][id], `${mall}.${type} 商品 ${id} 在 shop.js 的 ${type} 类中不存在`);
      }
    }
  }
});

test("listGoods 按官方分页返回并钳制页码", () => {
  const pc = mockPetControl();
  const r = listGoods(pc, { mallType: "shopWy", type: "food", current: 1 });
  assert.equal(r.total, 6, "shopWy.food 应有 6 页");
  assert.equal(r.current, 1);
  assert.ok(r.items.length > 0 && r.items.length <= 8);
  assert.ok(r.items.every((it) => +it.price > 0), "不可购商品（price<=0）应被过滤");
  assert.ok(r.items.every((it) => it.icon && it.keyName), "每个商品应带 icon 与 keyName");
  assert.equal(r.pinkDiamond, false, "无 getPetInfoOne 时 pinkDiamond 默认 false");

  const clamped = listGoods(pc, { mallType: "shopWy", type: "food", current: 99 });
  assert.equal(clamped.current, 6, "页码越界应钳制到末页");

  const clean = listGoods(pc, { mallType: "shopTj", type: "clean", current: 1 });
  assert.equal(clean.total, 1);
  assert.ok(clean.items.every((it) => it.type === "commodity"), "官方 clean 类应映射到 shop.js 的 commodity");
});

test("listGoods 支持功能区（玩具）与装扮区（背景）", () => {
  const pc = mockPetControl();
  const toy = listGoods(pc, { mallType: "shopGN", type: "toy", current: 1 });
  assert.equal(toy.mallType, "shopGN");
  assert.equal(toy.total, 1, "shopGN.toy 应为 1 页");
  assert.equal(toy.items.length, 8, "shopGN.toy 应有 8 件正价玩具");
  assert.ok(toy.items.every((it) => it.type === "toy" && +it.price > 0));

  const bg = listGoods(pc, { mallType: "shopZB", type: "background", current: 1 });
  assert.equal(bg.mallType, "shopZB");
  assert.equal(bg.total, 2, "shopZB.background 价格回填后应为 2 页（官方分页）");
  assert.equal(bg.items.length, 8, "第 1 页应为 8 件正价背景（无背景+背景1-6+背景10）");
  assert.ok(bg.items.every((it) => it.type === "background" && +it.price > 0));
});

test("listGoods 给商品打 PD（粉钻专属）标志", () => {
  const pc = mockPetControl();
  const bg1 = listGoods(pc, { mallType: "shopZB", type: "background", current: 1 });
  assert.ok(bg1.items.every((it) => it.pd === false), "背景区第 1 页（背景1-10）均非 PD");
  const bg2 = listGoods(pc, { mallType: "shopZB", type: "background", current: 2 });
  assert.deepEqual(bg2.items.map((it) => it.keyName), ["_b0000011", "_b0000013"], "第 2 页为官方分页的背景11/13");
  assert.ok(bg2.items.every((it) => it.pd === true), "背景区第 2 页（背景11/13）均为 PD 专属");

  const toy = listGoods(pc, { mallType: "shopGN", type: "toy", current: 1 });
  const normal = toy.items.find((it) => it.keyName === "_t0001");
  const pdToy = toy.items.find((it) => it.keyName === "_t0005");
  assert.equal(normal.pd, false, "白色MP3 不是 PD 商品");
  assert.equal(pdToy.pd, true, "黑色笔记本 是 PD 商品");
});

test("listGoods 无官方分区时回退全量逻辑", () => {
  const pc = mockPetControl();
  const r = listGoods(pc, { mallType: "shopGN", type: "food", current: 1 });
  assert.ok(r.total >= 1, "回退逻辑应至少返回一页");
  assert.ok(r.items.length > 0, "shopGN 无 food 分区，应回退到全量 food 列表");
  assert.ok(r.items.every((it) => +it.price > 0));
});

test("商店渲染层：官方 1.2.5 结构（四区 tab + rGoods 卡 + 分页条 + 浮层）", () => {
  const html = readSource("src/windows/popups/store/index.html");
  for (const frag of [
    "rscb_t_onve",      // 大区 tab（官方类名）
    "rscb_dowmOnce",    // 子类 tab
    "rGoods",           // 商品卡
    "rG_leftImg",       // 商品图标
    "goodFloatMsg",     // 悬停浮层
    "PD",               // 粉钻角标
    "rG_cart",          // 加购按钮
    "rG_pay",           // 立即购买按钮
    "rsfb_upMore",      // 分页：首页
    "rsfb_downMore",    // 分页：末页
    ':src="item.icon"', // 真图标
  ]) {
    assert.ok(html.includes(frag), `store/index.html 缺少 ${frag}`);
  }
  const js = readSource("src/windows/popups/store/index.js");
  assert.ok(js.includes('mallType: this.activeMall'), "store/index.js 请求应带 mallType");
  for (const mall of ['value:"shopTj"', 'value:"shopWy"', 'value:"shopGN"', 'value:"shopZB"']) {
    assert.ok(js.includes(mall), `store/index.js 应有 ${mall} 大区`);
  }
  assert.ok(js.includes("onIconError"), "store/index.js 应有图标加载失败兜底");
  assert.ok(js.includes("pinkPrice"), "store/index.js 应有粉钻价展示逻辑");
});

test("商店渲染层：官方 1.2.5 购物车（步进/合计/结算/彩蛋）", () => {
  const html = readSource("src/windows/popups/store/index.html");
  for (const frag of ["shoppingCartMain", "cartGood", "cg_cutUp", "cg_addDown", "cg_totalNum", "cg_totalPrice", "cartPayBtn"]) {
    assert.ok(html.includes(frag), `store/index.html 购物车缺少 ${frag}`);
  }
  const js = readSource("src/windows/popups/store/index.js");
  assert.ok(js.includes("addToCart"), "应有加购逻辑");
  assert.ok(js.includes("stepCart"), "应有数量步进（±1/±10）逻辑");
  assert.ok(js.includes("checkout"), "应有结算逻辑");
  assert.ok(js.includes("cartCleared"), "结算成功后应发送 cartCleared 触发彩蛋");
  const css = readSource("src/windows/popups/store/index.css");
  for (const frag of ["#542e037b", "#03a29a", "#b24c11", "s09.gif", "rt_bg_04.gif", "shopping_cartbg.gif", "Sale_Tag_BG.png"]) {
    assert.ok(css.includes(frag), `store/index.css 缺少官方样式/贴图 ${frag}`);
  }
});
