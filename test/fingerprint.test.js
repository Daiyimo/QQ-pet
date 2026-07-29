// capture.js 纯逻辑单元测试：亮度采样、帧指纹、帧变化检测（BGRA 内存布局）
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sampleLuminance,
  frameFingerprint,
  FrameChangeDetector,
  GRID_W,
  GRID_H,
} = require("../src/service/perception/capture.js");

const WIDTH = 64; // 2 像素/采样点（GRID_W=32）
const HEIGHT = 36; // 2 像素/采样点（GRID_H=18）

// 构造纯色 BGRA 帧（每像素 4 字节：B, G, R, A）
function makeFrame(b, g, r) {
  const buf = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    buf[i * 4] = b;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = r;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

// 采样点 gx,gy 对应的像素坐标
function setSampledPixel(buf, gx, gy, b, g, r) {
  const x = Math.floor((gx * WIDTH) / GRID_W);
  const y = Math.floor((gy * HEIGHT) / GRID_H);
  const at = y * WIDTH * 4 + x * 4;
  buf[at] = b;
  buf[at + 1] = g;
  buf[at + 2] = r;
}

test("sampleLuminance：纯色灰帧采样值均匀", () => {
  const black = sampleLuminance(makeFrame(0, 0, 0), WIDTH, HEIGHT);
  assert.equal(black.length, GRID_W * GRID_H);
  assert.ok(black.every((v) => v === 0));
  const white = sampleLuminance(makeFrame(255, 255, 255), WIDTH, HEIGHT);
  assert.ok(white.every((v) => v === 255));
  const gray = sampleLuminance(makeFrame(128, 128, 128), WIDTH, HEIGHT);
  assert.ok(gray.every((v) => v === 128));
});

test("sampleLuminance：按 BGRA 字节序读取（红色进 R 通道）", () => {
  const buf = makeFrame(0, 0, 0);
  setSampledPixel(buf, 0, 0, 0, 0, 255); // B=0, G=0, R=255
  const samples = sampleLuminance(buf, WIDTH, HEIGHT);
  assert.equal(samples[0], (255 * 77) >> 8); // 76；若按 RGB 误读则为 28
});

test("sampleLuminance：空输入返回全零", () => {
  assert.ok(sampleLuminance(null, WIDTH, HEIGHT).every((v) => v === 0));
  assert.ok(sampleLuminance(makeFrame(9, 9, 9), 0, 0).every((v) => v === 0));
});

test("frameFingerprint：同帧同指纹，异帧异指纹", () => {
  const a = makeFrame(10, 20, 30);
  const b = makeFrame(10, 20, 30);
  const c = makeFrame(10, 20, 31);
  const ha = frameFingerprint(a, WIDTH, HEIGHT);
  assert.equal(typeof ha, "bigint");
  assert.equal(ha, frameFingerprint(b, WIDTH, HEIGHT));
  assert.notEqual(ha, frameFingerprint(c, WIDTH, HEIGHT));
});

test("frameFingerprint：宽高混入指纹", () => {
  const a = makeFrame(10, 20, 30);
  assert.notEqual(
    frameFingerprint(a, WIDTH, HEIGHT),
    frameFingerprint(a, WIDTH, HEIGHT / 2)
  );
});

test("FrameChangeDetector：首帧视为变化，同帧不变", () => {
  const detector = new FrameChangeDetector();
  const frame = makeFrame(50, 50, 50);
  assert.equal(detector.changed(frame, WIDTH, HEIGHT), true); // 首帧
  assert.equal(detector.changed(frame, WIDTH, HEIGHT), false); // 同帧
});

test("FrameChangeDetector：全屏大变化判定为变化", () => {
  const detector = new FrameChangeDetector();
  detector.changed(makeFrame(50, 50, 50), WIDTH, HEIGHT);
  assert.equal(detector.changed(makeFrame(200, 200, 200), WIDTH, HEIGHT), true);
});

test("FrameChangeDetector：局部小变化判定为不变", () => {
  const detector = new FrameChangeDetector();
  const base = makeFrame(100, 100, 100);
  detector.changed(base, WIDTH, HEIGHT);
  const tweaked = Buffer.from(base);
  setSampledPixel(tweaked, 5, 5, 0, 0, 0); // 1/576 个采样点变化
  assert.equal(detector.changed(tweaked, WIDTH, HEIGHT), false);
});

test("FrameChangeDetector：平均 Δ 边界（3.0 变，2.0 不变）", () => {
  const atBoundary = new FrameChangeDetector();
  atBoundary.changed(makeFrame(100, 100, 100), WIDTH, HEIGHT);
  // 全屏亮度 +3 → 平均 Δ 恰为 3.0，达到阈值
  assert.equal(atBoundary.changed(makeFrame(103, 103, 103), WIDTH, HEIGHT), true);

  const belowBoundary = new FrameChangeDetector();
  belowBoundary.changed(makeFrame(100, 100, 100), WIDTH, HEIGHT);
  // 全屏亮度 +2 → 平均 Δ 2.0 < 3.0，且单点 Δ 不足 18
  assert.equal(belowBoundary.changed(makeFrame(102, 102, 102), WIDTH, HEIGHT), false);
});

test("FrameChangeDetector：变化点占比边界（≥3% 变，<3% 不变）", () => {
  const total = GRID_W * GRID_H; // 576
  const make = (changedCount) => {
    const detector = new FrameChangeDetector();
    const base = makeFrame(100, 100, 100);
    detector.changed(base, WIDTH, HEIGHT);
    const tweaked = Buffer.from(base);
    for (let i = 0; i < changedCount; i++) {
      setSampledPixel(tweaked, i % GRID_W, Math.floor(i / GRID_W), 0, 0, 0);
    }
    return detector.changed(tweaked, WIDTH, HEIGHT);
  };
  assert.equal(make(Math.floor(total * 0.03)), false); // 17/576 ≈ 2.95% < 3%
  assert.equal(make(Math.ceil(total * 0.03)), true); // 18/576 ≈ 3.13% ≥ 3%
});

test("FrameChangeDetector：reset 后下一帧重新视为首帧", () => {
  const detector = new FrameChangeDetector();
  const frame = makeFrame(50, 50, 50);
  detector.changed(frame, WIDTH, HEIGHT);
  assert.equal(detector.changed(frame, WIDTH, HEIGHT), false);
  detector.reset();
  assert.equal(detector.changed(frame, WIDTH, HEIGHT), true);
});
