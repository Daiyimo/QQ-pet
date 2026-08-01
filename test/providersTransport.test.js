// providers 传输层回归测试：URL scheme 分流、响应体上限、AbortSignal、UTF-8 分块。
// 只用 node 内置 http 起本地服务，不 require 任何三方包、不需要 Electron。
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const providers = require("../src/service/llm/providers.js");

// 起一个本地 http 服务；handler(req,res) 由各用例决定
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    // 客户端主动 destroy 时服务端会收到 ECONNRESET/EPIPE，记录下来避免未处理的 error 事件
    server.on("clientError", (e, socket) => socket.destroy());
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function cfg(port, extra = {}) {
  return {
    id: "local",
    type: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test",
    model: "test-model",
    ...extra,
  };
}

test("baseUrl 为 http 时走 http 而不是恒用 https（本地端点可用）", async () => {
  let sawPath = null;
  let sawAuth = null;
  const server = await startServer((req, res) => {
    sawPath = req.url;
    sawAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "本地模型回复" } }] }));
  });
  try {
    const port = server.address().port;
    const text = await providers.chat({
      providerCfg: cfg(port),
      messages: [{ role: "user", content: "你好" }],
      timeoutMs: 5000,
    });
    assert.strictEqual(text, "本地模型回复");
    assert.strictEqual(sawPath, "/v1/chat/completions");
    assert.strictEqual(sawAuth, "Bearer sk-test");
  } finally {
    await closeServer(server);
  }
});

test("响应分块切在多字节字符中间时不产生乱码", async () => {
  const payload = Buffer.from(
    JSON.stringify({ choices: [{ message: { content: "主人今天也要好好休息哦" } }] }),
    "utf8"
  );
  // 找一个落在汉字内部的切点：该字节自身不是 UTF-8 字符起始字节
  let cut = Math.floor(payload.length / 2);
  while (cut < payload.length - 1 && (payload[cut] & 0xc0) !== 0x80) cut += 1;
  assert.ok((payload[cut] & 0xc0) === 0x80, "切点应位于某个多字节字符内部");

  const server = await startServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.write(payload.subarray(0, cut));
    // 延迟写出后半段，确保客户端收到两个独立的 data 事件
    setTimeout(() => res.end(payload.subarray(cut)), 30);
  });
  try {
    const text = await providers.chat({
      providerCfg: cfg(server.address().port),
      messages: [{ role: "user", content: "你好" }],
      timeoutMs: 5000,
    });
    assert.strictEqual(text, "主人今天也要好好休息哦");
  } finally {
    await closeServer(server);
  }
});

test("响应体超过上限时中断请求并报错，不无限吃内存", async () => {
  // 锁住导出的上限常量：改动它会让本测试提醒（也让这个导出真的有消费者）
  assert.strictEqual(
    providers.MAX_RESPONSE_BYTES,
    2 * 1024 * 1024,
    "响应体上限应为 2 MiB"
  );
  const cap = providers.MAX_RESPONSE_BYTES;
  const chunkSize = 256 * 1024;
  const chunk = "x".repeat(chunkSize);
  const budget = cap * 8; // 服务端最多愿意吐 8 倍上限
  let written = 0;
  const server = await startServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const pump = () => {
      // 一直吐数据（模拟配置错误/被劫持的端点）；客户端断开后停下
      while (written < budget) {
        written += chunkSize;
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    res.on("error", () => {}); // 客户端主动断开导致的 EPIPE 属预期，不需处理
    pump();
  });
  try {
    await assert.rejects(
      providers.chat({
        providerCfg: cfg(server.address().port),
        messages: [{ role: "user", content: "你好" }],
        timeoutMs: 15000,
      }),
      new RegExp(`超过 ${cap} 字节上限`)
    );
    assert.ok(
      written < budget,
      `应在读满上限后立即中断，实际服务端把 ${budget} 字节预算全写完了`
    );
  } finally {
    await closeServer(server);
  }
});

test("AbortSignal 触发时在途请求被立刻中断", async () => {
  let responded = false;
  const server = await startServer((req, res) => {
    // 永不响应，模拟慢/挂死的云端
    setTimeout(() => {
      responded = true;
      res.end("{}");
    }, 5000).unref();
  });
  try {
    const controller = new AbortController();
    const p = providers.chat({
      providerCfg: cfg(server.address().port),
      messages: [{ role: "user", content: "你好" }],
      timeoutMs: 30000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(p, /aborted/);
    assert.strictEqual(responded, false, "应在服务端响应之前就被中断");
  } finally {
    await closeServer(server);
  }
});

test("已 abort 的 signal 传入时直接失败，不再发起请求", async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits += 1;
    res.end("{}");
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      providers.chat({
        providerCfg: cfg(server.address().port),
        messages: [{ role: "user", content: "你好" }],
        signal: controller.signal,
      }),
      /aborted/
    );
    assert.strictEqual(hits, 0, "不应向服务端发出请求");
  } finally {
    await closeServer(server);
  }
});

test("非 http/https 的 API 地址被明确拒绝而不是报 OpenSSL 天书", async () => {
  await assert.rejects(
    providers.chat({
      providerCfg: {
        id: "bad",
        type: "openai",
        baseUrl: "ftp://example.com/v1",
        apiKey: "sk-test",
        model: "m",
      },
      messages: [{ role: "user", content: "你好" }],
    }),
    /协议不支持/
  );
});

