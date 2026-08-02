// 感知结果 → 记忆事件：移植自 orchestrator/service.py 的 _record_memory_activity。
// 门槛：confidence ≥ 0.6、文本清洗（<8 字丢弃、截 240）、同场景 120s 节流、
// 900s 内相似文本去重。相似判定移植 _texts_are_similar（归一化 + SequenceMatcher
// 思路的 ratio + 字符覆盖率）。纯 Node 模块，不依赖 Electron。
//
// 节流状态按场景分槽（this.lastByScene）：早期实现只有单槽 this.last，两道闸门都带
// "与上一次场景相同"的前置条件，于是场景在 game/other 之间交替时（sceneStabilizer 只需
// 连续 2 帧就翻面，看游戏实况视频是典型场景）每次 record 都绕过节流去 store.appendEvent，
// 而 appendEvent 是主进程同步 openSync+writeSync+fsyncSync。真正的代价不是那几次 fsync，
// 而是事件量暴涨 10 倍以上把 store.js 的 EVENTS_MAX_BYTES 轮转窗口从 ~42 天压到几天，
// generateDaily 回补历史天时源数据已被轮转掉 —— 用户的记忆被静默丢失。
const { MemoryStore } = require("./store.js");

// jarvis 默认参数（settings.memory.*）
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MIN_INTERVAL_SECONDS = 120;
const DEFAULT_DUPLICATE_WINDOW_SECONDS = 900;

/* 节流槽位上限。依据：合法场景只有 3 个（sceneStabilizer.js 的 VALID_SCENES =
   game/course/other），正常情况下 Map 最多 3 项。但 record() 的 scene 参数是外部传入的
   字符串（index.js recordActivity ← IPC / 感知结果），理论上可以是任意值，所以留一道
   上限守卫：超出时淘汰"最久没记录过"的槽位，把内存占用钉死在常数级。
   取 8 而不是 3：给未来新增场景留余量，同时远小于任何会构成内存问题的量级。 */
const MAX_THROTTLE_SLOTS = 8;

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
    /** 节流/去重状态，按场景分槽：scene -> {text, recordedAt}。上限 MAX_THROTTLE_SLOTS。 */
    this.lastByScene = new Map();
  }

  /* 记下本场景最近一次落库，并守住槽位上限（淘汰最久未记录的槽）。 */
  _remember(scene, text, recordedAt) {
    this.lastByScene.set(scene, { text, recordedAt });
    if (this.lastByScene.size <= MAX_THROTTLE_SLOTS) return;
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, slot] of this.lastByScene) {
      if (slot.recordedAt < oldestAt) {
        oldestAt = slot.recordedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null && oldestKey !== scene) this.lastByScene.delete(oldestKey);
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
    const prev = this.lastByScene.get(sceneValue);
    if (prev) {
      const elapsed = now - prev.recordedAt;
      /* 时钟回拨（手动改系统时间 / NTP 大步长校正）：clock 默认是墙钟 Date.now()/1000，
         回拨 N 秒后 elapsed 为负。取舍：把负值当作"窗口已过期"放行，而不是改用单调时钟
         （process.hrtime）—— 单调时钟要改构造签名与全部注入点，且记忆事件的时间戳本身就
         是墙钟，两套时基混用反而更难推理。放行的代价是回拨瞬间每个场景最多多写 1 条事件
         （随即被重新计时的闸门接住）；若沉默丢弃，代价是 N 秒的记忆无声消失，重得多。
         警告只会在回拨后每个场景各出现一次（放行时立刻用新的 now 重新计时）。 */
      if (elapsed < 0) {
        console.warn(
          `[memory/activity] 检测到时钟回拨（场景 ${sceneValue} 上次记录在 ${(-elapsed).toFixed(1)}s ` +
            `之后），本次按"节流窗口已过期"放行，避免记忆事件被静默丢弃`
        );
      } else {
        // 同场景 120s 节流
        if (elapsed < this.minIntervalSeconds) return null;
        // 同场景 900s 内相似文本去重
        if (elapsed < this.duplicateWindowSeconds && textsAreSimilar(description, prev.text)) {
          return null;
        }
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
    this._remember(sceneValue, description, now);
    return event;
  }
}

module.exports = {
  MemoryActivityRecorder,
  normalizeText,
  sequenceRatio,
  textsAreSimilar,
  cleanActivityText,
  MAX_THROTTLE_SLOTS,
};
