// 感知结果 → 记忆事件：移植自 orchestrator/service.py 的 _record_memory_activity。
// 门槛：confidence ≥ 0.6、文本清洗（<8 字丢弃、截 240）、同场景 120s 节流、
// 900s 内相似文本去重。相似判定移植 _texts_are_similar（归一化 + SequenceMatcher
// 思路的 ratio + 字符覆盖率）。纯 Node 模块，不依赖 Electron。
const { MemoryStore } = require("./store.js");

// jarvis 默认参数（settings.memory.*）
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MIN_INTERVAL_SECONDS = 120;
const DEFAULT_DUPLICATE_WINDOW_SECONDS = 900;

// _normalize_text：小写后去掉所有非字母数字字符（Python [\W_]+ 的 JS 等价）
function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// SequenceMatcher.ratio() 的极简移植：Ratcliff-Obershelp 递归最长匹配块，
// ratio = 2*M / (len(a)+len(b))。文本 ≤240 字，递归足够快。
function longestMatchLength(a, b) {
  let best = 0;
  let bestI = 0;
  let bestJ = 0;
  // 以 a 的每个起点扫 b 的每个起点，找最长公共子串（起始于 i/j）
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) {
        best = k;
        bestI = i;
        bestJ = j;
      }
    }
  }
  if (best === 0) return 0;
  return (
    best +
    longestMatchLength(a.slice(0, bestI), b.slice(0, bestJ)) +
    longestMatchLength(a.slice(bestI + best), b.slice(bestJ + best))
  );
}

function sequenceRatio(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  return (2 * longestMatchLength(a, b)) / (a.length + b.length);
}

// _texts_are_similar：完全相同即相似；短文本（<4）不判相似；
// ratio ≥ 0.78，或（字符覆盖率 ≥ 0.9 且长度比 ≥ 0.65）
function textsAreSimilar(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  const ratio = sequenceRatio(a, b);
  // 共享字符数：对 a 的字符集合，取两侧计数的最小值求和
  const bCounts = new Map();
  for (const ch of b) bCounts.set(ch, (bCounts.get(ch) || 0) + 1);
  const aCounts = new Map();
  for (const ch of a) aCounts.set(ch, (aCounts.get(ch) || 0) + 1);
  let shared = 0;
  for (const [ch, count] of aCounts) {
    shared += Math.min(count, bCounts.get(ch) || 0);
  }
  const coverage = shared / shorter;
  const lengthRatio = shorter / Math.max(a.length, b.length);
  return ratio >= 0.78 || (coverage >= 0.9 && lengthRatio >= 0.65);
}

// _clean_memory_activity：压缩空白；<8 字或含"不确定"标记则丢弃；截 240 字
const UNCERTAIN_MARKERS = ["无法判断", "无法识别", "看不清", "没有足够信息", "no clear activity"];
function cleanActivityText(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  const folded = cleaned.toLowerCase();
  if (cleaned.length < 8 || UNCERTAIN_MARKERS.some((m) => folded.includes(m))) {
    return "";
  }
  return cleaned.slice(0, 240);
}

class MemoryActivityRecorder {
  constructor({ store, minConfidence, minIntervalSeconds, duplicateWindowSeconds, clock } = {}) {
    this.store = store || new MemoryStore();
    this.minConfidence = minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.minIntervalSeconds = minIntervalSeconds ?? DEFAULT_MIN_INTERVAL_SECONDS;
    this.duplicateWindowSeconds = duplicateWindowSeconds ?? DEFAULT_DUPLICATE_WINDOW_SECONDS;
    this.clock = clock || (() => Date.now() / 1000); // 秒，便于单测注入
    this.last = null; // {scene, text, recordedAt}
  }

  // 感知一轮结果落记忆。返回事件对象；被任何门槛拦截时返回 null。
  record({ scene, confidence, text, courseTitle, timestamp }) {
    const conf = Number(confidence) || 0;
    if (conf < this.minConfidence) return null;
    const sceneValue = String(scene || "other");
    let description = cleanActivityText(text);
    // course 场景 observation 为空时，用课程标题兜底
    if (!description && sceneValue === "course") {
      const title = cleanActivityText(courseTitle);
      description = title ? `正在学习课程：${title}` : "";
    }
    if (!description) return null;

    const now = this.clock();
    if (this.last) {
      const elapsed = now - this.last.recordedAt;
      // 同场景 120s 节流
      if (sceneValue === this.last.scene && elapsed < this.minIntervalSeconds) {
        return null;
      }
      // 同场景 900s 内相似文本去重
      if (
        sceneValue === this.last.scene &&
        elapsed < this.duplicateWindowSeconds &&
        textsAreSimilar(description, this.last.text)
      ) {
        return null;
      }
    }

    const event = this.store.appendEvent({
      kind: "activity",
      text: description,
      timestamp: timestamp || new Date().toISOString(),
      metadata: {
        scene: sceneValue,
        confidence: Math.round(conf * 1000) / 1000,
        source: "perception",
      },
    });
    this.last = { scene: sceneValue, text: description, recordedAt: now };
    return event;
  }
}

module.exports = {
  MemoryActivityRecorder,
  normalizeText,
  sequenceRatio,
  textsAreSimilar,
  cleanActivityText,
};
