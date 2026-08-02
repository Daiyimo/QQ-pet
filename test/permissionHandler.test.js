"use strict";

// src/ini/security.js 单元测试：会话级权限门禁（默认拒绝 + 两个 handler 策略一致）
// 运行：node --test test/permissionHandler.test.js
//
// 用桩 session，不依赖真 Electron：被测模块刻意不 require electron，
// 只要求传入的对象有 setPermissionRequestHandler / setPermissionCheckHandler。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PERMISSION_ALLOW_LIST,
  isPermissionAllowed,
  installPermissionHandlers,
  installRemoteSessionGuards,
} = require("../src/ini/security.js");

/**
 * Electron 28 的权限名全集，逐字抄自 node_modules/electron/electron.d.ts：
 * setPermissionRequestHandler 的 permission 联合类型（d.ts 第 9634 行）。
 * 这里刻意硬编码而不是从被测模块导入 —— 否则就是拿模块的常量断言模块自己。
 */
const REQUEST_PERMISSIONS = [
  "clipboard-read",
  "clipboard-sanitized-write",
  "display-capture",
  "fullscreen",
  "geolocation",
  "idle-detection",
  "media",
  "mediaKeySystem",
  "midi",
  "midiSysex",
  "notifications",
  "pointerLock",
  "keyboardLock",
  "openExternal",
  "storage-access",
  "top-level-storage-access",
  "window-management",
  "unknown",
];

/** setPermissionCheckHandler 的 permission 联合类型（d.ts 第 9625 行），与上面不完全相同 */
const CHECK_PERMISSIONS = [
  "clipboard-read",
  "clipboard-sanitized-write",
  "geolocation",
  "fullscreen",
  "hid",
  "idle-detection",
  "media",
  "mediaKeySystem",
  "midi",
  "midiSysex",
  "notifications",
  "openExternal",
  "pointerLock",
  "serial",
  "storage-access",
  "top-level-storage-access",
  "usb",
];

/** 桩 session：接住两个 handler，并把 console.warn 收进数组 */
function setupStub() {
  const stub = {
    requestHandler: null,
    checkHandler: null,
    setPermissionRequestHandler(fn) {
      this.requestHandler = fn;
    },
    setPermissionCheckHandler(fn) {
      this.checkHandler = fn;
    },
  };
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  const installed = installPermissionHandlers(stub);
  console.warn = origWarn;
  return { stub, warns, installed };
}

/** 调用 request handler，返回 callback 收到的布尔值与期间产生的 warn 记录 */
function callRequest(stub, permission, details) {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  let granted = "callback-not-called";
  try {
    stub.requestHandler({ getURL: () => "http://evil.example/x" }, permission, (v) => {
      granted = v;
    }, details);
  } finally {
    console.warn = origWarn;
  }
  return { granted, warns };
}

/** 调用 check handler，返回它的返回值与期间产生的 warn 记录 */
function callCheck(stub, permission, origin) {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  let result;
  try {
    result = stub.checkHandler(null, permission, origin, {});
  } finally {
    console.warn = origWarn;
  }
  return { result, warns };
}

test("安装后 defaultSession 的两个权限 handler 都被设上", () => {
  const { stub, installed } = setupStub();
  assert.equal(installed, true);
  assert.equal(typeof stub.requestHandler, "function");
  assert.equal(typeof stub.checkHandler, "function");
});

test("session 不支持权限 handler 时返回 false 并留日志，而不是静默跳过", () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  const r1 = installPermissionHandlers(null);
  const r2 = installPermissionHandlers({});
  console.warn = origWarn;
  assert.equal(r1, false);
  assert.equal(r2, false);
  assert.equal(warns.length, 2);
  assert.equal(warns[0][0], "[ini/security]");
  assert.match(warns[0][1], /权限门禁未生效/);
});

test("白名单为空：本应用渲染层不需要任何 Web 权限（核查结论见 security.js 注释）", () => {
  assert.deepEqual(Array.from(PERMISSION_ALLOW_LIST), []);
});

