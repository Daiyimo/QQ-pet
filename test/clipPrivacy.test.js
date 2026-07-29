"use strict";

/**
 * 剪贴板隐私契约的防回归测试。
 *
 * 为什么用源码结构断言而不是行为测试：
 * 剪贴板上云逻辑位于 src/windows/main/main.js 与 src/ini/pet.js，二者都是 webpack
 * 压缩单行文件且强依赖 Electron 运行时（BrowserWindow / clipboard / getSys 全局），
 * 要行为测试需要 mock 4 层以上，按项目测试哲学属「不值得测试」。
 * 但「复制的文字默认不上传云端」是隐私底线，且压缩文件极易在后续改动中被误伤，
 * 因此退一步用结构断言守住契约：只要门禁被摘掉或默认值被改回，测试立刻红。
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/** 读取项目内源码文件的原文。 */
function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

test("剪贴板上云开关默认关闭", () => {
  const petSrc = readSource("src/ini/pet.js");
  assert.match(
    petSrc,
    /clipToCloud:!1/,
    "src/ini/pet.js 的默认 system 必须含 clipToCloud:!1 —— 上云需用户显式开启"
  );
});

test("剪贴板内容发往云端前必须通过 clipToCloud 门禁", () => {
  const mainSrc = readSource("src/windows/main/main.js");

  // 定位 clipboardText 这一次 LLM 调用（唯一把剪贴板原文送出网的地方）
  const callIdx = mainSrc.indexOf('generateOnce("clipboardText"');
  assert.notStrictEqual(callIdx, -1, "未找到 clipboardText 的 LLM 调用点，测试需随实现更新");

  // 门禁必须出现在调用点之前，且距离足够近（同一 if 块内）
  const guardIdx = mainSrc.lastIndexOf('getSys("clipToCloud")', callIdx);
  assert.notStrictEqual(
    guardIdx,
    -1,
    "clipboardText 上云调用前缺少 getSys(\"clipToCloud\") 门禁 —— 剪贴板内容会无条件上传"
  );
  assert.ok(
    callIdx - guardIdx < 500,
    "clipToCloud 门禁与上云调用相距过远，可能已不在同一条件分支内"
  );
});

test("剪贴板监听本身保持默认开启（本地播报不出网，不应被隐私修复误伤）", () => {
  const petSrc = readSource("src/ini/pet.js");
  assert.match(
    petSrc,
    /e\.system=\{clip:!0,/,
    "clip 控制的是本地剪贴板播报（不出网），应保持默认开启"
  );
});

test("LLM 功能门禁不再依赖已废弃的明文 llmApiKey 键", () => {
  const mainSrc = readSource("src/windows/main/main.js");
  assert.doesNotMatch(
    mainSrc,
    /getSys\("llmApiKey"\)/,
    "明文 llmApiKey 已被迁移清空，用它做门禁会导致 LLM 台词静默退化为固定文案"
  );
});
