// $Store.getItem 上抛语义下，两处运行期调用方的保护测试。
// 运行：node --test test/runtimeStoreReadGuard.test.js
//
// 背景：getItem 已从"吞错返 {}"改为向上抛（见 test/storeGetItemThrow.test.js）。
// 启动路径与 achievement 巡检已包 try，剩下两处运行期调用方原本裸着：
//
//   处 1 src/windows/popups/setup/main.js —— "重生为另一性别"读 pet.info.sex，
//        读点【紧跟 $Store.clear()】。读失败若兜底一个性别继续，会清档后写错性别，
//        把用户的宠物永久变成另一个性别（不可逆）。故必须中止 + 告知，绝不兜底。
//        另有防重入锁 h（h=!0 配 setTimeout(()=>h=!1,300)）：异常若逃出 handler，
//        这个 setTimeout 永不执行 → 按钮永久失灵，所以异常路径必须走到锁复位。
//
//   处 2 src/windows/tool/floatStyle/main.js —— 读的是纯 UI 参数 tool.floatStyle，
//        窗口照常打开、回落内置默认值是对的；但同一个 created 闭包里有防抖回写
//        （_() → 2s 后 $Store.setItem("tool.floatStyle", a) 整体写回内存对象 a），
//        所以【只回落还不够】：读失败后用户任一次微调（ALT+↑ 快捷键 / 面板保存）
//        都会把「内置默认 + 这次微调」写回磁盘，静默吃掉原有的整套样式。
//        故读失败时置闭包标志 _readFailed，_() 一律拒绝回写，本次会话改动只在内存生效。
//        原先异常被外层 .catch(e=>console.log(e)) 兜住 → 窗口创建失败且用户毫无提示。
//
// 两处处理不同，区分依据不是「紧接着要做的事是否具破坏性」（那条判据在处 2 判错过，
// 导致过一轮 P0 数据丢失），而是：读失败后落在内存里的那个对象，后续会不会被任何
// 路径整体回写磁盘。会 → 必须禁写（处 2）；紧跟不可逆写 → 必须中止（处 1）。
//
// 两个被测文件都是 webpack 压缩单行产物，因此全部用行为断言（桩 windowsMain 捕获
// preloads 注册的 IPC 处理器后真实调用），只补两条结构护栏防后续再加裸调用。
// 变异自证：把修复回滚后的副本写进临时文件，用
//   QQ_SETUP_SRC=<副本> node --test test/runtimeStoreReadGuard.test.js
//   QQ_FLOATSTYLE_SRC=<副本> node --test test/runtimeStoreReadGuard.test.js
// 即可验证用例真的会红，无需改动仓库里的 src/。
"use strict";

const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const SETUP_PATH = process.env.QQ_SETUP_SRC
  ? path.resolve(process.env.QQ_SETUP_SRC)
  : path.join(__dirname, "..", "src/windows/popups/setup/main.js");
const FLOAT_PATH = process.env.QQ_FLOATSTYLE_SRC
  ? path.resolve(process.env.QQ_FLOATSTYLE_SRC)
  : path.join(__dirname, "..", "src/windows/tool/floatStyle/main.js");

/** 拦截 Module.prototype.require：被测产物用 eval("require") 取 require，
 *  且可能被放到临时目录（变异自证），故 electron / 业务模块一律由此提供。 */
function withRequireStub(appStub, fn) {
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "electron") return { app: appStub, shell: { openPath() {} } };
    if (id.includes("service/model/user")) return { getLogs: () => Promise.resolve({}) };
    return orig.apply(this, arguments);
  };
  try {
    return fn();
  } finally {
    Module.prototype.require = orig;
  }
}

function captureConsole(fn) {
  const logs = { error: [], warn: [], log: [] };
  const orig = { error: console.error, warn: console.warn, log: console.log };
  for (const k of ["error", "warn", "log"]) {
    console[k] = (...args) => logs[k].push(args.map((a) => String(a)).join(" "));
  }
  try {
    fn();
  } finally {
    Object.assign(console, orig);
  }
  return logs;
}

/* ------------------------------------------------------------------ *
 * 处 1：setup —— 改性别，绝不兜底
 * ------------------------------------------------------------------ */

