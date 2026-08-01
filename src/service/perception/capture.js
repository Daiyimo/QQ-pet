// 屏幕截屏封装 + 画面指纹（移植自 pub-local-jarvis native/src/fingerprint.cpp）。
// 指纹/变化检测/闲置监测为纯逻辑（普通 node 可 require）；Electron 依赖惰性加载，
// 只在 captureScreen() 真正被调用时才取 desktopCapturer。
const _require = eval("require");

// —— 纯逻辑：32×18 亮度网格采样（BGRA 内存布局，行距 width*4，无行对齐填充）——
const GRID_W = 32;
const GRID_H = 18;

function sampleLuminance(bitmap, width, height) {
  const samples = new Uint8Array(GRID_W * GRID_H);
  if (!width || !height || !bitmap || !bitmap.length) return samples;
  const rowPitch = width * 4;
  let n = 0;
  for (let gy = 0; gy < GRID_H; gy++) {
    const y = Math.min(Math.floor((gy * height) / GRID_H), height - 1);
    for (let gx = 0; gx < GRID_W; gx++) {
      const x = Math.min(Math.floor((gx * width) / GRID_W), width - 1);
      const at = y * rowPitch + x * 4;
      if (at + 2 >= bitmap.length) {
        samples[n++] = 0;
        continue;
      }
      const b = bitmap[at];
      const g = bitmap[at + 1];
      const r = bitmap[at + 2];
      samples[n++] = (r * 77 + g * 150 + b * 29) >> 8;
    }
  }
  return samples;
}

// FNV-1a 64 位（BigInt 模拟 uint64 溢出），结尾混入宽高
const FNV_OFFSET = 1469598103934665603n;
const FNV_PRIME = 1099511628211n;
const UINT64_MASK = 0xffffffffffffffffn;

function frameFingerprint(bitmap, width, height) {
  let hash = FNV_OFFSET;
  if (!width || !height || !bitmap || !bitmap.length) return hash;
  const rowPitch = width * 4;
  for (let gy = 0; gy < GRID_H; gy++) {
    const y = Math.min(Math.floor((gy * height) / GRID_H), height - 1);
    for (let gx = 0; gx < GRID_W; gx++) {
      const x = Math.min(Math.floor((gx * width) / GRID_W), width - 1);
      const at = y * rowPitch + x * 4;
      if (at + 2 >= bitmap.length) continue;
      const b = bitmap[at];
      const g = bitmap[at + 1];
      const r = bitmap[at + 2];
      hash ^= BigInt((r * 77 + g * 150 + b * 29) >> 8);
      hash = (hash * FNV_PRIME) & UINT64_MASK;
    }
  }
  hash ^= BigInt(width);
  hash = (hash * FNV_PRIME) & UINT64_MASK;
  hash ^= BigInt(height);
  return hash;
}

// 帧变化检测：|Δ|≥18 的采样点占比 ≥0.03，或平均 Δ ≥3.0，视为画面变化。
// 注意：与 C++ 版一致，仅在判定为"变化"时才把当前帧存为基准帧。
class FrameChangeDetector {
  constructor({
    pixelThreshold = 18,
    changedRatioThreshold = 0.03,
    averageDeltaThreshold = 3.0,
  } = {}) {
    this.pixelThreshold = pixelThreshold;
    this.changedRatioThreshold = changedRatioThreshold;
    this.averageDeltaThreshold = averageDeltaThreshold;
    this.previous = null;
  }

  changed(bitmap, width, height) {
    const current = sampleLuminance(bitmap, width, height);
    if (!width || !height || !bitmap || !bitmap.length) return false;
    if (!this.previous || this.previous.length !== current.length) {
      this.previous = current;
      return true;
    }
    let changedSamples = 0;
    let totalDelta = 0;
    for (let i = 0; i < current.length; i++) {
      const delta = Math.abs(current[i] - this.previous[i]);
      totalDelta += delta;
      if (delta >= this.pixelThreshold) changedSamples++;
    }
    const changedRatio = changedSamples / current.length;
    const averageDelta = totalDelta / current.length;
    const result =
      changedRatio >= this.changedRatioThreshold ||
      averageDelta >= this.averageDeltaThreshold;
    if (result) this.previous = current;
    return result;
  }

  reset() {
    this.previous = null;
  }
}

