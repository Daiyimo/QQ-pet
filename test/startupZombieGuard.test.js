// 启动期僵尸进程兜底测试（main.js 的 uncaughtException / unhandledRejection 分流）。
//
// 修复的问题：main.js 的 uncaughtException 处理器刻意「只记日志不退出」—— 对运行期的
// 孤立异常是对的（桌宠是长驻进程，不该因为一次异常就让宠物消失），但对启动期是错的：
// 此时既没有窗口也没有托盘，进程却活着并占用 requestSingleInstanceLock，用户再点图标
// 也起不来（新实例拿不到锁直接退出），只能去任务管理器杀，且毫无提示。
// createWindow() 的 try/catch 只挡得住同步抛出，whenReady().then 之后的 microtask、
// setTimeout / Promise 里的抛出都会绕过它落到这两个 process 处理器。
//
// 测试手法：main.js 会注册真实的 process 处理器并改写 console，直接 require 会污染
// 测试进程，因此用 node:vm 建沙箱，注入假 process / console / require（假 electron），
// 真实执行 main.js 顶层代码，再手工触发捕获到的处理器 —— 不做源码文本断言。
//
// 变异自证入口：QQ_ROOT_MAIN_SRC 指向临时目录里的回滚版本即可验证用例真的会红。
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAIN_PATH = process.env.QQ_ROOT_MAIN_SRC
  ? path.resolve(process.env.QQ_ROOT_MAIN_SRC)
  : path.join(__dirname, "../main.js");

const SRC = fs.readFileSync(MAIN_PATH, "utf8");
const STARTUP_DIALOG_TITLE = "QQ宠物启动失败";

/**
 * 在沙箱里加载 main.js。
 * @param {{windows?: any[], stubs?: Record<string, any>}} opts
 *   windows —— BrowserWindow.getAllWindows() 的返回值；stubs —— 额外的 require 桩。
 */
function loadMain(opts = {}) {
  const rec = {
    exit: [], // app.exit 的每次入参
    errorBox: [], // dialog.showErrorBox 的每次入参
    errors: [], // console.error 的每次入参
    warns: [],
    logs: [],
    order: [], // 「弹窗后只准 exit」的顺序证据
  };
  const appHandlers = {};
  const processHandlers = {};
  let readyCb = null;
  let windows = opts.windows || [];

  const electron = {
    app: {
      on: (ev, cb) => {
        (appHandlers[ev] = appHandlers[ev] || []).push(cb);
      },
      requestSingleInstanceLock: () => opts.gotTheLock !== false,
      setAppUserModelId: () => {},
      commandLine: { appendSwitch: () => {} },
      whenReady: () => ({
        then: (cb) => {
          readyCb = cb;
        },
      }),
      exit: (...a) => {
        rec.exit.push(a);
        rec.order.push("exit");
      },
    },
    session: { defaultSession: {} },
    dialog: {
      showErrorBox: (title, msg) => {
        rec.errorBox.push([title, msg]);
        rec.order.push("errorBox");
      },
    },
    BrowserWindow: { getAllWindows: () => windows },
  };

  const stubs = Object.assign(
    {
      "./src/ini/toolResolver.js": { resolveToolName: () => null },
      "./src/ini/security.js": { installPermissionHandlers: () => {} },
      "./src/ini/init.js": {},
      "./src/ini/doMain.js": {},
      "./src/ini/dataWatcher.js": { startDataWatcher: () => {} },
    },
    opts.stubs || {}
  );

  const sandboxRequire = (id) => {
    if (id === "electron") return electron;
    if (id === "path") return path;
    if (Object.prototype.hasOwnProperty.call(stubs, id)) {
      const v = stubs[id];
      if (typeof v === "function") return v(); // 用函数形式表达「require 时抛出」
      return v;
    }
    throw new Error("沙箱未预期的 require: " + id);
  };

  const sandbox = {
    require: sandboxRequire,
    module: { exports: {} },
    exports: {},
    console: {
      log: (...a) => rec.logs.push(a),
      error: (...a) => rec.errors.push(a),
      warn: (...a) => rec.warns.push(a),
    },
    process: {
      on: (ev, cb) => {
        processHandlers[ev] = cb;
      },
      argv: ["electron", "."],
      env: {},
      stdout: { on: () => {} },
      stderr: { on: () => {} },
    },
    __filename: MAIN_PATH,
    __dirname: path.dirname(MAIN_PATH),
    setTimeout,
    clearTimeout,
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: MAIN_PATH });

  return {
    rec,
    processHandlers,
    /** 触发 Electron 的 browser-window-created —— 唯一的「窗口曾创建成功」信号 */
    emitWindowCreated: () => {
      const hs = appHandlers["browser-window-created"] || [];
      assert.ok(hs.length > 0, "main.js 必须监听 browser-window-created 才能判定启动是否成功");
      hs.forEach((h) => h());
    },
    setWindows: (list) => {
      windows = list;
    },
    runReady: () => {
      assert.ok(readyCb, "main.js 未在 whenReady().then 注册回调");
      return readyCb();
    },
  };
}

