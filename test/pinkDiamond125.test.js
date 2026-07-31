"use strict";

/**
 * 1.2.5 粉钻链路移植的压缩区接入点防回归测试 + pinkDiamondShop 模块行为测试。
 * Goods.js / control 弹窗 / GrowUp.js 均为 webpack 压缩单行产物，按项目惯例做结构断言。
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const pds = require(path.join(ROOT, "src/windows/util/pet/pinkDiamondShop.js"));

// ---------- pinkDiamondShop 模块行为 ----------

test("pinkDiamondShop：PD 商品表加载 22 个官方 PD 商品", () => {
  const ids = [
    "_100010070", "_100010297", "_100010394",
    "_102010074", "_102010075", "_102010076", "_102010077", "_102010078",
    "_100020101", "_102020051", "_102020052", "_102020053", "_102020054", "_102020055",
    "_b0000011", "_b0000012", "_b0000013", "_b0000014", "_b0000015", "_b0000016",
    "_t0005", "_t0006",
  ];
  for (const id of ids) {
    assert.ok(pds.isPdGood(id), `${id} 应判定为 PD 商品`);
    assert.ok(pds.isPdGood(id.slice(1)), `裸 id ${id} 也应判定为 PD 商品`);
  }
  assert.ok(!pds.isPdGood("_102010001"), "普通商品不应误判为 PD 商品");
  assert.ok(!pds.isPdGood(""), "空 key 不应误判");
});

test("pinkDiamondShop：开通价格梯度（首开 666 / 续费 level*888，level 0 按 888）", () => {
  assert.strictEqual(pds.pinkDiamondPrice({ growth: 0 }), 666);
  assert.strictEqual(pds.pinkDiamondPrice({}), 666);
  assert.strictEqual(pds.pinkDiamondPrice({ growth: 100, pinkDiamondLevel: 1 }), 888);
  assert.strictEqual(pds.pinkDiamondPrice({ growth: 350, pinkDiamondLevel: 2 }), 1776);
  assert.strictEqual(pds.pinkDiamondPrice({ growth: 100, pinkDiamondLevel: 0 }), 888);
});

test("pinkDiamondShop：开通文案对齐官方", () => {
  assert.strictEqual(
    pds.pinkDiamondText({ growth: 0 }),
    "限时花费666（原价888）元宝，开通粉钻5天，机不可失！~~"
  );
  assert.strictEqual(
    pds.pinkDiamondText({ growth: 300, pinkDiamondLevel: 2 }),
    "开通粉钻需要1776元宝，开通粉钻5天，助力宝宠成长玩耍~~"
  );
});

test("pinkDiamondShop：8 折与 PD 门槛跟随全局 getPetInfoOne", () => {
  const old = global.getPetInfoOne;
  try {
    global.getPetInfoOne = (k, t) => (t === "otherOptions" && k === "pinkDiamond" ? true : "");
    assert.strictEqual(pds.applyPinkDiamondPrice(40), 32, "开通后 40 元宝应折为 32");
    assert.strictEqual(pds.applyPinkDiamondPrice(0), 0, "非正价不打折");
    assert.strictEqual(pds.applyPinkDiamondPrice(-1), -1, "price:-1 商品不打折");
    assert.deepStrictEqual(pds.canBuy("_102010074"), { ok: true }, "开通后 PD 商品通过门槛");

    global.getPetInfoOne = (k, t) => (t === "otherOptions" && k === "pinkDiamond" ? false : "");
    assert.strictEqual(pds.applyPinkDiamondPrice(40), 40, "未开通不打折");
    assert.deepStrictEqual(
      pds.canBuy("_102010074"),
      { ok: false, msg: "你要帮我开通粉钻贵族才能购买哦~~" },
      "未开通 PD 商品应拦截且用官方文案"
    );
    assert.deepStrictEqual(pds.canBuy("_102010001"), { ok: true }, "普通商品不受门槛影响");

    delete global.getPetInfoOne;
    assert.strictEqual(pds.applyPinkDiamondPrice(40), 40, "无全局环境降级不打折");
  } finally {
    if (old === undefined) delete global.getPetInfoOne;
    else global.getPetInfoOne = old;
  }
});

// ---------- shop.js PD 价格回填 ----------

test("shop.js：20 个 PD 商品价格已回填为官方正价（不再是 -1）", () => {
  const { shop } = require(path.join(ROOT, "src/windows/util/pet/shop.js"));
  const goodsAll = require(path.join(ROOT, "src/assets/config/goods_all_categories.json"));
  const catMap = { food: "food", clean: "commodity", background: "background" };
  let count = 0;
  for (const [jsonCat, shopCat] of Object.entries(catMap)) {
    for (const key of Object.keys(goodsAll[jsonCat])) {
      const official = goodsAll[jsonCat][key];
      if (official.PD !== true) continue;
      count++;
      const item = shop[shopCat] && shop[shopCat][key];
      assert.ok(item, `${key} 应在 shop.js 的 ${shopCat} 类中`);
      assert.strictEqual(item.price, official.price, `${key} ${official.name} 应回填官方价 ${official.price}`);
      assert.ok(item.price > 0, `${key} 回填后应可购买`);
    }
  }
  assert.strictEqual(count, 20, "food/clean/background 三类 PD 商品共 20 个");
});

// ---------- Goods.js 压缩区接入点 ----------

test("Goods.js：buy 接入 PD 门槛与 8 折（pinkDiamondShop 一行接入）", () => {
  const src = readSource("src/windows/util/pet/Goods.js");
  assert.ok(
    src.includes('const _pds=_require("./pinkDiamondShop.js"),_pdGate=_pds.canBuy(key);if(!_pdGate.ok)return _pdGate;'),
    "Goods.js buy 应在商品存在性校验后接入 canBuy 门槛"
  );
  assert.ok(
    src.includes("price=_pds.applyPinkDiamondPrice(price);const yb=+getPetInfoOne"),
    "Goods.js buy 应在 price<=0 拦截后接入 8 折"
  );
  assert.ok(
    src.includes('if(!price||price<=0)return{ok:!1,msg:"该商品不可购买（任务/送礼获取）"};'),
    "price<=0 拦截逻辑应保持不变"
  );
});

// ---------- control 弹窗压缩区接入点 ----------

test("control/main.js：粉钻扣费走梯度价格，不再有 200 硬编码", () => {
  const src = readSource("src/windows/popups/control/main.js");
  assert.ok(
    src.includes('pdPrice=_require("../../util/pet/pinkDiamondShop.js").pinkDiamondPrice(getPetInfoOne("","otherOptions"));if(n-pdPrice<0)'),
    "fz 扣费应以 pinkDiamondPrice 梯度计算"
  );
  assert.ok(src.includes("info:{yb:n-pdPrice}"), "扣费应为 yb:n-pdPrice");
  assert.ok(src.includes("还差￥${pdPrice-n}元宝"), "余额不足提示应回显梯度差价");
  assert.ok(!src.includes("n-200"), "不应残留 200 元宝硬编码");
  assert.ok(
    src.includes('if("fz"==o.type)return void t.webContents.send("control_bus-html_backDetermine",{event:"winShow",winType:"fz",text:_require("../../util/pet/pinkDiamondShop.js").pinkDiamondText('),
    "determine 应提供 fz 动态文案分支"
  );
});

test("control/index.js：开粉弹窗改为向 main 查询动态文案，去除 300 元宝写死", () => {
  const src = readSource("src/windows/popups/control/index.js");
  assert.ok(
    src.includes('if("fz"==e.type)return void window.electronAPI.control_ToMain_determine(JSON.stringify({type:"fz"}));'),
    "开粉菜单应改为 determine 查询"
  );
  assert.ok(
    src.includes('if("winShow"==t.event)return this.winShowText=t.text,this.winType=t.winType||"",void(this.winShow=!0);'),
    "winShow 回应应透传 winType 以支持确认购买"
  );
  assert.ok(!src.includes("300元宝"), "不应残留 300 元宝写死文案");
});

// ---------- GrowUp.js 压缩区接入点 ----------

test("GrowUp.js：粉钻成长速率固定 +10（对齐官方，不随等级缩放）", () => {
  const src = readSource("src/windows/util/pet/GrowUp.js");
  assert.ok(
    src.includes("e.otherOptions.pinkDiamond&&(t[2]=-10)"),
    "粉钻生效应固定 t[2]=-10（即 +10 成长速率）"
  );
  assert.ok(
    !src.includes("-10*(e.otherOptions.pinkDiamondLevel||0)"),
    "不应再按 pinkDiamondLevel 缩放加成"
  );
});