// 屏幕闲置监测（移植 fingerprint.cpp ScreenIdleMonitor）：
// 连续 idleAfterMs 无画面变化 → 'entered-idle'；idle 期间每随机
// [reminderMinMs, reminderMaxMs] 触发一次 'reminder-due'；恢复变化 → 'resumed'。
// 纯逻辑：observe(changed, now) 驱动，rng 可注入便于测试。
class ScreenIdleMonitor {
  constructor({
    idleAfterMs = 2 * 60 * 1000,
    reminderMinMs = 60 * 1000,
    reminderMaxMs = 120 * 1000,
    rng = Math.random,
  } = {}) {
    this.idleAfterMs = Math.max(0, idleAfterMs);
    this.reminderMinMs = Math.max(1000, reminderMinMs);
    this.reminderMaxMs = Math.max(this.reminderMinMs, reminderMaxMs);
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.initialized = false;
    this.idle = false;
    this.lastChange = 0;
    this.nextReminder = 0;
  }

  _nextReminderDelay() {
    const min = Math.floor(this.reminderMinMs);
    const max = Math.floor(this.reminderMaxMs);
    return min + Math.floor(this.rng() * (max - min + 1));
  }

  // 返回值：'none' | 'entered-idle' | 'reminder-due' | 'resumed'
  observe(changed, now = Date.now()) {
    if (!this.initialized) {
      this.initialized = true;
      this.lastChange = now;
      return "none";
    }
    if (changed) {
      this.lastChange = now;
      this.nextReminder = 0;
      if (this.idle) {
        this.idle = false;
        return "resumed";
      }
      return "none";
    }
    if (!this.idle && now - this.lastChange >= this.idleAfterMs) {
      this.idle = true;
      this.nextReminder = now + this._nextReminderDelay();
      return "entered-idle";
    }
    if (this.idle && now >= this.nextReminder) {
      this.nextReminder = now + this._nextReminderDelay();
      return "reminder-due";
    }
    return "none";
  }
}

// —— Electron 截屏（惰性加载，主进程调用）——
// 返回 { pngBuffer, bitmap, width, height }；bitmap 为 BGRA 原始像素，供指纹用。
// pngBuffer 是**惰性 getter**：PNG 编码（1280×720 约 10~30ms CPU）只在真的要把这一帧发给
// 多模态模型时才做。感知循环每 tick 都截屏，但"画面未变 / 上一轮在途 / 未到心跳"的 tick
// 会把这一帧直接丢掉（默认 2000ms 间隔 → 12 小时约 21600 次截屏，其中绝大多数被丢弃），
// 旧实现无条件编码，等于把这笔 CPU 全烧在注定被丢弃的帧上。
// 选 getter 而非 { needPng } 参数的理由：调用方（perception/loop.js 的 frame.pngBuffer、
// aiWiring.js 的课程关键帧 shot.pngBuffer）一行都不用改，也不存在"忘了传 needPng 导致
// pngBuffer 为 undefined"的新坑；结果记忆化，同一帧多次读只编码一次。
async function captureScreen({ maxWidth = 1280 } = {}) {
  const { desktopCapturer, screen } = _require("electron");
  const display = screen.getPrimaryDisplay();
  const scaleFactor = display.scaleFactor || 1;
  const pixelW = Math.round(display.size.width * scaleFactor);
  const pixelH = Math.round(display.size.height * scaleFactor);
  const scale = Math.min(1, maxWidth / pixelW);
  const thumbW = Math.max(1, Math.round(pixelW * scale));
  const thumbH = Math.max(1, Math.round(pixelH * scale));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: thumbW, height: thumbH },
  });
  if (!sources || !sources.length) throw new Error("desktopCapturer 无可用屏幕源");
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  const image = source.thumbnail;
  if (!image || image.isEmpty()) throw new Error("截屏失败：缩略图为空");
  const size = image.getSize();
  let png = null;
  return {
    get pngBuffer() {
      if (png === null) png = image.toPNG(); // 首次读取才编码；nativeImage 由闭包持有
      return png;
    },
    bitmap: image.toBitmap(), // BGRA 预乘像素（每 tick 都要用于变化检测，不做惰性）
    width: size.width,
    height: size.height,
  };
}

module.exports = {
  captureScreen,
  FrameChangeDetector,
  ScreenIdleMonitor,
  sampleLuminance,
  frameFingerprint,
  GRID_W,
  GRID_H,
};