/** 把 console.error 的实参数组拼成可搜索的字符串。 */
function flat(calls) {
  return calls.map((a) => a.map((x) => (x && x.stack) || String(x)).join(" | "));
}

/* --------------------------------------------------- 启动期：必须退出 */

test("启动期未捕获异常：记完整堆栈 + 弹一次说明弹窗 + app.exit(1)", () => {
  const m = loadMain();
  const err = new Error("初始化炸了");
  m.processHandlers.uncaughtException(err);

  assert.equal(m.rec.errorBox.length, 1, "必须弹且只弹一次启动失败弹窗");
  assert.equal(m.rec.errorBox[0][0], STARTUP_DIALOG_TITLE);
  assert.match(m.rec.errorBox[0][1], /qq-local/, "弹窗必须给出常见成因（存档目录不可写等）");
  assert.match(m.rec.errorBox[0][1], /初始化炸了/, "弹窗必须带上原始错误信息");
  assert.deepEqual(m.rec.exit, [[1]], "必须以退出码 1 结束进程，否则留下占着单实例锁的僵尸进程");
  assert.ok(
    flat(m.rec.errors).some((s) => s.includes("startupZombieGuard.test.js")),
    "必须落完整堆栈，否则启动失败不可诊断"
  );
});

test("弹窗返回后除 app.exit(1) 不再做别的事（showErrorBox 同步阻塞且跑嵌套消息循环）", () => {
  const m = loadMain();
  m.processHandlers.uncaughtException(new Error("x"));
  assert.deepEqual(m.rec.order, ["errorBox", "exit"], "弹窗与退出之间不允许插入任何其他外部调用");
});

test("启动期第二次异常不再重复弹窗（模态弹窗弹两次等于卡死用户），但仍然退出", () => {
  const m = loadMain();
  m.processHandlers.uncaughtException(new Error("first"));
  m.processHandlers.uncaughtException(new Error("second"));
  assert.equal(m.rec.errorBox.length, 1, "弹窗只允许一次");
  assert.deepEqual(m.rec.exit, [[1], [1]], "两次都必须走到 exit(1)");
});

test("启动期未处理的 Promise 拒绝同样退出（异步启动路径绕过 createWindow 的 try）", () => {
  const m = loadMain();
  m.processHandlers.unhandledRejection(new Error("service init 拒绝"), {});
  assert.equal(m.rec.errorBox.length, 1);
  assert.deepEqual(m.rec.exit, [[1]]);
  assert.match(m.rec.errorBox[0][1], /service init 拒绝/);
});

test("createWindow 内的同步抛出复用同一份弹窗文案与退出逻辑", () => {
  const m = loadMain({
    stubs: {
      "./src/ini/security.js": () => {
        throw new Error("权限门禁装不上");
      },
    },
  });
  m.runReady();
  assert.equal(m.rec.errorBox.length, 1, "createWindow 的 catch 必须弹同一个窗");
  assert.equal(m.rec.errorBox[0][0], STARTUP_DIALOG_TITLE, "标题必须与 process 处理器那条完全一致");
  assert.match(m.rec.errorBox[0][1], /权限门禁装不上/);
  assert.deepEqual(m.rec.exit, [[1]]);
  assert.deepEqual(m.rec.order, ["errorBox", "exit"]);
});

