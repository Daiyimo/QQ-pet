// 作弊快捷键 dev 门控测试（修复点：发布版常驻 Ctrl+Shift+1/2/3/4 等作弊快捷键，
// store 窗把 shortcut 事件透传给 global.runCheatShortcut）。
// 运行：node --test test/cheatShortcutGate.test.js
//
// store/main.js 是 webpack 压缩产物但模块加载期只 require("path")，可直接加载；
// 用全局桩 windowsMain 捕获 preloads 注册的 IPC 处理器做真实行为断言。
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const STORE_MAIN = path.join(__dirname, "..", "src/windows/popups/store/main.js");

function loadStoreMain({ dev }) {
  const origArgv = process.argv;
  const origTest = global.$test;
  global.$test = false;
  process.argv = dev ? [...origArgv, "--dev"] : origArgv.filter((a) => a !== "--dev");
  delete require.cache[STORE_MAIN];
  try {
    return require(STORE_MAIN);
  } finally {
    process.argv = origArgv;
    global.$test = origTest;
  }
}

function captureHandlers(instance) {
  const handlers = {};
  const fakeWin = { webContents: { send() {} }, on() {}, close() {} };
  const origOpen = global.windowsMain;
  global.windowsMain = {
    open(opts) {
      opts.created({
        vm: fakeWin,
        preloads: (h) => Object.assign(handlers, h),
        getinfo() {},
      });
      return Promise.resolve(fakeWin);
    },
  };
  try {
    instance.cleate();
  } finally {
    global.windowsMain = origOpen;
  }
  return handlers;
}

test("发布模式：store 的 shortcut 事件不透传 runCheatShortcut", () => {
  const instance = loadStoreMain({ dev: false });
  const handlers = captureHandlers(instance);
  assert.equal(typeof handlers["store_h_bus_m"], "function");

  let cheatCalls = 0;
  global.runCheatShortcut = () => {
    cheatCalls++;
    return true;
  };
  try {
    handlers["store_h_bus_m"](null, { event: "shortcut", key: "Ctrl+Shift+3" });
    handlers["store_h_bus_m"](null, { event: "shortcut", key: "Ctrl+Shift+numadd" });
  } finally {
    delete global.runCheatShortcut;
  }
  assert.equal(cheatCalls, 0, "非 dev 模式不得响应作弊快捷键");
});

test("dev 模式：store 的 shortcut 事件正常透传", () => {
  const instance = loadStoreMain({ dev: true });
  const handlers = captureHandlers(instance);

  const keys = [];
  global.runCheatShortcut = (k) => {
    keys.push(k);
    return true;
  };
  try {
    handlers["store_h_bus_m"](null, { event: "shortcut", key: "Ctrl+Shift+3" });
  } finally {
    delete global.runCheatShortcut;
  }
  assert.deepEqual(keys, ["Ctrl+Shift+3"], "dev 模式应正常透传");
});

test("发布模式：cartCleared 等相邻分支不受门控影响", () => {
  const instance = loadStoreMain({ dev: false });
  const handlers = captureHandlers(instance);

  let speakCalls = 0;
  global.openSpeak = () => speakCalls++;
  try {
    handlers["store_h_bus_m"](null, { event: "cartCleared" });
  } finally {
    delete global.openSpeak;
  }
  assert.equal(speakCalls, 1, "cartCleared 分支应照常工作");
});