/** 加载 setup/main.js 并捕获 preloads 注册的 IPC 处理器。 */
function loadSetup(spy) {
  const appStub = {
    relaunch: () => spy.relaunch.push(1),
    exit: (code) => spy.exit.push(code),
    setLoginItemSettings: () => {},
    getPath: () => ".",
  };
  const handlers = {};
  const fakeWin = { webContents: { send() {} }, on() {}, close() {} };
  const origGlobals = {
    windowsMain: global.windowsMain,
    getSys: global.getSys,
  };
  global.windowsMain = {
    open(opts) {
      opts.created({
        vm: fakeWin,
        preloads: (h) => Object.assign(handlers, h),
        getinfo() {},
        wsMethods: {},
      });
      return Promise.resolve(fakeWin);
    },
  };
  global.openSpeak = (o) => spy.speak.push(o?.data?.data);
  global.getSys = () => ({});
  withRequireStub(appStub, () => {
    delete require.cache[SETUP_PATH];
    require(SETUP_PATH).cleate();
    delete require.cache[SETUP_PATH];
  });
  Object.assign(global, origGlobals);
  assert.equal(typeof handlers["setup_h_setStting_m"], "function", "setup 应注册 setStting 处理器");
  return handlers["setup_h_setStting_m"];
}

/** 点一次「改性别」按钮。getItem 由 readPet 决定（可抛错）。 */
function clickSex(handler, spy, readPet) {
  const origStore = global.$Store;
  const origSpeak = global.openSpeak;
  global.openSpeak = (o) => spy.speak.push(o?.data?.data);
  global.$Store = {
    getItem: (key) => {
      spy.reads.push(key);
      return readPet(key);
    },
    setItem: (key, value) => spy.writes.push([key, value]),
    clear: () => spy.clear.push(1),
  };
  try {
    return captureConsole(() =>
      handler(null, { type: "change", data: JSON.stringify({ type: "buts", value: "sex" }) })
    );
  } finally {
    global.$Store = origStore;
    global.openSpeak = origSpeak;
  }
}

function newSpy() {
  return { reads: [], writes: [], clear: [], relaunch: [], exit: [], speak: [] };
}

const BOOM = () => {
  throw new Error("read boom");
};

test("[Critical] 改性别读存档失败：不清档、不重启，且不按任何性别兜底", () => {
  const spy = newSpy();
  const handler = loadSetup(spy);
  const logs = clickSex(handler, spy, BOOM);

  assert.deepEqual(spy.reads, ["pet"], "必须真的读了 pet（否则用例是恒真的）");
  assert.deepEqual(spy.clear, [], "读失败绝不能执行 $Store.clear()——那是不可逆清档");
  assert.deepEqual(spy.writes, [], "读失败绝不能写 toSex——那会清档后把宠物变成错的性别");
  assert.deepEqual(spy.relaunch, [], "读失败不得重启应用");
  assert.deepEqual(spy.exit, [], "读失败不得退出进程");
  assert.equal(logs.error.length, 1, `意料外异常应记恰好 1 条 error，实际 ${logs.error.length} 条`);
  assert.match(logs.error[0], /\[setup\]/, "日志前缀须为模块路径 [setup]");
  assert.match(logs.error[0], /read boom/, "须带原始异常（堆栈/信息）");
});

test("[Critical] 改性别读存档失败：通过 openSpeak 气泡告知用户恰好一次", () => {
  const spy = newSpy();
  const handler = loadSetup(spy);
  clickSex(handler, spy, BOOM);

  assert.equal(spy.speak.length, 1, `应复用现成的 openSpeak 气泡告知一次，实际 ${spy.speak.length} 次`);
  assert.match(spy.speak[0], /存档读取失败/, "文案要说明是存档读取失败");
  assert.match(spy.speak[0], /性别/, "文案要说明本次改性别没有生效");
});

test("改性别读存档失败：异常不逃出 IPC handler（否则 Electron 只打未捕获异常）", () => {
  const spy = newSpy();
  const handler = loadSetup(spy);
  assert.doesNotThrow(() => clickSex(handler, spy, BOOM));
});

test("改性别读存档失败：防重入锁 300ms 后复位，按钮不会永久失灵", async () => {
  const spy = newSpy();
  const handler = loadSetup(spy);

  clickSex(handler, spy, BOOM);
  // 锁在 300ms 内应仍然生效：立刻再点一次什么都不该发生
  clickSex(handler, spy, BOOM);
  assert.deepEqual(spy.reads, ["pet"], "锁未过期时第二次点击应被吞掉，不应再读一次");
  assert.equal(spy.speak.length, 1, "锁未过期时不应再弹一次气泡");

  await new Promise((r) => setTimeout(r, 400));
  clickSex(handler, spy, () => ({ info: { sex: "GG" } }));
  assert.deepEqual(spy.clear, [1], "锁复位后再点必须能正常执行，否则按钮永久失灵");
  assert.deepEqual(spy.writes, [["toSex", "MM"]]);
});