/* --------------------------------------------------- 运行期：只记日志，不退出 */

test("运行期未捕获异常：只记日志，不弹窗、不退出（桌宠是长驻进程）", () => {
  const m = loadMain();
  m.emitWindowCreated(); // 窗口曾创建成功 ⇒ 之后都算运行期
  m.processHandlers.uncaughtException(new Error("运行期孤立异常"));

  assert.deepEqual(m.rec.exit, [], "运行期绝不能退出，否则用户的宠物会凭空消失");
  assert.deepEqual(m.rec.errorBox, [], "运行期不该弹启动失败弹窗");
  const logged = m.rec.errors.filter((a) => a[0] === "[FATAL] 未捕获异常:");
  assert.equal(logged.length, 1, "运行期必须恰好记一条带堆栈的未捕获异常日志");
  assert.match(logged[0][1], /运行期孤立异常/);
});

test("运行期未处理的 Promise 拒绝：只记日志，不退出", () => {
  const m = loadMain();
  m.emitWindowCreated();
  m.processHandlers.unhandledRejection(new Error("LLM 配额耗尽"), { p: 1 });

  assert.deepEqual(m.rec.exit, []);
  assert.deepEqual(m.rec.errorBox, []);
  const logged = m.rec.errors.filter((a) => a[0] === "[FATAL] 未处理的 Promise 拒绝:");
  assert.equal(logged.length, 1);
  assert.match(logged[0][1], /LLM 配额耗尽/);
});

test("没收到 browser-window-created 但当前存在活窗口时，仍按运行期处理", () => {
  const m = loadMain({ windows: [{ id: 1 }] });
  m.processHandlers.uncaughtException(new Error("late boom"));
  assert.deepEqual(m.rec.exit, [], "BrowserWindow.getAllWindows() 非空即有 UI 可交互，不是僵尸进程");
  assert.deepEqual(m.rec.errorBox, []);
});

test("窗口曾创建成功后即便当前无活窗口，也不再判定为启动失败", () => {
  const m = loadMain({ windows: [{ id: 1 }] });
  m.emitWindowCreated();
  m.setWindows([]); // 例如退出流程里子窗全关了
  m.processHandlers.uncaughtException(new Error("退出途中的异常"));
  assert.deepEqual(m.rec.exit, [], "闭锁一旦置位就不能回退，否则退出流程中的异常会误弹启动失败窗");
});

test("抢不到单实例锁的第二实例：按设计无窗口即退出，不得弹假的启动失败弹窗", () => {
  const m = loadMain({ gotTheLock: false });
  m.runReady(); // createWindow 走 app.exit(true) 分支，全程不创建窗口
  m.processHandlers.uncaughtException(new Error("第二实例退出途中的异常"));
  assert.deepEqual(m.rec.errorBox, [], "第二实例本就不该有窗口，不能被判成启动失败");
  assert.deepEqual(m.rec.exit, [[true]], "只应有 createWindow 里那次 app.exit(true)，不得追加 exit(1)");
});

/* --------------------------------------------------- EPIPE 静默不受影响 */
test("EPIPE 在启动期也保持完全静默（不记日志、不弹窗、不退出）", () => {
  const m = loadMain();
  m.processHandlers.uncaughtException(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  assert.deepEqual(m.rec.errors, [], "EPIPE 是管道断开的预期噪音，必须在启动兜底之前被短路");
  assert.deepEqual(m.rec.errorBox, []);
  assert.deepEqual(m.rec.exit, []);
});

test("console.* 的 EPIPE 防护仍然吞掉写失败", () => {
  const m = loadMain();
  // 让 console.error 底层抛 EPIPE，safeFn 应吞掉；抛别的错则应上抛
  m.rec.errors.push = () => {
    throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  };
  m.emitWindowCreated();
  assert.doesNotThrow(() => m.processHandlers.uncaughtException(new Error("boom")));
});

/* --------------------------------------------------- 正常启动路径不被误伤 */

test("正常启动：不弹窗、不退出", () => {
  const m = loadMain();
  m.runReady();
  assert.deepEqual(m.rec.errorBox, []);
  assert.deepEqual(m.rec.exit, []);
});
