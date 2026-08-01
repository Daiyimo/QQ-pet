// memory/imageGen.js buildEndpoint 安全门禁回归测试：
//   图像服务商 baseUrl 若是非回环 http://，Authorization: Bearer <apiKey>、参考图与
//   日记正文会明文出网。门禁必须与 llm/providers.js 的 postJson 对称（回环判定复用
//   providers.isLoopbackHost 这一唯一实现），且拒绝必须发生在任何请求发出之前。
// 只用 node 内置模块，不依赖 Electron。
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");

const { buildEndpoint, ImageGenerationClient } = require("../src/service/memory/imageGen.js");
const providers = require("../src/service/llm/providers.js");

// 最小合法参考图：PNG 魔数 + 填充字节（isSupportedImage 只嗅探魔数）
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

// 把 http/https 的出网入口全部换成计数桩：被调用即视为「Key 已经出网」，
// 直接抛错而不真的建连（避免测试依赖外网）。
function withNetworkTrap(fn) {
  const saved = [
    [http, "request"],
    [http, "get"],
    [https, "request"],
    [https, "get"],
  ].map(([mod, name]) => [mod, name, mod[name]]);
  const calls = [];
  for (const [mod, name] of saved) {
    mod[name] = (...args) => {
      calls.push([name, args[0]]);
      throw new Error("网络请求不应被发起");
    };
  }
  try {
    return fn(calls);
  } finally {
    for (const [mod, name, orig] of saved) mod[name] = orig;
  }
}

function generateWith(baseUrl) {
  return new ImageGenerationClient().generate({
    providerCfg: { baseUrl, apiKey: "sk-secret-should-never-leave", modelName: "image-model" },
    prompt: "今天的日程信息图",
    referenceImages: [FAKE_PNG, FAKE_PNG],
    timeoutMs: 1000,
  });
}

test("非回环 http:// 图像服务商地址被拒绝（API Key 明文出网回归）", () => {
  for (const base of [
    "http://1.2.3.4:8080/v1",
    "http://192.0.2.10/v1",
    "http://images.example.com/v1",
    "http://127.0.0.1.evil.example.com/v1", // 前缀伪装不得绕过
    "http://[2001:db8::1]/v1", // 非回环 IPv6
  ]) {
    assert.throws(
      () => buildEndpoint(base),
      /http:\/\/ 明文协议仅限本机回环地址/,
      `应拒绝非回环 http 地址：${base}`
    );
  }
});

test("非回环 http:// 在发出任何请求之前就被拒绝（Key 未出网）", async () => {
  await withNetworkTrap(async (calls) => {
    await assert.rejects(
      generateWith("http://1.2.3.4:8080/v1"),
      /http:\/\/ 明文协议仅限本机回环地址/
    );
    assert.deepStrictEqual(calls, [], "拒绝前不应调用 http/https 的任何出网入口");
  });
});

test("回环 http:// 地址仍然放行（本地 Ollama / LM Studio 场景）", () => {
  assert.strictEqual(
    buildEndpoint("http://127.0.0.1:11434/v1"),
    "http://127.0.0.1:11434/v1/images/edits"
  );
  assert.strictEqual(
    buildEndpoint("http://127.9.9.9:8080/v1"), // 127.0.0.0/8 整段回环
    "http://127.9.9.9:8080/v1/images/edits"
  );
  assert.strictEqual(
    buildEndpoint("http://localhost:1234/v1"),
    "http://localhost:1234/v1/images/edits"
  );
  assert.strictEqual(
    buildEndpoint("http://[::1]:1234/v1"),
    "http://[::1]:1234/v1/images/edits"
  );
});

test("https:// 任意主机放行，且已带 /images/edits 时不重复拼接", () => {
  assert.strictEqual(
    buildEndpoint("https://api.example.com/v1"),
    "https://api.example.com/v1/images/edits"
  );
  assert.strictEqual(
    buildEndpoint("https://api.example.com/v1/images/edits"),
    "https://api.example.com/v1/images/edits"
  );
});

test("URL 内嵌凭据被拒绝，且在发出任何请求之前（含回环地址）", async () => {
  assert.throws(
    () => buildEndpoint("https://user:pass@api.example.com/v1"),
    /must not contain credentials/
  );
  assert.throws(
    () => buildEndpoint("http://user:pass@127.0.0.1:11434/v1"),
    /must not contain credentials/
  );
  await withNetworkTrap(async (calls) => {
    await assert.rejects(
      generateWith("https://user:pass@api.example.com/v1"),
      /must not contain credentials/
    );
    assert.deepStrictEqual(calls, [], "拒绝前不应调用 http/https 的任何出网入口");
  });
});

test("非 http(s) 协议被拒绝", () => {
  for (const base of ["ftp://example.com/v1", "file:///tmp/v1", "not-a-url", ""]) {
    assert.throws(() => buildEndpoint(base), /absolute HTTP\(S\) URL/, `应拒绝：${base}`);
  }
});

test("回环判定复用 llm/providers.js 的唯一实现（无第二份拷贝）", () => {
  // buildEndpoint 的门禁直接调用 providers.isLoopbackHost：替换该导出后行为随之改变，
  // 证明 imageGen 侧没有另写一份判定逻辑。
  const orig = providers.isLoopbackHost;
  try {
    providers.isLoopbackHost = () => false; // 连 127.0.0.1 也不再算回环
    assert.throws(
      () => buildEndpoint("http://127.0.0.1:11434/v1"),
      /http:\/\/ 明文协议仅限本机回环地址/
    );
  } finally {
    providers.isLoopbackHost = orig;
  }
  assert.strictEqual(
    buildEndpoint("http://127.0.0.1:11434/v1"),
    "http://127.0.0.1:11434/v1/images/edits"
  );
});
