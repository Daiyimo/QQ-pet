// preload 事件对象透传修复的回归测试（修复点：ipcRenderer.on(channel, cb) 直传把
// IpcRendererEvent（含 sender）泄漏给渲染层回调，现统一包装为 (_e,...args)=>cb(...args)）。
// 运行：node --test test/preloadEventStrip.test.js
//
// 方法：Module._load 拦截 electron，contextBridge/ipcRenderer 用桩捕获；
// 逐个加载 src/windows 下全部 preload.js，调用暴露的每个 API（传哨兵回调），
// 再用 (fakeEvent, ...args) 触发捕获到的监听器，断言渲染层回调只收到 args。
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const WINDOWS_DIR = path.join(__dirname, "..", "src/windows");

function findPreloads(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findPreloads(p));
    else if (entry.name === "preload.js") out.push(p);
  }
  return out;
}

function loadPreload(preloadPath) {
  const listeners = []; // { channel, fn }
  const exposed = {};
  const electronFake = {
    contextBridge: {
      exposeInMainWorld: (name, api) => {
        exposed[name] = api;
      },
    },
    ipcRenderer: {
      on: (channel, fn) => listeners.push({ channel, fn }),
      send() {},
    },
  };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electronFake;
    return origLoad.apply(this, arguments);
  };
  delete require.cache[preloadPath];
  try {
    require(preloadPath);
  } finally {
    Module._load = origLoad;
  }
  return { listeners, exposed };
}

const preloads = findPreloads(WINDOWS_DIR);
assert.ok(preloads.length >= 15, "应发现全部 preload.js");

for (const preloadPath of preloads) {
  const rel = path.relative(WINDOWS_DIR, preloadPath);
  test(`preload 不透传 IpcRendererEvent: ${rel}`, () => {
    const { listeners, exposed } = loadPreload(preloadPath);
    const received = [];
    const sentinel = (...args) => received.push(args);

    // 调用全部暴露 API：on 类会注册监听器，send 类把哨兵当消息发掉（桩里无操作）
    for (const api of Object.values(exposed)) {
      for (const fn of Object.values(api)) {
        if (typeof fn !== "function") continue;
        try {
          fn(sentinel);
        } catch (e) {
          // 个别 API（如 main/preload 的皮肤文件读取）对哨兵入参报错属预期，忽略
        }
      }
    }

    assert.ok(listeners.length > 0, `${rel} 应至少注册一个 ipcRenderer.on 监听器`);
    const fakeEvent = { sender: { send() {} }, frameId: 1 };
    for (const { channel, fn } of listeners) {
      received.length = 0;
      fn(fakeEvent, "arg1", { k: 2 });
      assert.equal(received.length, 1, `${rel} ${channel} 哨兵回调应被调用一次`);
      assert.deepEqual(
        received[0],
        ["arg1", { k: 2 }],
        `${rel} ${channel} 回调不得收到 event 对象（含 sender）`
      );
      assert.notEqual(received[0][0], fakeEvent);
    }
  });
}
