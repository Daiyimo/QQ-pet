"use strict";

/**
 * 商店弹窗左栏「我的背包（储物柜）」官方 1.2.5 化的防回归测试。
 * - 压缩区接入点（popups/store/main.js、preload.js）做结构断言：接入点被误删即红；
 * - 渲染层（index.html/index.js/index.css）做官方左栏结构类名/贴图断言；
 * - 官方左栏贴图素材做存在性断言（素材被误删即红）。
 * 官方参照：1.2.5 deobfuscated/renderer.index.js ShoppingMall（55465-56925 行）
 * 与 12319 行 CSS blob（leftSelfHeadBk/leftSelfCenterBk/leftSelfGoodsBk/leftSelfFootBk、
 * lscb_t_onve/lscb_dowmOnce、selfGood/selfGoodUse、lsfb_*）。
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("压缩区接入点：窗口加宽到官方双栏（约 830x640）", () => {
  const src = readSource("src/windows/popups/store/main.js");
  assert.ok(src.includes("this.width=830,this.height=640"), "store/main.js 窗口应为 830x640（左栏 347 + 间隔 10 + 右栏 456）");
});

test("压缩区接入点：store_h_listBag_m 走 Goods.getConsumablesPage(getWhere:store)", () => {
  const src = readSource("src/windows/popups/store/main.js");
  assert.ok(src.includes("store_h_listBag_m:"), "store/main.js 应有 store_h_listBag_m 处理器");
  assert.ok(
    src.includes('petControl.Goods.getConsumablesPage({getWhere:"store"'),
    "store_h_listBag_m 应调用 getConsumablesPage({getWhere:\"store\",...})"
  );
  assert.ok(src.includes('s.webContents.send("store_m_bag_h",{type,...result})'), "背包页回包事件应为 store_m_bag_h {type,...result}");
});

test("压缩区接入点：store_h_useGood_m 复用 Goods.useConsumables，background 不给用", () => {
  const src = readSource("src/windows/popups/store/main.js");
  assert.ok(src.includes("store_h_useGood_m:"), "store/main.js 应有 store_h_useGood_m 处理器");
  assert.ok(src.includes("petControl.Goods.useConsumables(t)"), "使用道具应复用 Goods.useConsumables（不另写结算）");
  assert.ok(
    src.includes('!["food","commodity","medicine","toy"].includes(type)'),
    "background 等不可使用类目应被拦截"
  );
  assert.ok(src.includes("该道具暂不能使用"), "不可使用类目应返回提示文案");
  assert.ok(src.includes('s.webContents.send("store_m_useGoodResult_h"'), "使用结果回包事件应为 store_m_useGoodResult_h");
});

test("压缩区接入点：购买成功广播 store_m_bagRefresh_h 联动左栏刷新", () => {
  const src = readSource("src/windows/popups/store/main.js");
  assert.ok(
    src.includes('result.ok&&s.webContents.send("store_m_bagRefresh_h",{})'),
    "store_h_buy_m 成功后应广播 store_m_bagRefresh_h"
  );
});

test("preload：左栏 IPC 通道齐备", () => {
  const src = readSource("src/windows/popups/store/preload.js");
  for (const frag of [
    'store_h_listBag:e=>ipcRenderer.send("store_h_listBag_m",e)',
    'store_h_useGood:e=>ipcRenderer.send("store_h_useGood_m",e)',
    // on 类通道统一包装为 (_e,..._a)=>e(..._a)，不把 IpcRendererEvent 透传给渲染层回调
    'store_m_bag:e=>ipcRenderer.on("store_m_bag_h",(_e,..._a)=>e(..._a))',
    'store_m_useGoodResult:e=>ipcRenderer.on("store_m_useGoodResult_h",(_e,..._a)=>e(..._a))',
    'store_m_bagRefresh:e=>ipcRenderer.on("store_m_bagRefresh_h",(_e,..._a)=>e(..._a))',
  ]) {
    assert.ok(src.includes(frag), `store/preload.js 缺少通道 ${frag}`);
  }
});

test("左栏渲染层：官方 1.2.5 结构（四段贴图区 + tab + selfGood 卡 + lsfb 分页）", () => {
  const html = readSource("src/windows/popups/store/index.html");
  for (const frag of [
    "leftSelf",          // 左栏容器
    "leftSelfHeadBk",    // 头部选中物品展示区（mall_03.gif）
    "leftSelfCenterBk",  // tab 条（mall2_03.gif）
    "leftSelfGoodsBk",   // 背包网格（user_mallconbg.gif）
    "leftSelfFootBk",    // 底部元宝+分页（mall2_25.gif）
    "lscb_t_onve",       // 大区 tab（官方类名）
    "lscb_dowmOnce",     // 子类 tab
    "selfGood",          // 物品卡（Card_Items.png）
    "selfGoodImg",       // 物品图标
    "selfGoodinfo",      // 名称+剩余数量
    "selfGoodUse",       // 使用按钮
    "lsfb_yb",           // 元宝
    "lsfb_upMore",       // 分页：首页
    "lsfb_downMore",     // 分页：末页
    "lsh_pet",           // 宠物状态展示区（头像+名称）
    "lsh_stats",         // 状态条（饥饿/清洁/心情/健康/成长）
    "petAvatar",         // 宠物头像（按性别取 Tray 图标）
    "petStats",          // 状态条数据
    "rightSelf",         // 右栏容器（原单栏内容整体右移）
  ]) {
    assert.ok(html.includes(frag), `store/index.html 左栏缺少 ${frag}`);
  }
});

test("左栏渲染层：三区 tab / 分页 / 使用逻辑", () => {
  const js = readSource("src/windows/popups/store/index.js");
  for (const mall of ['value:"bagWy"', 'value:"bagGN"', 'value:"bagZB"']) {
    assert.ok(js.includes(mall), `store/index.js 应有 ${mall} 大区`);
  }
  assert.ok(js.includes("store_h_listBag"), "应经 store_h_listBag 请求背包页");
  assert.ok(js.includes("store_h_useGood"), "应经 store_h_useGood 使用道具");
  assert.ok(js.includes("useGood"), "应有使用逻辑");
  assert.ok(js.includes("bagGoto"), "应有左栏分页逻辑");
  assert.ok(js.includes("selectGood"), "应有选中物品展示逻辑");
  assert.ok(js.includes("store_m_bagRefresh"), "购买成功后应响应 bagRefresh 重拉背包");
  /* 官方「属性」子 tab（nums 充值物品）不做的说明注释应保留 */
  assert.ok(js.includes("nums"), "应保留官方属性子 tab(nums) 不做的注释");
});