test("setPermissionRequestHandler 对 Electron 28 全部权限名逐个拒绝", () => {
  const { stub } = setupStub();
  // 精确断言：不抽样，18 个权限名逐个走一遍
  assert.equal(REQUEST_PERMISSIONS.length, 18);
  for (const p of REQUEST_PERMISSIONS) {
    const { granted } = callRequest(stub, p, { requestingUrl: "http://evil.example/x" });
    assert.equal(granted, false, `权限 ${p} 应被拒绝，实际 ${granted}`);
  }
});

test("setPermissionCheckHandler 对 Electron 28 全部权限名逐个拒绝", () => {
  const { stub } = setupStub();
  assert.equal(CHECK_PERMISSIONS.length, 17);
  for (const p of CHECK_PERMISSIONS) {
    const { result } = callCheck(stub, p, "http://evil.example");
    assert.equal(result, false, `权限 ${p} 的 check 应返回 false，实际 ${result}`);
  }
});

test("恶意页面最想要的三个权限 media / geolocation / notifications 被明确拒绝", () => {
  const { stub } = setupStub();
  // 单列一条：这三个是本次防护的核心威胁（urlWindow 加载任意网址 + Electron 无权限提示 UI）
  for (const p of ["media", "geolocation", "notifications", "display-capture"]) {
    assert.equal(callRequest(stub, p, {}).granted, false);
  }
});

test("两个 handler 对同一权限给出一致结论（防 query 说 granted 而 request 被拒）", () => {
  const { stub } = setupStub();
  const union = Array.from(new Set([...REQUEST_PERMISSIONS, ...CHECK_PERMISSIONS]));
  assert.equal(union.length, 21);
  for (const p of union) {
    const { granted } = callRequest(stub, p, {});
    const { result } = callCheck(stub, p, "https://x.example");
    assert.equal(
      granted,
      result,
      `权限 ${p} 两个 handler 结论不一致：request=${granted} check=${result}`
    );
  }
});

test("拒绝权限请求时留下 [ini/security] 日志，带权限名与来源", () => {
  const { stub } = setupStub();
  const { granted, warns } = callRequest(stub, "media", { requestingUrl: "http://evil.example/x" });
  assert.equal(granted, false);
  assert.equal(warns.length, 1);
  assert.equal(warns[0][0], "[ini/security]");
  assert.equal(warns[0][1], "已拒绝权限请求:");
  assert.equal(warns[0][2], "media");
  assert.ok(
    warns[0].some((a) => a === "http://evil.example/x"),
    "日志里必须能看到请求来源，否则将来功能被挡住不可诊断"
  );
});

test("拒绝权限查询时同样留日志（同步路径不能静默）", () => {
  const { stub } = setupStub();
  const { result, warns } = callCheck(stub, "geolocation", "https://tracker.example");
  assert.equal(result, false);
  assert.equal(warns.length, 1);
  assert.equal(warns[0][0], "[ini/security]");
  assert.equal(warns[0][1], "已拒绝权限查询:");
  assert.equal(warns[0][2], "geolocation");
  assert.equal(warns[0][4], "https://tracker.example");
});

test("放行机制可用：白名单里的权限被 allow 且不产生拒绝日志", () => {
  // 生产白名单为空，故用注入的白名单验证「加白后确实放行」这条路径不是死代码
  assert.equal(isPermissionAllowed("media", ["media"]), true);
  assert.equal(isPermissionAllowed("media", ["notifications"]), false);
  assert.equal(isPermissionAllowed("notifications", ["media", "notifications"]), true);
});

test("非法/未知权限名一律拒绝，且不抛异常", () => {
  const { stub } = setupStub();
  for (const bad of [undefined, null, "", 123, {}, [], "MEDIA", "media ", "camera"]) {
    assert.equal(isPermissionAllowed(bad), false);
    assert.equal(callRequest(stub, bad, {}).granted, false);
    assert.equal(callCheck(stub, bad, "").result, false);
  }
});

test("request handler 必定调用 callback（漏调会让页面永久挂在 pending）", () => {
  const { stub } = setupStub();
  const { granted } = callRequest(stub, "midi", {});
  assert.notEqual(granted, "callback-not-called");
  assert.equal(granted, false);
});

