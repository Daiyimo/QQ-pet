"use strict";

/**
 * 1.2.5 特性移植（眼神追随桥 / 游戏菜单补齐）的压缩区接入点防回归测试。
 * 涉及文件均为 webpack 压缩单行产物，按项目惯例做结构断言：接入点被误删即红。
 */

const { test, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("主窗口 jsFiles 首位注入 petExternalApi.js（眼神追随桥）", () => {
  const src = readSource("src/windows/main/main.js");
  assert.match(
    src,
    /a\.jsFiles=\["\.\/util\/pet\/petExternalApi\.js","\.\/util\/move\.js"/,
    "src/windows/main/main.js 的 jsFiles 应以 petExternalApi.js 开头"
  );
});

test("petExternalApi 模块提供 SWF 眼神追随三回调", () => {
  const src = readSource("src/windows/util/pet/petExternalApi.js");
  for (const name of ["GetCursorPosition", "GetWindowRect", "GetCursorPositionHtml"]) {
    assert.ok(src.includes(name), `petExternalApi.js 缺少 ${name}`);
  }
});

test("小游戏菜单补齐官方 1.2.5 全部 19 款", () => {
  const src = readSource("src/windows/popups/smallGame/index.js");
  const gameList = JSON.parse(readSource("src/assets/config/gameList_swf.json")).gameList;
  for (const { name, router } of gameList) {
    assert.ok(
      src.includes(`{name:"${name}",router:"${router}"}`),
      `smallGame/index.js 菜单缺少 ${name}（${router}）`
    );
    assert.ok(
      fs.existsSync(path.join(ROOT, "src/assets/game", router)),
      `素材缺失：src/assets/game/${router}`
    );
  }
});

test("主窗口宠物本体光标为官方白手指（focus 食指手）", () => {
  const src = readSource("src/windows/main/index.css");
  assert.match(src, /#move\s*\{[^}]*hand\/focus\/normal\.cur/, "#move 应挂 focus/normal.cur");
  assert.match(src, /#move:active\s*\{[^}]*hand\/focus\/press\.cur/, "#move:active 应挂 focus/press.cur");
});

test("悬浮展开控制条：主窗接入 controlBarHover 模块与 onPetHover 信号", () => {
  const src = readSource("src/windows/main/main.js");
  assert.ok(
    src.includes('controlBarHover=_require("../util/controlBarHover.js"),control=_require("../popups/control/main.js")'),
    "main/main.js 应在 control 声明前接入 controlBarHover 模块"
  );
  assert.ok(
    src.includes('controlBarHover.onPetHover(!!o?.canDoType)},"html_bus-main_move"'),
    "main/main.js 的 html_bus-main_eventMouse 应上报 onPetHover"
  );
});

test("悬浮展开控制条：控制窗接入 onControlHover 信号", () => {
  const src = readSource("src/windows/popups/control/main.js");
  assert.ok(
    src.includes('_require("../../util/controlBarHover.js").onControlHover(!!o.canDoType)}'),
    "control/main.js 的 control_bus-Main_eventMouse 应上报 onControlHover"
  );
});

/**
 * 给已加载的 control 单例装 changeState spy 并接管 setTimeout，跑完复原。
 * 纯 node 下 control/main.js 能加载但 state 为 undefined，因此必须在测试侧直接把
 * state 赋成 "hide"/"menu"/"active"，否则 controlBarHover 的两处 state 判断永远不成立、
 * changeState 一次都不会被调用（此前本文件的行为测试就是这样假绿的）。
 * @param {string|undefined} state 假定的控制条状态
 * @param {(ctx:{control:object,calls:object[],tick:(ms:number)=>void})=>void} fn
 * @param {Function} [changeStateImpl] 覆写 changeState 实现（测降级路径用）
 */
function withControlSpy(state, fn, changeStateImpl) {
  const hover = require(path.join(ROOT, "src/windows/util/controlBarHover.js"));
  const control = require(path.join(ROOT, "src/windows/popups/control/main.js"));
  const origChangeState = control.changeState;
  const origState = control.state;
  const calls = [];
  control.changeState = (o) => {
    calls.push(o);
    if (changeStateImpl) changeStateImpl(o);
  };
  control.state = state;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    fn({ hover, control, calls, tick: (ms) => mock.timers.tick(ms) });
  } finally {
    hover.onControlHover(true); // 清掉可能仍挂着的 hideTimer，避免污染后续测试
    mock.timers.reset();
    control.changeState = origChangeState;
    control.state = origState;
  }
  return calls;
}

test("悬浮宠物本体：收起态控制条展开为菜单态", () => {
  const calls = withControlSpy("hide", ({ hover }) => hover.onPetHover(true));
  assert.deepStrictEqual(
    calls,
    [{ type: "menu" }],
    'state==="hide" 时 onPetHover(true) 应立即 changeState({type:"menu"})'
  );
});

test("悬浮宠物本体：二级面板展开态（active）不被改写，避免打断操作", () => {
  const calls = withControlSpy("active", ({ hover }) => hover.onPetHover(true));
  assert.deepStrictEqual(calls, [], 'active 态不应被 hover 改成 menu（只有 "hide" 才展开）');
});

test("鼠标离开宠物：满 1500ms 才收起菜单态控制条，不到点不收", () => {
  const hover = require(path.join(ROOT, "src/windows/util/controlBarHover.js"));
  assert.strictEqual(hover.HOVER_HIDE_DELAY_MS, 1500, "收起延迟应对齐官方 1.2.5 的 1500ms");
  withControlSpy("menu", ({ hover: h, calls, tick }) => {
    h.onPetHover(false);
    tick(hover.HOVER_HIDE_DELAY_MS - 1);
    assert.deepStrictEqual(calls, [], "1499ms 时不应收起");
    tick(1);
    assert.deepStrictEqual(
      calls,
      [{ type: "hide" }],
      'state==="menu" 且满 1500ms 应 changeState({type:"hide"})'
    );
    tick(5000);
    assert.deepStrictEqual(calls, [{ type: "hide" }], "收起只应发生一次（计时器不重排）");
  });
});

test("鼠标离开宠物：菜单态以外（hide/active）到点也不收起", () => {
  for (const state of ["hide", "active"]) {
    const calls = withControlSpy(state, ({ hover, tick }) => {
      hover.onPetHover(false);
      tick(2000);
    });
    assert.deepStrictEqual(calls, [], `state==="${state}" 不应被自动收起`);
  }
});

test("鼠标离开宠物后又移回控制条：取消本次自动收起", () => {
  const calls = withControlSpy("menu", ({ hover, tick }) => {
    hover.onPetHover(false); // 离开宠物，排定 1500ms 后收起
    tick(1000);
    hover.onControlHover(true); // 中途移到控制条按钮上
    tick(5000);
  });
  assert.deepStrictEqual(calls, [], "计时期间收到 inside 信号必须作废收起，否则用户点按会被收走");
});

test("离开控制条同样触发 1500ms 收起（两个窗口信号等价）", () => {
  const calls = withControlSpy("menu", ({ hover, tick }) => {
    hover.onControlHover(false);
    tick(1500);
  });
  assert.deepStrictEqual(calls, [{ type: "hide" }], "onControlHover(false) 应与 onPetHover(false) 同语义");
});

test("changeState 抛异常时悬浮信号安全降级，不打炸主进程", () => {
  const calls = withControlSpy(
    "hide",
    ({ hover }) => {
      assert.doesNotThrow(() => hover.onPetHover(true), "changeState 抛错必须被 try/catch 吞掉并记日志");
    },
    () => {
      throw new Error("control 窗口未就绪");
    }
  );
  assert.deepStrictEqual(calls, [{ type: "menu" }], "应确实走进了抛异常的 changeState 调用");
});

test("收起前复核 lastHoverInside 守卫仍在（防止鼠标移回控制条却被收起）", () => {
  // 该守卫是 clearHideTimer 之外的第二道防线：单线程下任何 inside 信号都会先清掉计时器，
  // 所以它在导出 API 层面不可达，行为测试无法覆盖，只能对源码结构断言把它钉住。
  const src = readSource("src/windows/util/controlBarHover.js");
  const body = src.slice(src.indexOf("function scheduleHide"), src.indexOf("function onPetHover"));
  assert.ok(
    /if \(lastHoverInside\) return;/.test(body),
    "scheduleHide 的定时器回调必须保留 lastHoverInside 复核"
  );
  assert.ok(
    body.indexOf("if (lastHoverInside) return;") < body.indexOf("changeState"),
    "lastHoverInside 复核必须在 changeState 之前，否则形同虚设"
  );
});

test("controlBarHover 模块不使用字符串形式 changeState（既有 bug 不照抄）", () => {
  const src = readSource("src/windows/util/controlBarHover.js");
  // 剥掉注释再断言（注释里会提及既有 bug 的字符串写法，不算违规）
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/changeState\(\s*["']/.test(code), "changeState 必须传对象 {type:...}，禁止字符串形式");
  assert.ok(src.includes('changeState({ type: "menu" })'), "展开应为 changeState({type:\"menu\"})");
  assert.ok(src.includes('changeState({ type: "hide" })'), "收起应为 changeState({type:\"hide\"})");
});

test("控制条 menus 对齐官方 1.2.5 五 tab 顺序与 children", () => {
  const src = readSource("src/windows/popups/control/index.js");
  const m = src.match(/menus:\[(.+?)\],activeList/);
  assert.ok(m, "control/index.js 应存在 menus 数组");
  const tabs = [...m[1].matchAll(/\{name:"([^"]+)",icon:"([^"]+)"(?:,children:\[([^\]]*)\])?/g)].map(
    (t) => ({ name: t[1], icon: t[2], children: t[3] || null })
  );
  assert.deepStrictEqual(
    tabs.map((t) => t.name),
    ["日常", "粉钻", "交互", "工具", "游戏", "活动"],
    "tab 顺序应为官方 5 tab + 特色活动 tab"
  );
  assert.strictEqual(tabs[0].children, "n.food,n.clean,n.cure,n.toy", "日常 children 顺序应对齐官方");
  assert.strictEqual(tabs[1].children, null, "粉钻应无 children（点击即开通）");
  assert.ok(tabs[1].icon.endsWith("fenzhuan.png"), "粉钻 tab 图标应为 fenzhuan.png");
  assert.strictEqual(tabs[2].children, "n.work,n.study,n.doctor", "交互 children 应为 打工/学习/看病");
  assert.strictEqual(tabs[3].children, "n.signIn,n.setting", "工具 children 应为 签到/设置");
  assert.strictEqual(tabs[4].children, "n.fish,n.games", "游戏 children 应为 池塘/游戏");
  assert.strictEqual(tabs[5].children, "n.task,n.trip,n.hlyg", "活动 tab 应保留特色项 任务/旅游/渔港");
});

test("控制条新增项定义：看病/签到/设置/池塘/游戏", () => {
  const src = readSource("src/windows/popups/control/index.js");
  for (const def of [
    'doctor:{value:"doctor",type:"doctor",name:"看病",icon:"../assets/control/icons/zhibing.png"}',
    'signIn:{value:"signIn",type:"openWindow",name:"签到",icon:"../assets/control/icons/juanzhou00.png"}',
    'setting:{value:"setting",type:"openWindow",name:"设置",icon:"../assets/control/icons/guanli.png"}',
    'fish:{value:"fish",type:"openWindow",name:"池塘",icon:"../assets/control/icons/fish01.png"}',
    'games:{value:"games",type:"openWindow",name:"游戏",icon:"../assets/control/icons/game.svg"}',
  ]) {
    assert.ok(src.includes(def), `control/index.js 缺少项定义 ${def.slice(0, 30)}...`);
  }
  for (const icon of ["zhibing.png", "juanzhou00.png", "guanli.png", "fish01.png", "game.svg", "fenzhuan.png"]) {
    assert.ok(
      fs.existsSync(path.join(ROOT, "src/assets/control/icons", icon)),
      `图标缺失：src/assets/control/icons/${icon}`
    );
  }
});

test("控制条新增项接线：粉钻点击即开通、看病走诊断、openWindow 开四窗", () => {
  const html = readSource("src/windows/popups/control/index.html");
  assert.ok(
    html.includes('@click="!item.children&&chooseOnce(item)"'),
    "无 children 的 tab（粉钻）点击应触发 chooseOnce"
  );
  const idx = readSource("src/windows/popups/control/index.js");
  assert.ok(
    idx.includes('if("doctor"==e.type)return this.chooseOnce({value:"cure"}),void this.seeTip({type:"cure"});'),
    "看病变应复用吃药面板并触发 cure 诊断链路"
  );
  const main = readSource("src/windows/popups/control/main.js");
  for (const frag of [
    '"hlyg"==t.value||"fish"==t.value',
    '"signIn"==t.value?(o=_require("../signIn/main"),o.show?o.doClose():o.cleate())',
    '"setting"==t.value?(o=_require("../setup/main"),!o.show&&o.cleate())',
    '"games"==t.value&&(o=_require("../smallGame/main"),!o.show&&o.cleate())',
  ]) {
    assert.ok(main.includes(frag), `control/main.js openWindow 分支缺少 ${frag.slice(0, 40)}...`);
  }
});

test("小游戏窗口：折叠态隐藏菜单内容，未选游戏显示占位提示", () => {
  const css = readSource("src/windows/popups/smallGame/index.css");
  assert.ok(
    css.includes(".leftMenu:not(.openMenu) .menu_main"),
    "折叠态必须隐藏 menu_main（否则 170px 菜单项在 30px 容器里压成竖条）"
  );
  assert.ok(css.includes(".swfTip"), "未选游戏时应有占位提示样式（替代黑屏）");
  const html = readSource("src/windows/popups/smallGame/index.html");
  assert.ok(html.includes('class="swfTip"'), "swfMain 内应有 swfTip 占位元素");
  assert.ok(
    !/embed[^>]*v-show/.test(html),
    "gameMain embed 不能加 v-show：changeSwf 的 cloneNode 会继承 display:none 导致游戏不可见"
  );
});

test("右键菜单容器放宽到 130px 容纳 6 字标签", () => {
  const css = readSource("src/windows/popups/rightMenu/index.css");
  assert.match(css, /\.bk_body\s*\{\s*width:\s*130px/, ".bk_body 应为 130px（6 字标签 + 箭头 = 129px）");
});

test("剪贴板播报长文本截断（防大段代码刷屏气泡）", () => {
  const src = readSource("src/windows/main/main.js");
  assert.ok(
    src.includes('e.length>200?e.slice(0,200)+" ……（共"+e.length+"字，仅播报前200字）"'),
    "剪贴板本地播报应对超过 200 字的文本截断"
  );
});

test("Ruffle 启动画面（ruffle logo splash）已关闭", () => {
  for (const f of [
    "src/windows/app.html",
    "src/windows/popups/fishing/indexOnLine.html",
    "src/windows/popups/backRoom/indexOnLine.html",
  ]) {
    const src = readSource(f);
    assert.ok(src.includes("splashScreen: false"), `${f} 的 RufflePlayer.config 应含 splashScreen: false`);
  }
});

test("设置页「记忆与课程」有打开记忆文件夹入口", () => {
  const idx = readSource("src/windows/popups/setup/index.js");
  assert.ok(idx.includes('{label:"打开记忆文件夹",type:"buts",value:"openMemoryDir"}'), "设置菜单缺打开记忆文件夹项");
  const main = readSource("src/windows/popups/setup/main.js");
  assert.ok(main.includes('"openMemoryDir"==t.data.value'), "setup/main.js 缺 openMemoryDir 处理分支");
  assert.ok(main.includes('shell.openPath'), "openMemoryDir 应调 shell.openPath");
});

test("小游戏菜单按钮为细描边圆形样式（放大/缩小游戏画面）", () => {
  const css = readSource("src/windows/popups/smallGame/index.css");
  assert.ok(css.includes("border-radius: 50%"), "按钮应为圆形");
  const html = readSource("src/windows/popups/smallGame/index.html");
  assert.ok(html.includes("收起菜单，放大游戏画面"), "按钮 title 应说明用途");
});

test("背景系统：永久拥有 + 切换装备 + 无背景不显示图标", () => {
  const doMain = readSource("src/ini/doMain.js");
  assert.ok(doMain.includes("activeOption:{work:null,study:null,trip:null,ill:null,die:null,background:null}"), "新宠物 activeOption 应含 background:null");
  assert.ok(doMain.includes('background:{start:{not:!0},fn:e=>null}'), "旧存档应有 background 字段迁移规则");

  const goods = readSource("src/windows/util/pet/Goods.js");
  assert.ok(goods.includes('"background"===type&&this.storeGoods?.background?.some'), "Goods.buy 应拦截重复购买背景");

  const storeMain = readSource("src/windows/popups/store/main.js");
  assert.ok(storeMain.includes("background:_bg}})"), "store_h_useGood_m 背景应走装备写档");
  assert.ok(storeMain.includes("work:_ao.work??null"), "装备写档应保留 activeOption 其余键（setPetInfo 按 e 现有键合并，缺键会被写 undefined）");
  assert.ok(storeMain.includes('"_b0000000"===t.keyName?null:t.keyName'), "无背景装备应写 null");

  const idx = readSource("src/windows/popups/store/index.js");
  for (const frag of ["currentBg", "isCurBg", "currentBgImg", "bgNameMap"]) {
    assert.ok(idx.includes(frag), `store/index.js 缺 ${frag}`);
  }
  const html = readSource("src/windows/popups/store/index.html");
  assert.ok(html.includes("已拥有"), "装扮卡应显示已拥有而非剩余数量");
  assert.ok(html.includes("使用中"), "装扮卡应有使用中状态");
});

test("右键子菜单：不被裁剪且与父菜单有重叠（hover 桥）", () => {
  const css = readSource("src/windows/popups/rightMenu/index.css");
  assert.ok(!/overflow:\s*hidden/.test(css), ".bk_body 不能 overflow:hidden（子菜单在面板外会被裁剪）");
  const idx = readSource("src/windows/popups/rightMenu/index.js");
  assert.ok(idx.includes("translateX(-98%)"), "子菜单应与父菜单重叠 2%（消除 hover 死区）");
  assert.ok(!idx.includes("translateX(-100%) translateY(-40%)"), "旧的 -100% 无重叠定位应已替换");
  const main = readSource("src/windows/popups/rightMenu/main.js");
  assert.ok(main.includes("this.width=480"), "右键菜单窗口应加宽到 480 容纳左出子菜单");
});

test("右键子菜单：v-show 常驻不重建，且不跑打开动画", () => {
  const html = readSource("src/windows/popups/rightMenu/index.html");
  assert.ok(html.includes('v-show="item.children && activeFatherValue == item.value"'), "子菜单应 v-show（v-if 会每次销毁重建产生闪烁）");
  const css = readSource("src/windows/popups/rightMenu/index.css");
  assert.ok(css.includes(".bk_body.sun_bk_body"), "子菜单应显式关闭打开动画");
});
