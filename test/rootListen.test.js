// src/ini/root.js 的监听失败降级测试。
//
// 修复的缺陷：三处 `app.listen(port, host, cb)` 都只传成功回调、没有 server.on("error")。
// EADDRINUSE 通过 'error' 事件抛出，会落进 main.js 的 uncaughtException（只记日志不退出），
// 于是成功回调永不触发——用户点「池塘 / 游戏 / 密室」时窗口永远不出现，且零提示。
//
// express 通过 Module.prototype.require 注入（root.js 内部是 `eval("require")`），
// 本机无 node_modules 也能跑。
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const ROOT_PATH = require.resolve("../src/ini/root.js");
const BASE_PORT = 33385;

/**
 * express 替身：busyPorts 里的端口一律以 EADDRINUSE 失败。
 * 记录每次 listen 的 (port, host) 以便断言重试与绑定地址。
 */
function makeExpress(busyPorts = []) {
  const attempts = [];
  const instances = [];
  const express = () => {
    const app = {
      get() {},
      use() {},
      listen(port, host, cb) {
        const numeric = Number(port);
        attempts.push({ port: numeric, host });
        const server = new EventEmitter();
        server.address = () => ({ address: host, port: numeric });
        setImmediate(() => {
          if (busyPorts.includes(numeric)) {
            const err = new Error(`listen EADDRINUSE: address already in use ${host}:${numeric}`);
            err.code = "EADDRINUSE";
            server.emit("error", err);
          } else {
            cb();
          }
        });
        return server;
      },
    };
    instances.push(app);
    return app;
  };
  express.static = () => function staticMiddleware(req, res, next) {
    next();
  };
  return { express, attempts, instances };
}

/** 在注入 express 的前提下加载一份全新的 root.js（模块内有 url 缓存，必须每次重载） */
async function withRoot(busyPorts, fn) {
  const { express, attempts, instances } = makeExpress(busyPorts);
  const origRequire = Module.prototype.require;
  const origOpen = global.openLocalHost;
  const origUpDown = global.upDownArr;
  const origShuffle = global.shuffleArr;
  // ini/tool.js 提供的全局（本测试不加载 tool.js，给出等价桩）
  global.shuffleArr = (arr) => arr.slice();
  global.upDownArr = (arr) => arr.slice();
  delete require.cache[ROOT_PATH];
  Module.prototype.require = function (id) {
    if (id === "express") return express;
    return origRequire.apply(this, arguments);
  };
  const errors = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args) => errors.push(args.map((a) => String(a)).join(" "));
  console.log = () => {};
  try {
    const root = require(ROOT_PATH);
    return await fn({ root, attempts, instances, errors, openLocalHost: global.openLocalHost });
  } finally {
    console.error = origError;
    console.log = origLog;
    Module.prototype.require = origRequire;
    delete require.cache[ROOT_PATH];
    if (origOpen === undefined) delete global.openLocalHost;
    else global.openLocalHost = origOpen;
    if (origUpDown === undefined) delete global.upDownArr;
    else global.upDownArr = origUpDown;
    if (origShuffle === undefined) delete global.shuffleArr;
    else global.shuffleArr = origShuffle;
  }
}

const openOnce = (openLocalHost) => new Promise((resolve) => openLocalHost(resolve));

test("openLocalHost：33385 被占用时自动改用相邻端口，回调照常拿到 url", async () => {
  await withRoot([BASE_PORT], async ({ attempts, errors, openLocalHost }) => {
    const url = await openOnce(openLocalHost);
    assert.ok(url, "修复前这里会永远收不到回调");
    assert.equal(url.port, BASE_PORT + 1, "应自动退到下一个端口");
    assert.equal(url.host, "127.0.0.1");
    assert.ok(url.fileName && url.fileName.length > 0, "随机路径段仍应生成");
    assert.deepEqual(
      attempts.map((a) => a.port),
      [BASE_PORT, BASE_PORT + 1],
      "应先试 33385 再试 33386"
    );
    assert.ok(
      errors.some((m) => m.includes("EADDRINUSE") && m.includes("at ")),
      "每次绑定失败都要留带堆栈的日志"
    );
  });
});