test("左栏渲染层：官方贴图与类名样式", () => {
  const css = readSource("src/windows/popups/store/index.css");
  for (const frag of [
    "mall_03.gif",            // leftSelfHeadBk
    "mall2_03.gif",           // leftSelfCenterBk
    "mall2_25.gif",           // leftSelfFootBk
    "user_mallconbg.gif",     // leftSelfGoodsBk
    "Card_Items.png",         // selfGood
    "lmenu_31.png",           // lscb_dowmOnce
    "Items_SubTag_Selected.png",
    "mall1_25.gif",           // 喂养 tab 选中
    ".lscb_t_onve",
    ".selfGoodUse",
    ".lsfb_yb",
    ".rightSelf",
  ]) {
    assert.ok(css.includes(frag), `store/index.css 缺少官方左栏样式/贴图 ${frag}`);
  }
});

test("左栏官方贴图素材已就位", () => {
  for (const rel of [
    "src/assets/shppingMall/bk/mall_03.gif",
    "src/assets/shppingMall/bk/mall2_03.gif",
    "src/assets/shppingMall/bk/mall2_25.gif",
    "src/assets/shppingMall/bk/user_mallconbg.gif",
    "src/assets/shppingMall/bk/Card_Items.png",
    "src/assets/shppingMall/menu/mall_24.gif",
    "src/assets/shppingMall/menu/mall_25.gif",
    "src/assets/shppingMall/menu/mall_26.gif",
    "src/assets/shppingMall/menu/mall1_24.gif",
    "src/assets/shppingMall/menu/mall1_25.gif",
    "src/assets/shppingMall/menu/mall1_26.gif",
    "src/assets/shppingMall/menu/Items_SubTag_Selected.png",
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `缺少官方左栏素材 ${rel}`);
  }
});