// ---------------------------------------------------------------------------
// installRemoteSessionGuards：远程页面专用 session（urlWindow 的 persist:remote-url 分区）
//
// 为什么这几条是安全断言而不是锦上添花：远程子窗一旦从 defaultSession 拆出去，
// main.js 里那次 installPermissionHandlers(session.defaultSession) 就不再覆盖它。
// 若新 session 没补装门禁，摄像头/麦克风/定位会回到 Electron 默认放行且无权限气泡 UI，
// 「存储隔离」反而把门禁绕过去了。所以下面第 3 条（与 defaultSession 同策略）是核心。
// ---------------------------------------------------------------------------

/** 桩远程 session：在 setupStub 的基础上多一个 on()，把事件监听器记进 Map */
function setupRemoteStub() {
  const listeners = new Map();
  const stub = {
    requestHandler: null,
    checkHandler: null,
    listeners,
    setPermissionRequestHandler(fn) {
      this.requestHandler = fn;
    },
    setPermissionCheckHandler(fn) {
      this.checkHandler = fn;
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return this;
    },
  };
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  let installed;
  try {
    installed = installRemoteSessionGuards(stub);
  } finally {
    console.warn = origWarn;
  }
  return { stub, warns, installed };
}

/** 触发 will-download，返回是否被 preventDefault 与期间的 warn 记录 */
function fireWillDownload(stub, item) {
  const handlers = stub.listeners.get("will-download") || [];
  assert.equal(handlers.length, 1, "will-download 监听器应恰好 1 个");
  let prevented = false;
  const event = {
    preventDefault() {
      prevented = true;
    },
  };
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  try {
    handlers[0](event, item, { id: 1 });
  } finally {
    console.warn = origWarn;
  }
  return { prevented, warns };
}

test("installRemoteSessionGuards：注册 will-download 观测，且放行默认的系统保存对话框", () => {
  const { stub, installed, warns } = setupRemoteStub();
  assert.equal(installed, true);
  assert.equal(warns.length, 0, "正常安装路径不该有 warn");
  assert.equal(stub.listeners.has("will-download"), true, "必须注册 will-download 观测");

  const { prevented, warns: dlWarns } = fireWillDownload(stub, {
    getURL: () => "https://files.evil.example/a/b.exe?token=SECRET_CREDENTIAL",
    getFilename: () => "b.exe",
  });

  assert.equal(
    prevented,
    false,
    "will-download 必须只观测不拦截：Electron 默认行为就是弹系统保存对话框（用户确认后才落盘），" +
      "preventDefault 会把这个窗口的下载能力整个砍掉，是功能回退而不是加固。"
  );
  assert.equal(dlWarns.length, 1, `一次下载应恰好一条日志，实测 ${dlWarns.length} 条`);
  assert.equal(dlWarns[0][0], "[ini/security]");
  const line = dlWarns[0].join(" ");
  assert.match(line, /files\.evil\.example/, "日志必须能看出下载来源 host，否则不可诊断");
  assert.match(line, /b\.exe/, "日志必须带文件名");
  assert.doesNotMatch(
    line,
    /SECRET_CREDENTIAL/,
    "刻意只记 host + 文件名：下载直链的 query 常带一次性 token/签名，整串 URL 进日志等于把凭据写到磁盘"
  );
});

test("installRemoteSessionGuards：item 缺失或取不到文件名时不抛（日志代码不许拖垮下载）", () => {
  const { stub } = setupRemoteStub();
  const items = [
    undefined,
    null,
    {},
    { getURL: () => undefined, getFilename: () => undefined },
    { getURL: () => "not-a-url", getFilename: () => "" },
    {
      getURL() {
        throw new Error("boom");
      },
      getFilename: () => "x.bin",
    },
  ];
  for (const item of items) {
    const { prevented, warns } = fireWillDownload(stub, item);
    assert.equal(prevented, false, "任何情况下都不拦截");
    assert.ok(warns.length >= 1, "即使元信息取不到，也要留下「有下载发生」这条记录");
  }
});

