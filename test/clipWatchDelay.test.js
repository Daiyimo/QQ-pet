// 剪贴板轮询成本回归测试。
//
// 修复的问题：src/windows/main/main.js 以 watchDelay:200 启动 clip.js 的轮询，
// 即每秒 5 次、每小时 18000 次主进程同步 OpenClipboard。除 CPU 外有实际副作用 ——
// Windows 剪贴板是独占资源，高频占用会让其他程序的复制/粘贴间歇失败（Office /
// 远程桌面的经典症状）。且当「实时监听播报剪切板」(sys.clip) 关闭时，clip.js 每个
// tick 都被 isStop("clip") 挡掉、零消费者，定时器纯属白跑。
//
// 覆盖两层：
// 1. clip.js 的真实行为（fake electron.clipboard + node:test mock.timers），断言
//    默认周期、stop() 生效、options.stop 为真时零读取、图片路径便宜预检仍在；
// 2. src/windows/main/main.js（webpack 压缩产物，无法行为测试，理由同
//    test/clipPrivacy.test.js）的接线结构：周期取值区间、按 sys.clip 启停、设置联动。
//
// 变异自证入口：QQ_CLIP_SRC / QQ_MAIN_WIN_SRC 可把被测源码指向临时目录里的回滚版本，
// 约定同 test/storeGetItemThrow.test.js，无需改动仓库里的 src/。
"use strict";

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CLIP_PATH = process.env.QQ_CLIP_SRC
  ? path.resolve(process.env.QQ_CLIP_SRC)
  : path.join(__dirname, "../src/windows/main/clip.js");
const MAIN_WIN_PATH = process.env.QQ_MAIN_WIN_SRC
  ? path.resolve(process.env.QQ_MAIN_WIN_SRC)
  : path.join(__dirname, "../src/windows/main/main.js");

/* ------------------------------------------------------------------ 假 electron */

/** 计数器随每次 makeClipboard 重置；clip.js 在 require 时就解构 clipboard，故对象身份必须稳定。 */
const counters = { readText: 0, readImage: 0, readFormats: 0 };
let textValue = "";
let formatsValue = [];
let imageValue = null;

function makeImage({ empty = false, width = 8, height = 8, png = "a" } = {}) {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    resize: () => ({ toPNG: () => Buffer.from(png) }),
    toDataURL: () => "data:image/png;base64,x",
  };
}

const clipboardStub = {
  readText: () => {
    counters.readText += 1;
    return textValue;
  },
  readImage: () => {
    counters.readImage += 1;
    return imageValue;
  },
  readFormats: () => {
    counters.readFormats += 1;
    return formatsValue;
  },
};

// 拦截 require("electron")：纯 node 下真实的 electron 入口只会返回可执行文件路径字符串。
// 用 Module.prototype.require 而非 require.cache，这样被测源码放在仓库外的临时目录
// （变异自证场景）也能解析到 electron。
const Module = require("node:module");
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "electron") return { clipboard: clipboardStub };
  return origRequire.apply(this, arguments);
};

const clipboardWatcher = require(CLIP_PATH);

function resetClipboard() {
  counters.readText = 0;
  counters.readImage = 0;
  counters.readFormats = 0;
  textValue = "";
  formatsValue = [];
  imageValue = makeImage({ empty: true });
}

/* ------------------------------------------------------------------ 行为层 */

test("clip.js 默认轮询周期为 1000ms —— 999ms 内不发生任何剪贴板读取", (t) => {
  resetClipboard();
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  t.after(() => mock.timers.reset());

  const w = clipboardWatcher({ onTextChange: () => {} });
  t.after(() => w.stop());

  mock.timers.tick(999);
  assert.equal(counters.readText, 0, "999ms 内不应有任何 tick（周期若是 200ms 这里已读 4 次）");

  mock.timers.tick(1);
  assert.equal(counters.readText, 1, "第 1000ms 恰好一个 tick，做一次基线读取");
});

test("clip.js 12 小时的读取次数以 1000ms 周期计（每小时 3600 次，而非 18000 次）", (t) => {
  resetClipboard();
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  t.after(() => mock.timers.reset());

  const w = clipboardWatcher({ onTextChange: () => {} });
  t.after(() => w.stop());

  mock.timers.tick(3600 * 1000);
  assert.equal(counters.readText, 3600, "1 小时应恰好 3600 次 readText");
});

test("stop() 之后定时器不再 tick，剪贴板读取次数冻结", (t) => {
  resetClipboard();
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  t.after(() => mock.timers.reset());

  const w = clipboardWatcher({ onTextChange: () => {} });
  mock.timers.tick(3000);
  const frozen = counters.readText;
  assert.equal(frozen, 3, "stop 前应已 tick 3 次");

  w.stop();
  mock.timers.tick(60 * 1000);
  assert.equal(counters.readText, frozen, "stop() 后不得再有任何读取");
});