test("改性别读存档成功：GG→MM，清档、写 toSex、重启退出的顺序不变", () => {
  const spy = newSpy();
  const handler = loadSetup(spy);
  const logs = clickSex(handler, spy, () => ({ info: { sex: "GG" } }));

  assert.deepEqual(spy.clear, [1], "正常路径必须清档恰好一次");
  assert.deepEqual(spy.writes, [["toSex", "MM"]], "GG 应重生为 MM");
  assert.deepEqual(spy.relaunch, [1]);
  assert.deepEqual(spy.exit, [0]);
  assert.deepEqual(spy.speak, [], "正常路径不该弹错误气泡");
  assert.deepEqual(logs.error, [], "正常路径不该记 error");
});

test("改性别读存档成功：MM→GG，且存档缺 info 时按 GG 处理（原语义不变）", () => {
  for (const [sex, expected] of [["MM", "GG"], [undefined, "GG"]]) {
    const spy = newSpy();
    const handler = loadSetup(spy);
    clickSex(handler, spy, () => (sex ? { info: { sex } } : {}));
    assert.deepEqual(spy.writes, [["toSex", expected]], `sex=${String(sex)} 应重生为 ${expected}`);
  }
});

/* ------------------------------------------------------------------ *
 * 处 2：floatStyle —— 纯 UI 参数，读失败回落默认
 * ------------------------------------------------------------------ */

/** 内置默认值（与 floatStyle/main.js 里的字面量一致，用于断言回落结果）。 */
const FLOAT_DEFAULT = { much: 100, op: 0.3, opmou: 1, opline: 0.3, pointSize: 5, starT: 1, starSize: 25 };

/**
 * 加载 floatStyle/main.js 并驱动 created + mounted，
 * 返回 { style, logs, writes }：style 为发往渲染层的 background 数据（即生效的样式对象），
 * writes 为 $Store.setItem 的调用记录（深拷贝，防止后续 mutation 污染断言）。
 *
 * after 可选：在 mounted 之后、全局桩仍然装着时被调用，签名 ({ handlers, writes }) => void，
 * 用于触发保存路径并推进假定时器（回写发生在 $Store 桩上，必须在恢复全局前完成）。
 */
function openFloatStyle(getItem, after) {
  const sends = [];
  const writes = [];
  const fakeWin = {
    webContents: { send: (ch, payload) => sends.push({ ch, payload }), reload() {} },
    setIgnoreMouseEvents() {},
  };
  const origGlobals = {
    windowsMain: global.windowsMain,
    getScreenSize: global.getScreenSize,
    $Store: global.$Store,
    shotycutsMain: global.shotycutsMain,
  };
  global.getScreenSize = () => [1920, 1080];
  global.$Store = {
    getItem,
    setItem: (key, value) => writes.push([key, JSON.parse(JSON.stringify(value))]),
  };
  global.shotycutsMain = { AddLoop: () => {}, upShotycut: () => {}, loopShortcut: () => {} };
  let handlers = {};
  global.windowsMain = {
    open(opts) {
      opts.created({
        vm: fakeWin,
        preloads: (h) => (handlers = h),
        getinfo() {},
        wsMethods: {},
      });
      return Promise.resolve(fakeWin);
    },
  };
  const logs = withRequireStub({ exit() {} }, () =>
    captureConsole(() => {
      delete require.cache[FLOAT_PATH];
      require(FLOAT_PATH).cleate();
      delete require.cache[FLOAT_PATH];
      handlers["floatStyle_h_bus_m"](null, { event: "mounted" });
      if (after) after({ handlers, writes });
    })
  );
  Object.assign(global, origGlobals);
  const bg = sends.filter((s) => s.payload?.type === "background");
  assert.equal(bg.length, 1, "mounted 应把生效样式下发渲染层恰好一次");
  return { style: bg[0].payload.data, logs, writes };
}

