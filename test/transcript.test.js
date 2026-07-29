// transcript.js 单元测试：转写增量、分块、课程文本清洗、互动代餐
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  transcriptDelta,
  cleanCourseNote,
  cleanCourseInteraction,
  noteInteractionFallback,
  splitTranscript,
} = require("../src/service/courses/transcript.js");

test("transcriptDelta：后缀-前缀重叠时只返回新增部分", () => {
  const previous = "今天我们讲微积分的基本概念";
  const current = "今天我们讲微积分的基本概念和导数定义";
  assert.equal(transcriptDelta(previous, current), "和导数定义");
});

test("transcriptDelta：新增段开头的标点被剥掉", () => {
  const previous = "第一章讲完了";
  const current = "第一章讲完了。接下来讲第二章";
  assert.equal(transcriptDelta(previous, current), "接下来讲第二章");
});

test("transcriptDelta：重叠下限 4 字，3 字重叠不算", () => {
  // "cdef" 4 字重叠 → 返回新增 "XY"
  assert.equal(transcriptDelta("abcdef", "cdefXY"), "XY");
  // 只有 "cde" 3 字重叠 → 低于下限，整段视为新增
  assert.equal(transcriptDelta("abcde", "cdeXY"), "cdeXY");
});

test("transcriptDelta：无重叠时返回全文", () => {
  assert.equal(transcriptDelta("前面讲的内容", "完全不同的新话题"), "完全不同的新话题");
});

test("transcriptDelta：包含关系或相同返回空", () => {
  assert.equal(transcriptDelta("整段转写内容", "转写内容"), ""); // current 被 previous 包含
  assert.equal(transcriptDelta("同样的内容", "同样的内容"), "");
  assert.equal(transcriptDelta("任意", ""), "");
});

test("splitTranscript：按行聚合且每块不超过 limit", () => {
  const text = "aaaa\nbbbb\ncccc";
  const chunks = splitTranscript(text, 10);
  // "aaaa\nbbbb" 9 字符，再加一行 14 > 10 → 开新块
  assert.deepEqual(chunks, ["aaaa\nbbbb", "cccc"]);
  for (const chunk of chunks) assert.ok(chunk.length <= 10);
});

test("splitTranscript：绝不拆行，超长行独占一块", () => {
  const longLine = "这一行有二十五个字符长度超过了限制但是不能被拆开";
  const chunks = splitTranscript(`头一行\n${longLine}\n尾一行`, 10);
  assert.ok(chunks.includes(longLine));
  assert.equal(chunks.filter((c) => c === longLine).length, 1);
});

test("splitTranscript：跳过空行，空文本返回空数组", () => {
  assert.deepEqual(splitTranscript("a\n\n  \nb", 100), ["a\nb"]);
  assert.deepEqual(splitTranscript(""), []);
});

test("cleanCourseNote：去掉列表前缀，正常内容保留", () => {
  assert.equal(cleanCourseNote("- 关键知识点：导数的定义"), "关键知识点：导数的定义");
});

test("cleanCourseNote：过程性记录被丢弃", () => {
  assert.equal(cleanCourseNote("正在查看桌面的文件列表"), "");
  assert.equal(cleanCourseNote("当前屏幕显示一个视频播放器窗口"), "");
});

test("cleanCourseInteraction：过短、泛泛鼓励与讲师过程评论被丢弃", () => {
  assert.equal(cleanCourseInteraction("太短了"), ""); // <8 字
  assert.equal(cleanCourseInteraction("这课很枯燥但是大家忍一忍"), ""); // 泛泛鼓励词
  assert.equal(cleanCourseInteraction("大家要认真听讲别掉队"), ""); // 含"认真听"
  assert.equal(cleanCourseInteraction("讲师正在演示下一步操作"), ""); // 过程评论
});

test("cleanCourseInteraction：有具体内容的互动保留并截 100 字", () => {
  const ok = "注意这里的边界条件容易出错";
  assert.equal(cleanCourseInteraction(ok), ok);
  const long = "具".repeat(150);
  assert.equal(cleanCourseInteraction(long).length, 100);
});

test("noteInteractionFallback：取首条 ≥10 字的句子并补句号", () => {
  const note = "短句。这个句子长度超过十个字符没问题。另一句。";
  assert.equal(noteInteractionFallback(note), "这个句子长度超过十个字符没问题。");
});

test("noteInteractionFallback：没有合格句子或笔记被清洗丢弃时返回空", () => {
  assert.equal(noteInteractionFallback("短。也短。"), "");
  assert.equal(noteInteractionFallback("正在查看当前界面"), ""); // 过程性笔记被丢弃
});

test("noteInteractionFallback：超长句子截 80 字", () => {
  const long = "知".repeat(100);
  const result = noteInteractionFallback(long);
  assert.equal(result, "知".repeat(80) + "。");
});
