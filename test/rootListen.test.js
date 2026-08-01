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
const DOMAIN_PATH = require.resolve("../src/ini/doMain.js");
// root.js 导出的 DEFAULT_PORT 才是真值，下面有断言把这个常量与它钉死
const BASE_PORT = 33385;

const readRootSource = () => require("node:fs").readFileSync(ROOT_PATH, "utf8");

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
    assert.ok(
      errors.some(
        (m) => m.includes("本机静态服务启动失败") && m.includes(String(root.DEFAULT_PORT))
      ),
      "汇总日志里的起始端口必须由 DEFAULT_PORT 插值而来，不能是写死的文案（否则改端口后日志会误导排查者）"
    );
  });
});

// 上面那条断言是「相对常量」的：它保护的是"真的按 LISTEN_MAX_ATTEMPTS 试了这么多次"这个行为，
// 但把常量从 5 改成 6 它照样全绿。下面这条是「值锁」，两件事，都要有。
test("LISTEN_MAX_ATTEMPTS 值锁：改这个数字要走评审", async () => {
  await withRoot([], ({ root }) => {
    assert.equal(
      root.LISTEN_MAX_ATTEMPTS,
      5,
      "LISTEN_MAX_ATTEMPTS 被改动了。改这个数字需要评审：它决定端口被占用时最多试几个端口" +
        "（33385..33385+N-1），直接决定用户可感知的启动失败等待时长——每次尝试都要等一个 TCP 绑定" +
        "往返，试满才回调 null 弹降级提示。调大 = 用户干等更久，调小 = 端口冲突时更容易直接失败。" +
        "若确实要调，请连同本断言与 README 的端口说明一并改，别只把测试数字对齐。"
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

test("createMain：不再自带 express 引导，任何参数下都只做 (post, ip, fileName) 直通", async () => {
  await withRoot([], async ({ root, attempts, instances }) => {
    // 不传第 5 个参数（旧 none），修复前会走 express 分支并真的去 listen
    const got = await new Promise((resolve) => {
      root.createMain((port, host, fileName) => resolve({ port, host, fileName }), BASE_PORT, 0, "u");
    });
    assert.deepEqual(got, { port: BASE_PORT, host: 0, fileName: "u" });
    assert.equal(attempts.length, 0, "createMain 不应再触发任何 listen（express 分支已删）");
    assert.equal(instances.length, 0, "createMain 不应再创建 express 实例");
  });
});

test("createMain：doMain 现有用法（第 5 个参数 !0）行为不变", async () => {
  await withRoot([], async ({ root, attempts }) => {
    const got = await new Promise((resolve) => {
      root.createMain(
        (port, host, fileName) => resolve({ port, host, fileName }),
        String(BASE_PORT),
        0,
        "u",
        true
      );
    });
    assert.deepEqual(got, { port: String(BASE_PORT), host: 0, fileName: "u" });
    assert.equal(attempts.length, 0, "none=true 不应触发任何 listen");
  });
});

test("createMain 源码里不再残留 express 引导（与 openLocalHost 同构的死代码）", async () => {
  const src = readRootSource();
  const body = src.slice(src.indexOf("const createMain ="), src.indexOf("if (typeof module"));
  for (const token of ["_require(\"express\")", "mountStatic", "listenWithRetry"]) {
    assert.ok(
      !body.split("\n").some((line) => !line.trim().startsWith("//") && line.includes(token)),
      `createMain 内又出现了 ${token}：express 引导只应有 openLocalHost 一份`
    );
  }
});

test("DEFAULT_PORT 是本文件唯一真值：源码里不得再出现裸 33385 字面量", async () => {
  await withRoot([], ({ root }) => {
    assert.equal(root.DEFAULT_PORT, BASE_PORT, "本测试的 BASE_PORT 应与导出的默认端口一致");
    const src = readRootSource();
    const lines = src.split("\n");
    const declarations = [];
    lines.forEach((line, i) => {
      if (!line.includes(String(root.DEFAULT_PORT))) return;
      const trimmed = line.trim();
      if (trimmed.startsWith("//")) return; // 注释里说明来源是允许的
      assert.match(
        trimmed,
        /^const DEFAULT_PORT = \d+;$/,
        `root.js:${i + 1} 又把默认端口写成了字面量，应改用 DEFAULT_PORT: ${trimmed}`
      );
      declarations.push(trimmed);
    });
    assert.equal(declarations.length, 1, "默认端口应恰好只在一处声明");
  });
});

test("跨文件：doMain.js 传给 createMain 的端口字面量必须等于 root.js 的 DEFAULT_PORT", async () => {
  await withRoot([], ({ root }) => {
    const doMainSrc = require("node:fs").readFileSync(DOMAIN_PATH, "utf8");
    // doMain.js 是压缩产物，这里锚定整个调用尾部：createMain(回调, "端口", 0, 随机段, !0)
    const call = /,"(\d+)",0,upDownArr\(shuffleArr\(fileName\)\)\.join\(""\),!0\)/.exec(doMainSrc);
    assert.ok(
      call,
      "没在 doMain.js 里匹配到 createMain 的调用尾部：调用形状变了，请同步本断言与 root.js 的注释"
    );
    assert.equal(
      Number(call[1]),
      root.DEFAULT_PORT,
      `doMain.js 传入 ${call[1]}，root.js DEFAULT_PORT 是 ${root.DEFAULT_PORT}：两侧必须一致，否则改端口只改一半`
    );
  });
});

test("openWS 死代码已删除，nodejs-websocket 不再被引用", async () => {
  await withRoot([], ({ root }) => {
    assert.equal(root.openWS, undefined, "openWS 应已删除");
    assert.deepEqual(
      Object.keys(root).sort(),
      ["LISTEN_MAX_ATTEMPTS", "DEFAULT_PORT", "createMain", "listenWithRetry"].sort()
    );
    const src = readRootSource();
    // 只允许出现在"已删除"的说明注释里
    for (const line of src.split("\n")) {
      if (line.includes("nodejs-websocket")) {
        assert.match(line.trim(), /^\/\//, `nodejs-websocket 仍被实际引用: ${line.trim()}`);
      }
    }
  });
});
