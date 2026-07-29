// 弹幕排序器：质量惩罚、相似去重、2.5s 间隔连发调度。
// 移植自 pub-local-jarvis orchestrator/service.py：
// _normalize_text / _texts_are_similar / _barrage_quality_penalty /
// _barrage_is_available / _rank_barrage_candidates / _emit_barrage_sequence。
// 纯逻辑（定时器/时间源可注入），普通 node 可直接 require。

// Python re.sub(r"[\W_]+", "", text.casefold()) 等价：
// Unicode 下 \w 含字母与数字，去掉其余字符与下划线。
function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// difflib SequenceMatcher.ratio 等价（Ratcliff/Obershelp）：
// ratio = 2 * 匹配字符数 / 总长度；匹配块由最长公共子串递归切分。
function _matchingBlocks(a, b) {
  let matches = 0;
  function recurse(alo, ahi, blo, bhi) {
    let bestLen = 0;
    let bestI = alo;
    let bestJ = blo;
    const width = bhi - blo;
    const prev = new Array(width + 1).fill(0);
    const cur = new Array(width + 1).fill(0);
    for (let i = alo; i < ahi; i++) {
      for (let j = blo; j < bhi; j++) {
        if (a[i] === b[j]) {
          const v = prev[j - blo] + 1;
          cur[j - blo + 1] = v;
          if (v > bestLen) {
            bestLen = v;
            bestI = i - v + 1;
            bestJ = j - v + 1;
          }
        } else {
          cur[j - blo + 1] = 0;
        }
      }
      for (let k = 0; k <= width; k++) {
        prev[k] = cur[k];
        cur[k] = 0;
      }
    }
    if (bestLen === 0) return;
    matches += bestLen;
    if (alo < bestI && blo < bestJ) recurse(alo, bestI, blo, bestJ);
    if (bestI + bestLen < ahi && bestJ + bestLen < bhi) {
      recurse(bestI + bestLen, ahi, bestJ + bestLen, bhi);
    }
  }
  recurse(0, a.length, 0, b.length);
  return matches;
}

function sequenceRatio(a, b) {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * _matchingBlocks(a, b)) / total;
}

// 相似判定：归一化后完全相同，或 ratio≥0.78，
// 或（共享字符覆盖率≥0.9 且长度比≥0.65）。归一化后任一为空 / 短于 4 → 不相似。
function textsAreSimilar(left, right) {
  const l = normalizeText(left);
  const r = normalizeText(right);
  if (!l || !r) return false;
  if (l === r) return true;
  const shorter = Math.min(l.length, r.length);
  if (shorter < 4) return false;
  if (sequenceRatio(l, r) >= 0.78) return true;
  const rCounts = new Map();
  for (const ch of r) rCounts.set(ch, (rCounts.get(ch) || 0) + 1);
  let shared = 0;
  const lCounts = new Map();
  for (const ch of l) lCounts.set(ch, (lCounts.get(ch) || 0) + 1);
  for (const ch of new Set(l)) {
    shared += Math.min(lCounts.get(ch), rCounts.get(ch) || 0);
  }
  const coverage = shared / shorter;
  const lengthRatio = shorter / Math.max(l.length, r.length);
  return coverage >= 0.9 && lengthRatio >= 0.65;
}

// 质量惩罚：提问 +6、不确定 +3、元叙述 +5、过短 +2
const QUESTION_RE = /[？?]|是.{0,10}还是|是不是|难道|莫非/;
const UNCERTAIN_RE = /看起来|似乎|可能|大概|也许|不知道/;
const META_RE = /根据画面|当前画面|画面中|屏幕上/;

function barrageQualityPenalty(text) {
  let penalty = 0;
  if (QUESTION_RE.test(text)) penalty += 6;
  if (UNCERTAIN_RE.test(text)) penalty += 3;
  if (META_RE.test(text)) penalty += 5;
  if (String(text).length < 6) penalty += 2;
  return penalty;
}