test("[Critical] 悬浮特效样式读失败：窗口照常打开并回落到内置默认值", () => {
  let reads = 0;
  const { style, logs } = openFloatStyle((key) => {
    reads++;
    assert.equal(key, "tool.floatStyle");
    throw new Error("read boom");
  });

  assert.equal(reads, 1, "必须真的读了 tool.floatStyle");
  for (const [k, v] of Object.entries(FLOAT_DEFAULT)) {
    assert.equal(style[k], v, `读失败后 ${k} 应回落内置默认 ${v}`);
  }
  assert.equal(style.showIcon, true, "读失败后 showIcon 应回落内置默认 true");
  assert.equal(logs.warn.length, 1, `可预期的降级应记恰好 1 条 warn，实际 ${logs.warn.length} 条`);
  assert.match(logs.warn[0], /\[tool\/floatStyle\]/, "日志前缀须为模块路径 [tool/floatStyle]");
  assert.match(logs.warn[0], /read boom/, "warn 须带错误信息");
  assert.match(
    logs.warn[0],
    /不会保存|不保存|不再保存/,
    "warn 必须告知「本次会话不会保存样式改动」这层后果——只说回落默认会让用户以为改动照常保存"
  );
  assert.deepEqual(logs.log, [], "不得再用 console.log 兜错（不符合日志约定）");
});

test("[Critical] 悬浮特效样式读失败后：任何保存路径都不得回写磁盘（否则内置默认值会吃掉用户原有样式）", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const { writes } = openFloatStyle(
    () => {
      throw new Error("read boom");
    },
    ({ handlers }) => {
      // 用户在面板上改了一个参数并保存（等价于按一次 ALT+↑，两者都走同一个防抖 _()）
      handlers["floatStyle_h_save_m"](null, JSON.stringify({ much: 42 }));
      mock.timers.tick(2000); // 防抖到点
      mock.timers.tick(10000); // 再多等等，确认不是延后写
    }
  );

  assert.deepEqual(
    writes,
    [],
    "读失败后禁止任何回写：此时内存里只有「内置默认 + 本次微调」，写回去会永久覆盖用户原有的整套悬浮特效样式"
  );
});

test("悬浮特效样式读成功后：保存路径 2 秒防抖回写恰好一次，且带上用户这次的改动", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const { writes } = openFloatStyle(
    () => ({ much: 7, starContent: "#" }),
    ({ handlers, writes }) => {
      handlers["floatStyle_h_save_m"](null, JSON.stringify({ much: 42 }));
      assert.deepEqual(writes, [], "防抖未到点前不该写盘");
      mock.timers.tick(2000);
    }
  );

  assert.equal(writes.length, 1, `读成功时保存必须真的落盘恰好一次，实际 ${writes.length} 次（若为 0，说明禁写守卫写成了永不保存）`);
  assert.equal(writes[0][0], "tool.floatStyle");
  assert.equal(writes[0][1].much, 42, "写入值必须包含用户这次的改动");
  assert.equal(writes[0][1].starContent, "#", "存档里的其它键不得丢失");
  assert.equal(writes[0][1].op, FLOAT_DEFAULT.op, "未存的键按内置默认写回（原语义不变）");
});

test("悬浮特效样式读成功：存档值覆盖默认值，未存的键仍取默认", () => {
  const { style, logs } = openFloatStyle(() => ({ much: 7, starContent: "#" }));
  assert.equal(style.much, 7, "存档里的 much 必须生效");
  assert.equal(style.starContent, "#");
  assert.equal(style.op, FLOAT_DEFAULT.op, "未存的键仍取默认");
  assert.deepEqual(logs.warn, [], "正常读取不该记 warn");
});

/* ------------------------------------------------------------------ *
 * 反假绿结构护栏：防后续改动又加裸调用
 * ------------------------------------------------------------------ */

test("[反假绿] 两个文件里的 $Store.getItem 都必须被 try 包住", () => {
  const setupSrc = fs.readFileSync(SETUP_PATH, "utf8");
  const floatSrc = fs.readFileSync(FLOAT_PATH, "utf8");

  assert.equal(
    (setupSrc.match(/\$Store\.getItem\(/g) || []).length,
    1,
    "setup/main.js 目前应恰有 1 处 $Store.getItem"
  );
  assert.match(
    setupSrc,
    /try\{_toSex="GG"==\$Store\.getItem\("pet"\)\?\.info\?\.sex\?"MM":"GG"\}catch/,
    "setup 的性别读点必须在 try 里"
  );
  assert.equal(
    (floatSrc.match(/\$Store\.getItem\(/g) || []).length,
    1,
    "floatStyle/main.js 目前应恰有 1 处 $Store.getItem"
  );
  assert.match(
    floatSrc,
    /try\{s=\$Store\.getItem\("tool\.floatStyle"\)\}catch/,
    "floatStyle 的样式读点必须在 try 里"
  );
});
