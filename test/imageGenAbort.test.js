// memory/imageGen.js AbortSignal 回归测试：
//   postBuffer（images/edits 上传）与 downloadBuffer（url 二次下载）都支持 signal，
//   功能关闭/会话结束时能掐断在途生成；已 abort 的 signal 直接拒绝、不发请求。
// 只用 node 内置 http 起本地服务，不依赖 Electron。
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { ImageGenerationClient } = require("../src/service/memory/imageGen.js");

// 最小合法参考图：PNG 魔数 + 填充字节（isSupportedImage 只嗅探魔数）
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.on("clientError", (e, socket) => socket.destroy());
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function makeCfg(port) {
  return {
    providerCfg: {
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "sk-test",
      modelName: "image-model",
    },
    prompt: "今天的日程信息图",
    referenceImages: [FAKE_PNG, FAKE_PNG],
    timeoutMs: 30000,
  };
}

test("上传在途时 abort：postBuffer 被立刻掐断", async () => {
  let responded = false;
  const server = await startServer((req, res) => {
    req.resume();
    // 永不响应，模拟慢/挂死的图像服务
    setTimeout(() => {
      responded = true;
      res.end("{}");
    }, 5000).unref();
  });
  try {
    const controller = new AbortController();
    const client = new ImageGenerationClient();
    const p = client.generate({
      ...makeCfg(server.address().port),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(p, /aborted/);
    assert.strictEqual(responded, false, "应在服务端响应之前被掐断");
  } finally {
    await closeServer(server);
  }
});

test("二次下载在途时 abort：downloadBuffer 被立刻掐断", async () => {
  const server = await startServer((req, res) => {
    if (req.url.startsWith("/images/edits")) {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        const port = server.address().port;
        res.end(
          JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/slow-image` }] })
        );
      });
      return;
    }
    // /slow-image 永不响应
    setTimeout(() => res.end("x"), 5000).unref();
  });
  try {
    const controller = new AbortController();
    const client = new ImageGenerationClient();
    const p = client.generate({
      ...makeCfg(server.address().port),
      signal: controller.signal,
    });
    // 等上传完成、进入下载阶段后再 abort
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(p, /aborted/);
  } finally {
    await closeServer(server);
  }
});

test("已 abort 的 signal：直接拒绝，不发任何请求", async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits += 1;
    req.resume();
    res.end("{}");
  });
  try {
    const controller = new AbortController();
    controller.abort();
    const client = new ImageGenerationClient();
    await assert.rejects(
      client.generate({
        ...makeCfg(server.address().port),
        signal: controller.signal,
      }),
      /aborted/
    );
    assert.strictEqual(hits, 0, "不应向服务端发出请求");
  } finally {
    await closeServer(server);
  }
});

test("不传 signal：正常完成生成（回归）", async () => {
  const png = FAKE_PNG;
  const server = await startServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    });
  });
  try {
    const client = new ImageGenerationClient();
    const r = await client.generate(makeCfg(server.address().port));
    assert.ok(Buffer.isBuffer(r.imageBuffer));
    assert.strictEqual(r.ext, "png");
  } finally {
    await closeServer(server);
  }
});
