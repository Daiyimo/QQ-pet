// perception/capture.js 的 captureScreen() 开销回归测试。
// 修复前：每次截屏都无条件 image.toPNG()（1280×720 约 10~30ms CPU），而调用方
// （perception/loop.js）判断"画面未变 / 上一轮在途 / 未到心跳"发生在截屏之后 ——
// 默认 2000ms 间隔、12 小时约 21600 次截屏，绝大多数 PNG 编码结果被直接丢弃。
// 现在 pngBuffer 是惰性 getter：读到才编码，且同一帧只编码一次。
// Electron 通过 Module.prototype.require 注入（capture.js 内部是 eval("require")），
// 与 test/rootListen.test.js 同一套桩法，纯 node 下可跑。
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { captureScreen } = require("../src/service/perception/capture.js");

// 假 nativeImage / desktopCapturer / screen：记录 toPNG / toBitmap 的实际调用次数
function makeElectronStub() {
  const counts = { toPNG: 0, toBitmap: 0 };
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 1280, height: 720 }),
    toPNG() {
      counts.toPNG += 1;
      return Buffer.from("fake-png");
    },
    toBitmap() {
      counts.toBitmap += 1;
      return Buffer.alloc(16);
    },
  };
  const electron = {
    screen: {
      getPrimaryDisplay: () => ({
        id: 1,
        scaleFactor: 1,
        size: { width: 2560, height: 1440 },
      }),
    },
    desktopCapturer: {
      getSources: async () => [{ display_id: "1", thumbnail: image }],
    },
  };
  return { counts, electron };
}

async function withElectron(electron, fn) {
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "electron") return electron;
    return orig.apply(this, arguments);
  };
  try {
    return await fn();
  } finally {
    Module.prototype.require = orig;
  }
}

test("captureScreen 不再无条件做 PNG 编码：不读 pngBuffer 就一次都不编码", async () => {
  const { counts, electron } = makeElectronStub();
  const frame = await withElectron(electron, () => captureScreen({ maxWidth: 1280 }));
  assert.equal(
    counts.toPNG,
    0,
    "截屏本身不得触发 PNG 编码（这是被丢弃 tick 上的纯浪费）"
  );
  assert.equal(counts.toBitmap, 1, "变化检测每次都要用 bitmap，仍应恰好取一次");
  assert.equal(frame.width, 1280);
  assert.equal(frame.height, 720);
});

test("读取 pngBuffer 才编码，且同一帧重复读取只编码一次（结果记忆化）", async () => {
  const { counts, electron } = makeElectronStub();
  const frame = await withElectron(electron, () => captureScreen({ maxWidth: 1280 }));
  const first = frame.pngBuffer;
  assert.equal(counts.toPNG, 1, "首次读取应触发一次编码");
  assert.ok(Buffer.isBuffer(first) && first.toString() === "fake-png");
  const second = frame.pngBuffer;
  assert.equal(counts.toPNG, 1, "同一帧第二次读取不得重复编码");
  assert.equal(second, first, "记忆化应返回同一个 Buffer 实例");
});

test("截屏失败（无屏幕源/空图）仍明确抛错，不返回半成品帧", async () => {
  const { electron } = makeElectronStub();
  electron.desktopCapturer.getSources = async () => [];
  await assert.rejects(
    withElectron(electron, () => captureScreen()),
    /无可用屏幕源/
  );

  const empty = makeElectronStub();
  empty.electron.desktopCapturer.getSources = async () => [
    { display_id: "1", thumbnail: { isEmpty: () => true } },
  ];
  await assert.rejects(
    withElectron(empty.electron, () => captureScreen()),
    /缩略图为空/
  );
  assert.equal(empty.counts.toPNG, 0, "失败路径不该编码");
});