test("远程 session 的两个权限 handler 与 defaultSession 同策略（隔离不许顺手放宽）", () => {
  const { stub: remote } = setupRemoteStub();
  const { stub: dflt } = setupStub();
  assert.equal(typeof remote.requestHandler, "function", "远程 session 必须也装上 request handler");
  assert.equal(typeof remote.checkHandler, "function", "远程 session 必须也装上 check handler");

  const union = Array.from(new Set([...REQUEST_PERMISSIONS, ...CHECK_PERMISSIONS]));
  assert.equal(union.length, 21);
  for (const p of union) {
    const remoteReq = callRequest(remote, p, {}).granted;
    const remoteChk = callCheck(remote, p, "https://evil.example").result;
    assert.equal(
      remoteReq,
      false,
      `远程 session 的权限请求 ${p} 必须被拒：这是全应用唯一加载任意网址的窗口`
    );
    assert.equal(remoteChk, false, `远程 session 的权限查询 ${p} 必须返回 false`);
    // 与 defaultSession 逐项对齐：防「加了 partition 顺手给远程窗放宽一项」
    assert.equal(remoteReq, callRequest(dflt, p, {}).granted, `权限 ${p} 远程与默认 session 策略不一致`);
    assert.equal(
      remoteChk,
      callCheck(dflt, p, "https://evil.example").result,
      `权限 ${p} 远程与默认 session 的 check 策略不一致`
    );
  }
});

test("installRemoteSessionGuards：session 不可用时返回 false 并留日志（fail-closed 可见）", () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  const r1 = installRemoteSessionGuards(null);
  const r2 = installRemoteSessionGuards({}); // 无 on
  const r3 = installRemoteSessionGuards({ on() {} }); // 有 on 但没有权限 setter
  console.warn = origWarn;
  assert.equal(r1, false);
  assert.equal(r2, false);
  assert.equal(r3, false, "权限门禁装不上时整体必须失败——只有下载日志没有门禁是负收益");
  assert.equal(warns.length, 3);
  assert.equal(warns[0][0], "[ini/security]");
  assert.match(warns[0][1], /远程会话守卫未生效/);
  assert.match(warns[2][1], /权限门禁未生效/);
});

test("installRemoteSessionGuards：重复调用不重复注册 will-download（监听器不许叠加）", () => {
  const { stub } = setupRemoteStub();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(installRemoteSessionGuards(stub), true);
    assert.equal(installRemoteSessionGuards(stub), true);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(
    stub.listeners.get("will-download").length,
    1,
    "远程窗会被反复开关，_mkSub 每次都会调本函数；监听器叠加会让一次下载打出 N 条日志"
  );
  // 幂等之后监听器仍然可用，且仍然不拦截
  assert.equal(fireWillDownload(stub, { getURL: () => "https://a.example/f", getFilename: () => "f" }).prevented, false);
});

test("main.js 在创建任何窗口之前接入权限门禁（结构断言，防接入点被摘掉）", () => {
  // 为什么是结构断言：main.js 强依赖 Electron 运行时（app.whenReady / dialog），
  // 无法在纯 node 下行为测试；但接入点一旦被删，上面所有测试仍然全绿而防护实际失效。
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

  const installIdx = src.indexOf("installPermissionHandlers(session.defaultSession)");
  assert.notEqual(installIdx, -1, "main.js 必须调用 installPermissionHandlers(session.defaultSession)");
  assert.match(src, /const \{[^}]*\bsession\b[^}]*\} = require\("electron"\)/, "main.js 必须从 electron 取 session");

  // 顺序：必须先装门禁，再走 init.js / doMain.js（后者会创建窗口）
  const initIdx = src.indexOf('require("./src/ini/init.js")');
  const doMainIdx = src.indexOf('require("./src/ini/doMain.js")');
  assert.notEqual(initIdx, -1);
  assert.notEqual(doMainIdx, -1);
  assert.ok(installIdx < initIdx, "权限门禁必须在 init.js 之前安装");
  assert.ok(installIdx < doMainIdx, "权限门禁必须在 doMain.js（创建窗口）之前安装");

  // 且整段必须落在 app.whenReady() 之后的调用链里（session.defaultSession 在 ready 前不可用）
  assert.match(src, /app\.whenReady\(\)/);
  assert.ok(src.indexOf("const createWindow") < installIdx, "接入点应在 createWindow 内，由 whenReady 触发");
});
