"use strict";

/**
 * 剪贴板隐私契约的防回归测试。
 *
 * 契约（README 明确承诺）：clipToCloud 关闭时剪贴板播报仍可用，只是不出网。
 *
 * 两种手法各管一段：
 * 1. 门禁本身用**行为测试** —— 从 src/windows/main/main.js（webpack 压缩产物）里抽出
 *    clipboardWatcher 的 onTextChange 回调并注入桩后真的执行，直接验证「开关关闭时
 *    llmService.generateOnce 零调用」。旧版本只比较 getSys("clipToCloud") 与
 *    generateOnce("clipboardText") 在源码里的下标距离，把门禁写成 if(!getSys(...))
 *    也照样绿 —— 那是一条活的假绿。
 * 2. 默认值与「唯一出网点」用源码断言 —— 默认值在 src/ini/pet.js 的压缩产物里，
 *    调用点唯一性是全局性质，都不适合执行。
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

/**
 * 从 main.js 压缩产物里抽出剪贴板文本回调（clipboardWatcher 的 onTextChange）并变成可执行函数。
 *
 * 为什么能执行：这个回调对外部只有 5 个自由标识符（openSpeak / getSys / llmService /
 * getPetInfo / LLM_MAX_CLIPBOARD_LEN），全部可以当形参注入，不需要 Electron 运行时。
 * 于是隐私门禁可以做**真实行为断言**（关掉开关时到底有没有出网），而不是比较两个
 * 字符串在源码里的下标距离 —— 后者对极性反转完全无感。
 *
 * 定位只依赖 `onTextChange:` / `,onImageChange:` 这两个结构锚点：同一文件里其它无关
 * 改动（新增 IPC、改台词、改别的 watcher）都不会影响抽取，而剪贴板上云逻辑本身被动
 * 一下就会被行为断言逮住。
 */
function loadClipTextHandler(deps) {
  const mainSrc = readSource("src/windows/main/main.js");
  const head = "onTextChange:";
  const start = mainSrc.indexOf(head);
  assert.notStrictEqual(start, -1, "未找到 clipboardWatcher 的 onTextChange 回调，测试需随实现更新");
  const end = mainSrc.indexOf(",onImageChange:", start);
  assert.notStrictEqual(end, -1, "未找到 onTextChange 的结束锚点 onImageChange");
  const body = mainSrc.slice(start + head.length, end);

  // 门禁应当只在这个回调里出现一次；出现 0 次说明被摘掉，多次说明有分叉路径需重新审计
  assert.strictEqual(
    body.split('getSys("clipToCloud")').length - 1,
    1,
    'onTextChange 内应恰好有一处 getSys("clipToCloud") 门禁'
  );

  const factory = new Function(
    "openSpeak",
    "getSys",
    "llmService",
    "getPetInfo",
    "LLM_MAX_CLIPBOARD_LEN",
    "return (" + body + ")"
  );
  return factory(
    deps.openSpeak,
    deps.getSys,
    deps.llmService,
    deps.getPetInfo,
    deps.LLM_MAX_CLIPBOARD_LEN
  );
}

/** 造一套桩，记录「本地播报」与「出网调用」两条路各被走了几次。 */
function makeClipHarness(sys) {
  const spoken = [];
  const sent = [];
  const handler = loadClipTextHandler({
    openSpeak: (arg) => spoken.push(arg),
    getSys: (key) => sys[key],
    llmService: {
      generateOnce: (...args) => {
        sent.push(args);
        return Promise.resolve({ tolk: "云端台词", submitText: "嗯" });
      },
    },
    getPetInfo: () => ({ info: {} }),
    LLM_MAX_CLIPBOARD_LEN: 100,
  });
  return { handler, spoken, sent };
}

const LLM_ON = { llmEnabled: true, llmActiveProvider: "openai" };

test("clipToCloud 关闭时剪贴板原文绝不出网，但本地播报照常", async () => {
  const h = makeClipHarness({ ...LLM_ON, clipToCloud: false });
  h.handler("这是我复制的一段私密文字");
  await Promise.resolve();
  assert.strictEqual(
    h.sent.length,
    0,
    "clipToCloud 关闭时不允许有任何 LLM 调用 —— 剪贴板原文出网违反 README 的隐私承诺"
  );
  assert.strictEqual(h.spoken.length, 1, "关掉上云后本地播报必须仍然可用（README 明确承诺）");
  assert.strictEqual(h.spoken[0].data.data, "这是我复制的一段私密文字");
  assert.strictEqual(h.spoken[0].data.form, "clip");
});

test("clipToCloud 开启且 LLM 就绪时才把剪贴板文本交给云端，且只交一次", async () => {
  const h = makeClipHarness({ ...LLM_ON, clipToCloud: true });
  h.handler("hello");
  assert.strictEqual(h.sent.length, 1, "应恰好一次上云调用");
  assert.strictEqual(h.sent[0][0], "clipboardText");
  assert.strictEqual(h.sent[0][1], "hello");
  assert.strictEqual(h.spoken.length, 0, "上云路径不应同时走本地兜底（否则会说两遍）");
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(h.spoken.length, 1, "云端返回后由 openSpeak 播报");
  assert.strictEqual(h.spoken[0].data.data, "云端台词");
});

test("clipToCloud 开启但 LLM 未启用/无 provider 时同样不出网", async () => {
  for (const sys of [
    { llmEnabled: false, llmActiveProvider: "openai", clipToCloud: true },
    { llmEnabled: true, llmActiveProvider: "", clipToCloud: true },
  ]) {
    const h = makeClipHarness(sys);
    h.handler("hello");
    await Promise.resolve();
    assert.strictEqual(h.sent.length, 0, "LLM 未就绪时不应有网络调用");
    assert.strictEqual(h.spoken.length, 1, "仍要本地播报");
  }
});

test("clipToCloud 未设置（undefined，如老配置文件）时按关闭处理", async () => {
  const h = makeClipHarness({ ...LLM_ON });
  h.handler("hello");
  await Promise.resolve();
  assert.strictEqual(h.sent.length, 0, "缺失即视为未开启，不得默认上云");
  assert.strictEqual(h.spoken.length, 1);
});

test("整个主进程里只有一处把剪贴板原文送去 LLM", () => {
  // 堵「门禁对了但别处又补了一条无门禁通路」的伪修复（手法同 activeRecheck.test.js）
  const mainSrc = readSource("src/windows/main/main.js");
  assert.strictEqual(
    mainSrc.split('generateOnce("clipboardText"').length - 1,
    1,
    'generateOnce("clipboardText") 应只存在于 onTextChange 的门禁分支内'
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