// 弹幕发射器：构造接收 emitCallback(text)。
// offerCandidates(list)：评分去重排序后立即发第一条，其余按 intervalMs 连发；
// 完全相同 20s 内禁发、相似 4s 内禁发；cancel() 取消未发序列（切出 game 时调用）。
class BarrageEmitter {
  constructor(
    emitCallback,
    {
      repeatSeconds = 20,
      similarSeconds = 4,
      intervalMs = 2500,
      historySize = 12,
      shouldEmit = null, // 可选门控：返回 false 时中止发射（如已切出 game）
      now = () => Date.now(),
      setTimeoutFn = setTimeout,
      clearTimeoutFn = clearTimeout,
    } = {}
  ) {
    this.emitCallback = typeof emitCallback === "function" ? emitCallback : () => {};
    this.repeatMs = repeatSeconds * 1000;
    this.similarMs = similarSeconds * 1000;
    this.intervalMs = intervalMs;
    this.historySize = historySize;
    this.shouldEmit = shouldEmit;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.recent = []; // [{text, at}]
    this._timer = null;
  }

  _prune(now) {
    const historyMs = Math.max(this.repeatMs, this.similarMs);
    const cutoff = now - historyMs;
    while (this.recent.length && this.recent[0].at < cutoff) this.recent.shift();
  }

  isAvailable(candidate, now = this.now()) {
    const normalized = normalizeText(candidate);
    return !this.recent.some(({ text, at }) => {
      if (normalizeText(text) === normalized && now - at < this.repeatMs) return true;
      if (textsAreSimilar(candidate, text) && now - at < this.similarMs) return true;
      return false;
    });
  }

  // 评分排序 + 与历史/同批去重，返回有序可用候选
  rank(candidates, now = this.now()) {
    this._prune(now);
    const ranked = [];
    (Array.isArray(candidates) ? candidates : []).forEach((candidate, index) => {
      candidate = String(candidate || "").trim();
      if (!candidate || !this.isAvailable(candidate, now)) return;
      const normalized = normalizeText(candidate);
      let recentSimilarity = 0;
      for (const { text } of this.recent) {
        recentSimilarity = Math.max(
          recentSimilarity,
          sequenceRatio(normalized, normalizeText(text))
        );
      }
      ranked.push({
        penalty: barrageQualityPenalty(candidate),
        recentSimilarity,
        index,
        candidate,
      });
    });
    ranked.sort(
      (a, b) =>
        a.penalty - b.penalty ||
        a.recentSimilarity - b.recentSimilarity ||
        a.index - b.index
    );
    const selected = [];
    for (const { candidate } of ranked) {
      if (selected.some((prev) => textsAreSimilar(candidate, prev))) continue;
      selected.push(candidate);
    }
    return selected;
  }

  _emit(text) {
    const now = this.now();
    this._prune(now);
    if (!this.isAvailable(text, now)) return false;
    this.recent.push({ text, at: now });
    if (this.recent.length > this.historySize) this.recent.shift();
    try {
      this.emitCallback(text);
    } catch (e) {}
    return true;
  }

  offerCandidates(candidates) {
    this.cancel();
    const ranked = this.rank(candidates);
    if (!ranked.length) return;
    if (this.shouldEmit && !this.shouldEmit()) return;
    if (!this._emit(ranked[0])) return;
    const rest = ranked.slice(1);
    if (!rest.length) return;
    const step = () => {
      if (this.shouldEmit && !this.shouldEmit()) {
        this._timer = null;
        return;
      }
      const next = rest.shift();
      if (next === undefined) {
        this._timer = null;
        return;
      }
      this._emit(next);
      this._timer = rest.length
        ? this.setTimeoutFn(step, this.intervalMs)
        : null;
    };
    this._timer = this.setTimeoutFn(step, this.intervalMs);
  }

  cancel() {
    if (this._timer !== null) {
      this.clearTimeoutFn(this._timer);
      this._timer = null;
    }
  }
}

module.exports = {
  BarrageEmitter,
  normalizeText,
  sequenceRatio,
  textsAreSimilar,
  barrageQualityPenalty,
};
