// 回归测试：工具窗模式名称解析必须过白名单
//
// 被修复的缺陷：环境变量 NODE_TOOL 此前完全不过白名单，其值被直接拼进
// require("./src/windows/tool/" + name + "/main.js")。viewSwf 工具窗被删除后，
// NODE_TOOL=viewSwf 会 MODULE_NOT_FOUND 导致桌宠在启动阶段直接崩溃。

const test = require("node:test");
const assert = require("node:assert");

const { resolveToolName, TOOL_WHITELIST } = require("../src/ini/toolResolver.js");

test("环境变量传白名单外的工具名时不进入工具窗模式", () => {
  // viewSwf 已被删除，是这个 bug 的原始触发值
  assert.strictEqual(resolveToolName(["electron", "."], "viewSwf"), null);
  assert.strictEqual(resolveToolName(["electron", "."], "../../../evil"), null);
  assert.strictEqual(resolveToolName(["electron", "."], "doMain"), null);
});

test("环境变量传白名单内的工具名时命中该工具", () => {
  assert.strictEqual(resolveToolName(["electron", "."], "floatStyle"), "floatStyle");
});

test("命令行参数含工具名子串时命中（保留历史传参语义）", () => {
  assert.strictEqual(resolveToolName(["electron", ".", "floatStyle"], undefined), "floatStyle");
  // 历史上是子串匹配而非严格相等，需保持兼容
  assert.strictEqual(resolveToolName(["electron", "--tool=floatStyle"], undefined), "floatStyle");
});

test("命令行命中时优先于环境变量", () => {
  assert.strictEqual(resolveToolName(["electron", "floatStyle"], "viewSwf"), "floatStyle");
});

test("命令行与环境变量均未命中时返回 null（普通桌宠模式）", () => {
  assert.strictEqual(resolveToolName(["electron", "."], undefined), null);
  assert.strictEqual(resolveToolName([], ""), null);
});

test("入参非法时不抛异常并按普通模式处理", () => {
  assert.strictEqual(resolveToolName(undefined, undefined), null);
  assert.strictEqual(resolveToolName(null, null), null);
  assert.strictEqual(resolveToolName("floatStyle", 123), null);
  // argv 里的非字符串项不应导致 indexOf 抛错
  assert.strictEqual(resolveToolName([null, 42, {}], undefined), null);
});

test("白名单为空时任何输入都不进入工具窗模式", () => {
  assert.strictEqual(resolveToolName(["floatStyle"], "floatStyle", []), null);
  assert.strictEqual(resolveToolName(["floatStyle"], "floatStyle", null), null);
});

test("白名单里登记的工具名都能被自身命中（防止白名单与解析逻辑漂移）", () => {
  for (const name of TOOL_WHITELIST) {
    assert.strictEqual(resolveToolName([name], undefined), name);
    assert.strictEqual(resolveToolName([], name), name);
  }
});
