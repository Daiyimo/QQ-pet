"use strict";

/**
 * 官方 1.2.5 玩具（toy）分类接入的防回归测试。
 * - shop.js 的 toy 类目做数据断言（与 goods_all_categories.json 官方数据对齐）；
 * - Goods.js / State.js / control 弹窗均为 webpack 压缩单行产物，按项目惯例做结构断言；
 * - State.useConsumables 的 toy mood 结算、Goods.buy 的 toy 购买做行为测试（node 直接 require）。
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { shop } = require(path.join(ROOT, "src/windows/util/pet/shop.js"));
const goodsAll = require(path.join(ROOT, "src/assets/config/goods_all_categories.json"));
const shopTabs = JSON.parse(readSource("src/assets/config/shop_tabs.json"));

// ---------- shop.js toy 类目数据 ----------

test("shop.js：toy 类目 8 条，字段与官方 goods_all_categories.json 对齐", () => {
  assert.ok(shop.toy, "shop.js 应有 toy 类目");
  const keys = Object.keys(shop.toy);
  assert.strictEqual(keys.length, 8, "toy 类目应有 8 个商品");
  for (const key of keys) {
    const official = goodsAll.toy[key];
    assert.ok(official, `${key} 应存在于官方 toy 数据`);
    const item = shop.toy[key];
    // 对齐 shop.js 现有条目格式：name/type/charm/intel/strong/clean/starve/desc/id/price/rectype + mood
    for (const field of ["name", "type", "charm", "intel", "strong", "clean", "starve", "mood", "desc", "id", "price", "rectype"]) {
      assert.ok(field in item, `${key} 缺少字段 ${field}`);
    }
    assert.strictEqual(item.type, "toy", `${key} type 应为 toy（图标路径落到 img_res/toy/）`);
    assert.strictEqual(item.name, official.name, `${key} name 应与官方一致`);
    assert.strictEqual(item.mood, official.mood, `${key} mood 应与官方一致`);
    assert.strictEqual(item.price, official.price, `${key} price 应取官方价`);
    assert.strictEqual(item.charm, official.charm, `${key} charm 应与官方一致`);
    assert.strictEqual(item.intel, official.intel, `${key} intel 应与官方一致`);
    assert.strictEqual(item.strong, official.strong, `${key} strong 应与官方一致`);
    assert.ok(item.price > 0, `${key} 应可购买（含 2 个 PD 笔记本，直接用官方正价）`);
  }
  assert.strictEqual(shop.toy._t0005.price, 385, "PD 黑色笔记本官方价 385");
  assert.strictEqual(shop.toy._t0006.price, 640, "PD 红色笔记本官方价 640");
});

test("shop.js：toy 图标素材存在（img_res/toy/<id>.png）", () => {
  for (const key of Object.keys(shop.toy)) {
    const id = shop.toy[key].id;
    assert.ok(
      fs.existsSync(path.join(ROOT, "src/assets/img_res/toy", `${id}.png`)),
      `缺少玩具图标 ${id}.png`
    );
  }
});

test("shop_tabs.json：shopGN.toy 官方分区与 shop.js 一致", () => {
  const zone = shopTabs.shopGN && shopTabs.shopGN.toy;
  assert.ok(zone, "shop_tabs.json 缺少 shopGN.toy 分区");
  for (const page of Object.keys(zone)) {
    for (const id of zone[page]) {
      assert.ok(shop.toy[id], `shopGN.toy 商品 ${id} 在 shop.js 的 toy 类中不存在`);
    }
  }
});

// ---------- 压缩区接入点结构断言 ----------

test("Goods.js：背包 storeGoods 加 toy，玩具图标走 .png", () => {
  const src = readSource("src/windows/util/pet/Goods.js");
  assert.ok(
    src.includes("storeGoods={food:[],commodity:[],medicine:[],background:[],toy:[]}"),
    "storeGoods 初始结构应含 toy:[]"
  );
  assert.ok(
    src.includes('getConsumables(e){this.storeGoods={food:[],commodity:[],medicine:[],background:[],toy:[],...getCache("store")}'),
    "getConsumables 应归一化旧存档（缺少 toy 的历史 store 也能用玩具）"
  );
  assert.ok(
    src.includes('icon:`../assets/img_res/${o.type}/${a}.${"toy"==o.type?"png":"gif"}`'),
    "getGoodsInfo 图标应对 toy 用 .png（img_res/toy 下是 png 素材）"
  );
});

test("ini/pet.js：默认背包 cache 含 toy 类", () => {
  const src = readSource("src/ini/pet.js");
  assert.ok(
    src.includes("store:{food:[],commodity:[],medicine:[],background:[],toy:[]}"),
    "pet.js 的 cache.store 默认值应含 toy:[]"
  );
});

test("State.js：useConsumables 补 toy 分支，mood 按条目值结算、上限 1000", () => {
  const src = readSource("src/windows/util/pet/State.js");
  assert.ok(
    src.includes('if("toy"==t.type){let r=isNumber(e.info.mood)+(+t.mood||0);l.info||(l.info={}),l.info.mood=r>1e3?1e3:r}'),
    "useConsumables 应有 toy mood 结算分支"
  );
  assert.ok(
    src.includes('"food"!=t.type&&"commodity"!=t.type&&"toy"!=t.type||'),
    "toy 使用后应与 food/commodity 同走状态回调"
  );
});

test("control/index.js：日常 tab 加玩具入口", () => {
  const src = readSource("src/windows/popups/control/index.js");
  assert.ok(
    src.includes("children:[n.food,n.clean,n.cure,n.toy]"),
    "日常 tab children 应含 n.toy（顺序按官方 1.2.5：食物/清洁/吃药/玩具）"
  );
  assert.ok(
    src.includes('toy:{value:"toy",type:"toy",name:"玩具",icon:"../assets/control/icons/wanshua.png"}'),
    "菜单项定义表应有 toy 项"
  );
  assert.ok(
    fs.existsSync(path.join(ROOT, "src/assets/control/icons/wanshua.png")),
    "玩具入口图标 wanshua.png 应存在"
  );
});

test("control/main.js：useActiveData 消耗品分支覆盖 toy", () => {
  const src = readSource("src/windows/popups/control/main.js");
  assert.ok(
    src.includes('"food"==i.type||"commodity"==i.type||"medicine"==i.type||"toy"==i.type'),
    "使用道具分支应包含 toy"
  );
});

// ---------- 行为测试 ----------

function withGlobals(globals, fn) {
  const names = Object.keys(globals);
  const old = {};
  for (const n of names) old[n] = global[n];
  Object.assign(global, globals);
  try {
    return fn();
  } finally {
    for (const n of names) {
      if (old[n] === undefined) delete global[n];
      else global[n] = old[n];
    }
  }
}

const healthyPet = (mood = 500) => ({
  info: { hunger: 2000, clean: 2000, mood, health: 5, charm: 10, intel: 10, strong: 10 },
  maxInfo: { hunger: 3000, clean: 3000, mood: 1000, charm: 99999, intel: 99999, strong: 99999 },
  activeOption: { ill: null },
});

test("State.useConsumables：玩具加 mood 与属性，mood 上限 1000", () => {
  withGlobals(
    {
      getRatio: () => false,
      getRandom: (a) => a,
      isNumber: (v) => (Number.isFinite(Number(v)) ? Number(v) : 0),
    },
    () => {
      const { State } = require(path.join(ROOT, "src/windows/util/pet/State.js"));
      let saved = null;
      global.setPetInfo = (x) => { saved = x; };

      global.getPetInfo = () => healthyPet(500);
      const st = new State({ callBackState: () => {} });
      const r = st.useConsumables({ ...shop.toy._t0001, type: "toy" });
      assert.strictEqual(r.type, "toy");
      assert.strictEqual(saved.info.mood, 700, "白色MP3 mood 500+200=700");
      assert.strictEqual(saved.info.charm, 11, "白色MP3 charm 10+1=11");

      global.getPetInfo = () => healthyPet(950);
      const st2 = new State({ callBackState: () => {} });
      st2.useConsumables({ ...shop.toy._t0006, type: "toy" });
      assert.strictEqual(saved.info.mood, 1000, "mood 950+400 应被钳到上限 1000");
    }
  );
});

test("Goods.buy：玩具可购、PD 玩具受粉钻门槛且开通后 8 折", () => {
  withGlobals(
    {
      getCache: (n) => ({ store: { food: [], commodity: [], medicine: [], background: [], toy: [] } }[n] || []),
      setCache: () => {},
      countMaxPageSize: (l, p) => Math.ceil(l / p),
    },
    () => {
      let yb = 1000;
      let pd = false;
      global.getPetInfoOne = (k, t) =>
        "yb" === k && "info" === t ? yb : "pinkDiamond" === k && "otherOptions" === t ? pd : "";
      global.setPetInfo = (x) => { if (x.info && x.info.yb != null) yb = x.info.yb; };

      const { Goods } = require(path.join(ROOT, "src/windows/util/pet/Goods.js"));
      const g = new Goods({});

      const r1 = g.buy("toy*_t0001");
      assert.strictEqual(r1.ok, true, "普通玩具应可购买");
      assert.strictEqual(yb, 920, "白色MP3 官方价 80");
      assert.deepStrictEqual(g.storeGoods.toy, ["_t0001-1"], "玩具应进背包 toy 类");

      const r2 = g.buy("toy*_t0005");
      assert.strictEqual(r2.ok, false, "PD 玩具未开通粉钻应拦截");
      assert.strictEqual(r2.msg, "你要帮我开通粉钻贵族才能购买哦~~");

      pd = true;
      yb = 1000;
      const r3 = g.buy("toy*_t0005");
      assert.strictEqual(r3.ok, true, "开通粉钻后 PD 玩具可购");
      assert.strictEqual(yb, 692, "PD 黑色笔记本 385 元宝 8 折应为 308");

      yb = 1000;
      const r4 = g.buy("food*_102010074");
      assert.strictEqual(r4.ok, true, "回填价后的 PD 食品可购");
      assert.strictEqual(yb, 488, "香辣大对虾 640 元宝 8 折应为 512");

      yb = 5000;
      const r5 = g.buy("background*_b0000011");
      assert.strictEqual(r5.ok, true, "回填价后的 PD 背景可购");
      assert.strictEqual(yb, 3464, "背景11 1920 元宝 8 折应为 1536");
      assert.deepStrictEqual(g.storeGoods.background, ["_b0000011-1"], "背景应进背包 background 类");

      clearTimeout(g.saveTimes); // 拦下 toSaveGoodsCache 的延迟 setCache，避免测试结束后异步触发
    }
  );
});

test("Goods.getConsumables：旧存档（无 toy 键）归一化后玩具可买可用", () => {
  withGlobals(
    {
      // 模拟历史存档：store 只有四类，没有 toy
      getCache: (n) => ({ store: { food: [], commodity: [], medicine: [], background: [] } }[n] || []),
      setCache: () => {},
      countMaxPageSize: (l, p) => Math.ceil(l / p),
    },
    () => {
      let yb = 1000;
      global.getPetInfoOne = (k, t) => ("yb" === k && "info" === t ? yb : "");
      global.setPetInfo = (x) => { if (x.info && x.info.yb != null) yb = x.info.yb; };

      const { Goods } = require(path.join(ROOT, "src/windows/util/pet/Goods.js"));
      const g = new Goods({});
      assert.ok(Array.isArray(g.storeGoods.toy), "旧存档加载后 storeGoods.toy 应被归一化为 []");
      const r = g.buy("toy*_t0002");
      assert.strictEqual(r.ok, true, "旧存档也应能购买玩具");
      assert.deepStrictEqual(g.storeGoods.toy, ["_t0002-1"]);

      const page = g.getConsumablesPage({ pageSize: 4, current: 1, type: "toy", getWhere: "store" });
      assert.notStrictEqual(page.state, "err", "旧存档玩具背包分页不应报错");
      clearTimeout(g.saveTimes);
    }
  );
});

test("starterKit：新手背包含 toy 类", () => {
  const { buildStarterStore } = require(path.join(ROOT, "src/windows/util/pet/starterKit.js"));
  const store = buildStarterStore();
  assert.ok(Array.isArray(store.toy), "新手背包应含 toy 类");
  assert.strictEqual(store.toy.length, 8, "toy 类应含 8 个玩具");
});