// —— http:// 明文协议仅限回环地址（本地 ollama 可用，非回环 http 拒绝）——
test("isLoopbackHost：127.0.0.0/8、localhost、[::1] 放行，其余拒绝", () => {
  for (const h of ["127.0.0.1", "127.0.1.2", "127.255.255.254", "localhost", "[::1]"]) {
    assert.strictEqual(providers.isLoopbackHost(h), true, h);
  }
  for (const h of ["192.168.1.10", "10.0.0.5", "example.com", "128.0.0.1", "", "[::2]"]) {
    assert.strictEqual(providers.isLoopbackHost(h), false, h);
  }
});

test("非回环 http:// 地址被明确拒绝（不发请求、不报 OpenSSL 天书）", async () => {
  await assert.rejects(
    providers.chat({
      providerCfg: {
        id: "bad",
        type: "openai",
        baseUrl: "http://192.168.1.10:8080/v1",
        apiKey: "sk-test",
        model: "m",
      },
      messages: [{ role: "user", content: "你好" }],
      timeoutMs: 3000,
    }),
    /http:\/\/ 明文协议仅限本机回环地址/
  );
  await assert.rejects(
    providers.chat({
      providerCfg: {
        id: "bad",
        type: "openai",
        baseUrl: "http://example.com/v1",
        apiKey: "sk-test",
        model: "m",
      },
      messages: [{ role: "user", content: "你好" }],
      timeoutMs: 3000,
    }),
    /回环地址/
  );
});

test("回环 http:// 地址仍可用（127.x 实连，见首个用例的 127.0.0.1 全链路）", async () => {
  const server = await startServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  try {
    const text = await providers.chat({
      providerCfg: {
        id: "local",
        type: "openai",
        // 127/8 内非 .1 地址也必须放行（本地多实例端口分流场景）
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: "sk-test",
        model: "m",
      },
      messages: [{ role: "user", content: "你好" }],
      timeoutMs: 5000,
    });
    assert.strictEqual(text, "ok");
  } finally {
    await closeServer(server);
  }
});

// —— baseUrl 版本段兼容：openai / anthropic 两条分支必须同口径 ——
// 背景：服务商官网首页给的地址半数不带 /v1（https://api.deepseek.com），
// openai 分支此前裸拼 /chat/completions，这类地址永久 404。

// 起一个同时能应答两种协议的本地服务，返回实际收到的请求路径
async function startPathRecorder() {
  const paths = [];
  const server = await startServer((req, res) => {
    paths.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }], // openai 形状
        content: [{ type: "text", text: "ok" }], // anthropic 形状
      })
    );
  });
  return { server, paths };
}

// [输入 baseUrl 后缀, 期望的请求路径前缀]，端口在用例里拼上
const VERSION_SEGMENT_CASES = [
  ["/v1", "/v1"], // 带 /v1：原样使用
  ["", "/v1"], // 不带版本段：补 /v1
  ["/", "/v1"], // 只有尾斜杠：去斜杠后补 /v1
  ["/v1/", "/v1"], // 带 /v1 + 尾斜杠：去斜杠后原样使用
  ["/v2", "/v2"], // 非 1 的版本号也认（不写死 /v1）
  ["/openai/v1", "/openai/v1"], // 网关路径前缀 + 版本段：前缀保留
  ["/gw/openai", "/gw/openai/v1"], // 网关路径前缀但无版本段：前缀保留并补 /v1
];

test("openai：baseUrl 带/不带版本段都拼出正确的 chat/completions 路径", async () => {
  const { server, paths } = await startPathRecorder();
  const port = server.address().port;
  try {
    for (const [suffix, expectPrefix] of VERSION_SEGMENT_CASES) {
      paths.length = 0;
      const text = await providers.chat({
        providerCfg: {
          id: "local",
          type: "openai",
          baseUrl: `http://127.0.0.1:${port}${suffix}`,
          apiKey: "sk-test",
          model: "m",
        },
        messages: [{ role: "user", content: "你好" }],
        timeoutMs: 5000,
      });
      assert.strictEqual(text, "ok", suffix);
      assert.deepStrictEqual(
        paths,
        [`${expectPrefix}/chat/completions`],
        `baseUrl 后缀「${suffix}」`
      );
    }
  } finally {
    await closeServer(server);
  }
});

test("anthropic：baseUrl 版本段判定与 openai 完全同口径", async () => {
  const { server, paths } = await startPathRecorder();
  const port = server.address().port;
  try {
    for (const [suffix, expectPrefix] of VERSION_SEGMENT_CASES) {
      paths.length = 0;
      const text = await providers.chat({
        providerCfg: {
          id: "local",
          type: "anthropic",
          baseUrl: `http://127.0.0.1:${port}${suffix}`,
          apiKey: "sk-test",
          model: "m",
        },
        messages: [{ role: "user", content: "你好" }],
        timeoutMs: 5000,
      });
      assert.strictEqual(text, "ok", suffix);
      assert.deepStrictEqual(
        paths,
        [`${expectPrefix}/messages`],
        `baseUrl 后缀「${suffix}」`
      );
    }
  } finally {
    await closeServer(server);
  }
});
