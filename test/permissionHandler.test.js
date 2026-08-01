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
