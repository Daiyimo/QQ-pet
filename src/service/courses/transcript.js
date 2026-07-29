// 课程记录纯函数集：转写增量提取、文本清洗、转写分块。
// 逐行移植 jarvis orchestrator/service.py 的
// _transcript_delta / _clean_course_transcript / _clean_course_note /
// _clean_course_interaction / _course_note_interaction / _split_transcript。
// 不依赖 Electron，普通 node 可直接 require（便于单元测试）。

// 转写增量：current 相对 previous 的新增部分。
// 模型每轮返回的是全量转写，通过"previous 后缀 = current 前缀"的最大重叠
// （重叠下限 4 字符）定位新增段；无重叠时整段视为新增。
function transcriptDelta(previous, current) {
  previous = String(previous || "");
  current = String(current || "");
  if (!current || current === previous || previous.includes(current)) return "";
  const maxOverlap = Math.min(previous.length, current.length);
  for (let size = maxOverlap; size > 3; size--) {
    if (previous.endsWith(current.slice(0, size))) {
      return current.slice(size).replace(/^[ ，。！？；：,.!?;:]+/, "");
    }
  }
  return current;
}

// 授课转写清洗：压缩空白，截 2000 字符
function cleanCourseTranscript(transcript) {
  return String(transcript || "").replace(/\s+/g, " ").trim().slice(0, 2000);
}

// 课程笔记清洗：丢弃只描述"正在看什么界面"的过程性记录
const NOTE_PROCESS_MARKERS = [
  "metadata:",
  "electron-desktop",
  "正在查看",
  "当前界面",
  "界面显示",
  "当前屏幕",
  "屏幕显示",
  "文件夹",
  "文件列表",
  "用户可能",
  "视频播放器",
  "老师在黑板",
  "教师在黑板",
  "i can see",
  "the screen shows",
  "currently viewing",
];

function cleanCourseNote(note) {
  let cleaned = String(note || "").replace(/\s+/g, " ").trim();
  if (cleaned.startsWith("- ")) cleaned = cleaned.slice(2);
  const lowered = cleaned.toLowerCase();
  for (const marker of NOTE_PROCESS_MARKERS) {
    if (lowered.includes(marker)) return "";
  }
  return cleaned.slice(0, 2000);
}

// 课程互动气泡清洗：丢弃过短、泛泛鼓励词、讲师过程评论
const INTERACTION_GENERIC_MARKERS = [
  "这课很枯燥",
  "课程很枯燥",
  "内容很枯燥",
  "基础很重要",
  "内容很重要",
  "知识很重要",
  "认真听",
  "坚持一下",
  "继续坚持",
  "加油",
  "慢慢来",
  "别走神",
  "不要走神",
  "打好基础",
  "老师讲得",
];

const INTERACTION_PROCESS_RE =
  /(?:主讲人|讲师|老师).{0,10}(?:提到|提醒|正在)|课程(?:内容|结构|安排|版本)|干货|拓展内容|做好笔记/;

function cleanCourseInteraction(message) {
  const cleaned = String(message || "").replace(/\s+/g, " ").trim();
  if (
    cleaned.length < 8 ||
    INTERACTION_PROCESS_RE.test(cleaned) ||
    INTERACTION_GENERIC_MARKERS.some((m) => cleaned.includes(m))
  ) {
    return "";
  }
  return cleaned.slice(0, 100);
}

// 互动代餐：模型没给 course_interaction 时，取笔记里首条 ≥10 字的句子截 80 字
function noteInteractionFallback(note) {
  const cleaned = cleanCourseNote(note);
  if (!cleaned) return "";
  const sentences = cleaned
    .split(/[。！？；\n]+/)
    .map((s) => s.replace(/^[ ，。！？；：,.!?;:]+|[ ，。！？；：,.!?;:]+$/g, ""))
    .filter(Boolean);
  const candidate = sentences.find((s) => s.length >= 10) || "";
  return candidate ? candidate.slice(0, 80) + "。" : "";
}

// 转写分块：按行聚合，每块 ≤ limit 字符，绝不拆行
function splitTranscript(text, limit = 3200) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (current.length && length + line.length + 1 > limit) {
      chunks.push(current.join("\n"));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

module.exports = {
  transcriptDelta,
  cleanCourseTranscript,
  cleanCourseNote,
  cleanCourseInteraction,
  noteInteractionFallback,
  splitTranscript,
};
