// stateInfo 窗 stateInfo_bus-upData 的入参白名单校验测试（修复点：渲染层 payload 全量透传 setPetInfo）
// 运行：node --test test/stateInfoGuard.test.js
//
// 两层覆盖：
// 1. normalizeStateInfoUpdate 纯函数单元测试（同 test/ipcInputGuard.test.js 风格）；
// 2. stateInfo/main.js（webpack 压缩产物）的真实接线行为测试：
//    用 Module._load 拦截桩掉 infoCard/control 依赖，捕获 preloads 注册的 IPC 处理器，
//    直接喂恶意 payload，断言 setPetInfo 只收到白名单字段。
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const { normalizeStateInfoUpdate } = require("../src/windows/util/ipcInputGuard.js");

// ---------------------------------------------------------------- 纯函数

test("normalizeStateInfoUpdate 放行 sweetHeart 布尔开关", () => {
  for (const v of [true, false]) {
    const r = normalizeStateInfoUpdate({ otherOptions: { sweetHeart: v } });
    assert.equal(r.hasChange, true);
    assert.deepEqual(r.patch, { otherOptions: { sweetHeart: v } });
    assert.deepEqual(r.rejected, []);
  }
});

test("normalizeStateInfoUpdate 丢弃 yb/growth 等存档字段", () => {
  const r = normalizeStateInfoUpdate({
    info: { yb: 999999999, growth: 999999 },
    maxInfo: { level: 400 },
    otherOptions: { pinkDiamond: true, pinkDiamondLevel: 7 },
    fishing: { canusecnt: 99 },
  });
  assert.equal(r.hasChange, false);
  assert.deepEqual(r.patch, {});
  // 每个越权字段都要出现在 rejected 里（调用方据此记日志）
  for (const k of ["info", "maxInfo", "fishing", "otherOptions.pinkDiamond", "otherOptions.pinkDiamondLevel"]) {
    assert.ok(r.rejected.includes(k), "rejected 应包含 " + k);
  }
});

test("normalizeStateInfoUpdate sweetHeart 非布尔拒绝", () => {
  for (const bad of ["true", 1, 0, null, {}, []]) {
    const r = normalizeStateInfoUpdate({ otherOptions: { sweetHeart: bad } });
    assert.equal(r.hasChange, false, "should reject " + JSON.stringify(bad));
    assert.ok(r.rejected.includes("otherOptions.sweetHeart"));
  }
});

test("normalizeStateInfoUpdate 混合载荷：合法字段应用、非法字段拒绝", () => {
  const r = normalizeStateInfoUpdate({
    otherOptions: { sweetHeart: false, pinkDiamond: true },
    info: { yb: 1 },
  });
  assert.equal(r.hasChange, true);
  assert.deepEqual(r.patch, { otherOptions: { sweetHeart: false } });
  assert.ok(r.rejected.includes("otherOptions.pinkDiamond"));
  assert.ok(r.rejected.includes("info"));
});

test("normalizeStateInfoUpdate type 字段仅用于分支判别、不写入", () => {
  const r = normalizeStateInfoUpdate({ type: "openPetFile" });
  assert.equal(r.hasChange, false);
  assert.deepEqual(r.rejected, []);
});

test("normalizeStateInfoUpdate 对垃圾入参不抛", () => {
  for (const bad of [undefined, null, "str", 123, [], true, { otherOptions: "x" }, { otherOptions: [1] }]) {
    assert.doesNotThrow(() => normalizeStateInfoUpdate(bad));
    assert.equal(normalizeStateInfoUpdate(bad).hasChange, false);
  }
});

// ---------------------------------------------------------------- 真实接线（stateInfo/main.js 压缩产物）

function loadStateInfoMain() {
  const infoCard = { show: false, cleateCalls: 0, doCloseCalls: 0,
    cleate() { this.cleateCalls++; }, doClose() { this.doCloseCalls++; } };
  const control = { show: false, useInState() {} };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request.endsWith("infoCard/main.js")) return infoCard;
    if (request.endsWith("control/main.js")) return control;
    return origLoad.apply(this, arguments);
  };
  const modPath = path.join(__dirname, "..", "src/windows/popups/stateInfo/main.js");
  delete require.cache[modPath];
  let instance;
  try {
    instance = require(modPath);
  } finally {
    Module._load = origLoad;
  }
  return { instance, infoCard };
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
    instance.cleate({ nowPosition: [100, 400], msg: null });
  } finally {
    global.windowsMain = origOpen;
  }
  return handlers;
}

test("stateInfo_bus-upData：恶意 payload 不再全量透传 setPetInfo", () => {
  const { instance } = loadStateInfoMain();
  const handlers = captureHandlers(instance);
  assert.equal(typeof handlers["stateInfo_bus-upData"], "function");

  const writes = [];
  const warns = [];
  const origSet = global.setPetInfo;
  const origWarn = console.warn;
  global.setPetInfo = (d) => writes.push(d);
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    handlers["stateInfo_bus-upData"](null, {
      info: { yb: 999999999 },
      otherOptions: { sweetHeart: true, pinkDiamond: true },
    });
  } finally {
    global.setPetInfo = origSet;
    console.warn = origWarn;
  }
  assert.equal(writes.length, 1, "合法字段仍应写入");
  assert.deepEqual(writes[0], { otherOptions: { sweetHeart: true } }, "只放行 sweetHeart");
  assert.ok(warns.some((w) => w.includes("[stateInfo] upData")), "拒绝必须留日志");
});

test("stateInfo_bus-upData：openPetFile 分支行为不变", () => {
  const { instance, infoCard } = loadStateInfoMain();
  const handlers = captureHandlers(instance);

  const writes = [];
  const origSet = global.setPetInfo;
  global.setPetInfo = (d) => writes.push(d);
  try {
    handlers["stateInfo_bus-upData"](null, { type: "openPetFile" });
  } finally {
    global.setPetInfo = origSet;
  }
  assert.equal(infoCard.cleateCalls, 1, "资料卡未打开时应走 cleate");
  assert.equal(writes.length, 0, "openPetFile 分支不得写存档");

  infoCard.show = true;
  handlers["stateInfo_bus-upData"](null, { type: "openPetFile" });
  assert.equal(infoCard.doCloseCalls, 1, "资料卡已打开时应走 doClose");
});

test("stateInfo_bus-upData：纯越权 payload 完全不写存档", () => {
  const { instance } = loadStateInfoMain();
  const handlers = captureHandlers(instance);

  const writes = [];
  const origSet = global.setPetInfo;
  global.setPetInfo = (d) => writes.push(d);
  try {
    handlers["stateInfo_bus-upData"](null, { info: { yb: 1, growth: 1 } });
    handlers["stateInfo_bus-upData"](null, undefined);
    handlers["stateInfo_bus-upData"](null, "garbage");
  } finally {
    global.setPetInfo = origSet;
  }
  assert.equal(writes.length, 0);
});