test("openLocalHost：端口全被占用时回调收到 null（不再永不触发），并留错误日志", async () => {
  const busy = [0, 1, 2, 3, 4, 5, 6].map((i) => BASE_PORT + i);
  await withRoot(busy, async ({ root, attempts, errors, openLocalHost }) => {
    const url = await openOnce(openLocalHost);
    assert.equal(url, null, "全失败必须显式回调 null，让调用方降级提示用户");
    assert.equal(
      attempts.length,
      root.LISTEN_MAX_ATTEMPTS,
      `应恰好尝试 ${root.LISTEN_MAX_ATTEMPTS} 个端口`
    );
    assert.ok(
      errors.some((m) => m.includes("本机静态服务启动失败")),
      "放弃时必须留一条汇总错误日志"
    );
  });
});

test("绑定地址恒为 127.0.0.1（README 声称：不对局域网暴露 src/）", async () => {
  await withRoot([BASE_PORT, BASE_PORT + 1], async ({ attempts, openLocalHost }) => {
    await openOnce(openLocalHost);
    assert.ok(attempts.length >= 2);
    for (const a of attempts) {
      assert.equal(a.host, "127.0.0.1", `出现了非回环绑定: ${a.host}`);
    }
  });
});

test("重试期间连点多次：只起一个 express 实例，所有回调都被通知", async () => {
  await withRoot([BASE_PORT, BASE_PORT + 1], async ({ instances, openLocalHost }) => {
    const results = await Promise.all([
      openOnce(openLocalHost),
      openOnce(openLocalHost),
      openOnce(openLocalHost),
    ]);
    assert.equal(instances.length, 1, "连点不应各起一个服务去抢端口");
    for (const r of results) {
      assert.ok(r && r.port === BASE_PORT + 2, `每个等待者都应拿到同一个 url，实际 ${JSON.stringify(r)}`);
    }
    // 成功后再调用走缓存，不再新建实例
    const again = await openOnce(openLocalHost);
    assert.equal(again.port, BASE_PORT + 2);
    assert.equal(instances.length, 1);
  });
});

test("createMain：端口全占用时以 fn(null) 降级，不让调用方无限等待", async () => {
  const busy = [0, 1, 2, 3, 4].map((i) => BASE_PORT + i);
  await withRoot(busy, async ({ root }) => {
    const got = await new Promise((resolve) => {
      root.createMain((port, host, fileName) => resolve({ port, host, fileName }), BASE_PORT, 0, "u");
    });
    assert.equal(got.port, null);
    assert.equal(got.host, null);
    assert.equal(got.fileName, "u", "降级时也要把 fileName 回传，调用方才能给出提示");
  });
});

test("createMain：none=true 时不起服务（doMain 现有用法保持不变）", async () => {
  await withRoot([], async ({ root, attempts }) => {
    const got = await new Promise((resolve) => {
      root.createMain((port, host, fileName) => resolve({ port, host, fileName }), "33385", 0, "u", true);
    });
    assert.deepEqual(got, { port: "33385", host: 0, fileName: "u" });
    assert.equal(attempts.length, 0, "none=true 不应触发任何 listen");
  });
});

test("openWS 死代码已删除，nodejs-websocket 不再被引用", async () => {
  await withRoot([], ({ root }) => {
    assert.equal(root.openWS, undefined, "openWS 应已删除");
    assert.deepEqual(
      Object.keys(root).sort(),
      ["LISTEN_MAX_ATTEMPTS", "createMain", "listenWithRetry"].sort()
    );
    const src = require("node:fs").readFileSync(ROOT_PATH, "utf8");
    // 只允许出现在"已删除"的说明注释里
    for (const line of src.split("\n")) {
      if (line.includes("nodejs-websocket")) {
        assert.match(line.trim(), /^\/\//, `nodejs-websocket 仍被实际引用: ${line.trim()}`);
      }
    }
  });
});