test("options.stop 返回真（sys.clip 关闭）时 tick 完全不碰剪贴板", (t) => {
  resetClipboard();
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  t.after(() => mock.timers.reset());

  const seen = [];
  const w = clipboardWatcher({
    stop: (name) => {
      seen.push(name);
      return true;
    },
    onTextChange: () => {},
    onImageChange: () => {},
  });
  t.after(() => w.stop());

  mock.timers.tick(5000);
  assert.equal(seen.length, 5, "5 秒应问过 5 次开关");
  assert.deepEqual([...new Set(seen)], ["clip"], "开关名必须是 clip（对应设置项 sys.clip）");
  assert.equal(counters.readText, 0, "关闭时不应调用 readText");
  assert.equal(counters.readFormats, 0, "关闭时不应调用 readFormats");
  assert.equal(counters.readImage, 0, "关闭时不应调用 readImage");
});

test("图片路径便宜预检：剪贴板不含图片格式且缓存为空时跳过 readImage", (t) => {
  resetClipboard();
  formatsValue = ["text/plain"];
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  t.after(() => mock.timers.reset());

  const w = clipboardWatcher({ onImageChange: () => {} });
  t.after(() => w.stop());

  mock.timers.tick(1000); // 基线 tick：readImage 1 次
  assert.equal(counters.readImage, 1, "基线 tick 应读一次图片");

  mock.timers.tick(5000); // 之后 5 个 tick 都应被预检挡住
  assert.equal(counters.readFormats, 5, "预检本身要跑（readFormats 每 tick 一次）");
  assert.equal(counters.readImage, 1, "预检命中时不得再调用昂贵的 readImage");
});

test("剪贴板出现图片格式时预检放行，onImageChange 被触发", (t) => {
  resetClipboard();
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  t.after(() => mock.timers.reset());

  const got = [];
  const w = clipboardWatcher({ shakeTime: 0, onImageChange: (img) => got.push(img) });
  t.after(() => w.stop());

  mock.timers.tick(1000); // 基线：空图
  formatsValue = ["image/png"];
  imageValue = makeImage({ empty: false });
  mock.timers.tick(1000); // 预检放行 → readImage → 变更
  mock.timers.tick(0); // 跑掉 shakeTime 的 setTimeout
  assert.equal(got.length, 1, "图片变更应恰好回调一次");
});

/* ------------------------------------------------------------------ 接线层（压缩产物结构断言） */

const mainWinSrc = fs.readFileSync(MAIN_WIN_PATH, "utf8");

test("主窗接线的轮询周期落在 800~1000ms 区间，且不再出现硬编码 200", () => {
  const m = mainWinSrc.match(/CLIP_WATCH_DELAY_MS\s*=\s*([0-9.e+]+)/);
  assert.ok(m, "未找到 CLIP_WATCH_DELAY_MS 常量声明 —— 周期必须是命名常量");
  const delay = Number(m[1]);
  assert.ok(
    delay >= 800 && delay <= 1000,
    `轮询周期 ${delay}ms 超出 800~1000ms：更短会让 Windows 独占剪贴板被高频占用`
  );
  assert.match(
    mainWinSrc,
    /watchDelay:CLIP_WATCH_DELAY_MS/,
    "clipboardWatcher 必须用该常量，不得写回字面量"
  );
  assert.doesNotMatch(mainWinSrc, /watchDelay:200\b/, "watchDelay:200 已被证明有害，不得回归");
});

test("剪贴板轮询只在 sys.clip 开启时创建定时器", () => {
  assert.match(
    mainWinSrc,
    /getSys\("clip"\)&&clipWatcherStart\(\)/,
    "初始创建必须由 getSys(\"clip\") 把门 —— 两个开关都关时 watcher 不该跑"
  );
  const startIdx = mainWinSrc.indexOf("clipWatcherStart=()=>{");
  assert.notStrictEqual(startIdx, -1, "未找到 clipWatcherStart 定义");
  const createIdx = mainWinSrc.indexOf("clipboardWatcher({watchDelay:");
  assert.ok(
    createIdx > startIdx && createIdx - startIdx < 200,
    "clipboardWatcher(...) 必须在 clipWatcherStart 内部创建，否则模块加载即无条件起定时器"
  );
});

test("sys.clip 设置变更实时联动启停（与 focusGuard 同一套 system 事件机制）", () => {
  const idx = mainWinSrc.indexOf('name:"main_clipWatcher"');
  assert.notStrictEqual(idx, -1, "缺少 main_clipWatcher 的 system 监听 —— 改设置要等重启才生效");
  const block = mainWinSrc.slice(idx, idx + 400);
  assert.match(block, /"clip"!==e\?\.isCHange\?\.label/, "监听必须只对 clip 这个 label 生效");
  assert.match(block, /clipWatcherStart\?\.\(\)/, "开启时要启动 watcher");
  assert.match(block, /clipWatcherStop\?\.\(\)/, "关闭时要停止 watcher");
});

test("before-quit 的 clipboardWatcherMain 清理路径未被破坏", () => {
  assert.match(
    mainWinSrc,
    /clipboardWatcherMain\?\.stop&&clipboardWatcherMain\.stop\(\)/,
    "退出时仍必须停掉剪贴板轮询（watcher 现在可能为 null，可选链是必需的）"
  );
});
