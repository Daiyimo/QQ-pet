// 云端 LLM 提供方层：OpenAI 兼容 + Anthropic 双协议，多服务商可切换。
// 本文件在 Electron 主进程运行；全局 getSys/setSys 由 src/ini/pet.js 提供。
// 所有全局依赖均为惰性访问，保证普通 node 下直接 require 也不会炸。
const _require = eval("require");
const https = _require("https");

const DEFAULT_TIMEOUT_MS = 30000;
const ENC_PREFIX = "enc:"; // apiKey 落盘时加密 base64 的前缀标记，无前缀视为明文（兼容旧数据）

// —— sys 配置惰性访问 ——
function sysGet(key) {
  return typeof getSys === "function" ? getSys(key) : undefined;
}

function sysSet(key, value) {
  // 注意：pet.js 的 setSys 签名是 setSys({name, value})，直接传字符串会被静默丢弃
  if (typeof setSys === "function") setSys({ name: key, value });
}

// safeStorage 惰性获取（普通 node 下没有 electron）
function getSafeStorage() {
  try {
    return _require("electron").safeStorage || null;
  } catch (e) {
    return null;
  }
}

// apiKey 落盘：safeStorage.encryptString → base64（加 enc: 前缀）；
// safeStorage 不可用时退回明文并告警。已带 enc: 前缀的不重复加密。
function encryptApiKey(plain) {
  if (!plain) return "";
  if (String(plain).startsWith(ENC_PREFIX)) return plain;
  const ss = getSafeStorage();
  if (ss && ss.isEncryptionAvailable && ss.isEncryptionAvailable()) {
    return ENC_PREFIX + ss.encryptString(String(plain)).toString("base64");
  }
  console.warn("[llm/providers] safeStorage 不可用，API Key 将以明文落盘");
  return String(plain);
}

// 读取时解密；无法解密（换机/用户变更）返回空串，避免把密文当 key 发出去
function decryptApiKey(stored) {
  if (!stored) return "";
  if (!String(stored).startsWith(ENC_PREFIX)) return String(stored);
  const ss = getSafeStorage();
  try {
    if (ss && ss.isEncryptionAvailable && ss.isEncryptionAvailable()) {
      return ss.decryptString(
        Buffer.from(String(stored).slice(ENC_PREFIX.length), "base64")
      );
    }
  } catch (e) {}
  return "";
}

// 图片归一化：接受 PNG/JPEG 的 Buffer 或 base64 字符串（可带 data URL 头），
// 嗅探 JPEG 魔数决定 mediaType，默认 PNG。
function normalizeImage(img) {
  let base64 = null;
  if (Buffer.isBuffer(img)) {
    base64 = img.toString("base64");
  } else if (typeof img === "string" && img) {
    base64 = img.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
  }
  if (!base64) return null;
  const mediaType = base64.startsWith("/9j/") ? "image/jpeg" : "image/png";
  return { base64, mediaType };
}

// 底层 POST JSON（Node 内置 https，风格参照旧 llm.js 的 callDeepSeek）
function postJson(urlStr, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(
        new Error(`API 地址无效（${urlStr || "空"}），请在设置页检查服务商配置`)
      );
    }
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

// 把 images 并入最后一条 user 消息（OpenAI image_url 形式）
function mergeImagesOpenAI(messages, images) {
  const imgs = (images || []).map(normalizeImage).filter(Boolean);
  if (!imgs.length) return messages;
  const result = messages.map((m) => ({ ...m }));
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "user") {
      const text =
        typeof result[i].content === "string"
          ? result[i].content
          : JSON.stringify(result[i].content);
      result[i].content = [
        { type: "text", text },
        ...imgs.map((im) => ({
          type: "image_url",
          image_url: { url: `data:${im.mediaType};base64,${im.base64}` },
        })),
      ];
      break;
    }
  }
  return result;
}

// Anthropic：system 抽顶层，images 走 base64 content block
function convertMessagesAnthropic(messages, images) {
  const systemParts = [];
  const conv = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content) systemParts.push(m.content);
      continue;
    }
    conv.push({ role: m.role, content: m.content });
  }
  const imgs = (images || []).map(normalizeImage).filter(Boolean);
  if (imgs.length) {
    for (let i = conv.length - 1; i >= 0; i--) {
      if (conv[i].role === "user") {
        const text =
          typeof conv[i].content === "string"
            ? conv[i].content
            : JSON.stringify(conv[i].content);
        conv[i] = {
          role: "user",
          content: [
            ...imgs.map((im) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: im.mediaType,
                data: im.base64,
              },
            })),
            { type: "text", text },
          ],
        };
        break;
      }
    }
  }
  return { system: systemParts.join("\n"), messages: conv };
}

async function chatOpenAI(cfg, { messages, images, maxTokens, temperature, timeoutMs }) {
  const url = String(cfg.baseUrl || "").replace(/\/+$/, "") + "/chat/completions";
  const payload = {
    model: cfg.model,
    messages: mergeImagesOpenAI(messages, images),
  };
  if (maxTokens) payload.max_tokens = maxTokens;
  if (temperature != null) payload.temperature = temperature;
  const { statusCode, body } = await postJson(
    url,
    { Authorization: `Bearer ${cfg.apiKey}` },
    payload,
    timeoutMs || DEFAULT_TIMEOUT_MS
  );
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`openai HTTP ${statusCode}: ${String(body).slice(0, 500)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`openai 响应解析失败: ${String(body).slice(0, 200)}`);
  }
  if (parsed.error) {
    throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) {
    // 推理模型在 max_tokens 过小时会把额度全花在 reasoning 上，正文为空
    const hasReasoning = !!parsed.choices?.[0]?.message?.reasoning_content;
    throw new Error(
      hasReasoning
        ? "模型输出只有思考内容（max_tokens 可能被推理耗尽），请调大 max_tokens 或换非推理模型"
        : "openai 响应缺少文本内容"
    );
  }
  return content;
}

async function chatAnthropic(cfg, { messages, images, maxTokens, temperature, timeoutMs }) {
  const base = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  // baseUrl 已带 /v1 时（如 Step Plan 的 .../step_plan/v1）直接拼 /messages，
  // 否则补 /v1/messages（如 https://api.anthropic.com）
  const url = base.endsWith("/v1") ? base + "/messages" : base + "/v1/messages";
  const { system, messages: conv } = convertMessagesAnthropic(messages, images);
  const payload = {
    model: cfg.model,
    max_tokens: maxTokens || 1024, // Anthropic 必填
    messages: conv,
  };
  if (system) payload.system = system;
  if (temperature != null) payload.temperature = temperature;
  const { statusCode, body } = await postJson(
    url,
    {
      // 两种鉴权头都带上：Anthropic 官方用 x-api-key，
      // Step Plan 等兼容端点按 Claude Code 惯例用 Authorization: Bearer
      "x-api-key": cfg.apiKey,
      Authorization: `Bearer ${cfg.apiKey}`,
      "anthropic-version": "2023-06-01",
    },
    payload,
    timeoutMs || DEFAULT_TIMEOUT_MS
  );
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`anthropic HTTP ${statusCode}: ${String(body).slice(0, 500)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`anthropic 响应解析失败: ${String(body).slice(0, 200)}`);
  }
  if (parsed.error) {
    throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  }
  const text = (parsed.content || [])
    .filter((b) => b && b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) {
    // 推理模型在 max_tokens 过小时会把额度全花在 thinking 块上，没有 text 输出
    const hasThinking = (parsed.content || []).some((b) => b && b.type === "thinking");
    throw new Error(
      hasThinking
        ? "模型输出只有思考内容（max_tokens 可能被推理耗尽），请调大 max_tokens 或换非推理模型"
        : "anthropic 响应缺少文本内容"
    );
  }
  return text;
}

// 统一对话入口：返回模型文本输出（string）。
// providerCfg = { id, type: "openai"|"anthropic", baseUrl, apiKey, model }
async function chat({ providerCfg, messages, images, maxTokens, temperature, timeoutMs }) {
  if (!providerCfg) throw new Error("未配置 LLM 提供商");
  if (!providerCfg.apiKey) {
    throw new Error(`提供商「${providerCfg.id || "未知"}」缺少 API Key`);
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("messages 不能为空");
  }
  const args = { messages, images, maxTokens, temperature, timeoutMs };
  if (providerCfg.type === "anthropic") return chatAnthropic(providerCfg, args);
  return chatOpenAI(providerCfg, args);
}

// 连通性测试：发一条极短消息
async function testProvider(providerCfg) {
  try {
    const text = await chat({
      providerCfg,
      messages: [{ role: "user", content: "用一句话介绍你自己。" }],
      // 推理模型（step-3.7 等）的 thinking 会消耗输出额度，测试也要给足
      maxTokens: 512,
      timeoutMs: 30000,
    });
    return { ok: !!text };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// —— 提供商配置读取（sys: llmProviders / llmActiveProvider / visionProvider）——
function getProvider(providerId) {
  const list = sysGet("llmProviders");
  if (!providerId || !Array.isArray(list)) return null;
  const raw = list.find((p) => p && p.id === providerId);
  if (!raw) return null;
  return {
    id: raw.id,
    type: raw.type || "openai",
    baseUrl: raw.baseUrl || "",
    apiKey: decryptApiKey(raw.apiKey),
    model: raw.model || "",
  };
}

function getChatProvider() {
  return getProvider(sysGet("llmActiveProvider"));
}

// 感知专用视觉提供商；未单独配置时回退到对话提供商
function getVisionProvider() {
  const vid = sysGet("visionProvider");
  return vid ? getProvider(vid) : getChatProvider();
}

// 设置页保存入口：apiKey 加密后落盘
function saveProviders(providersArray) {
  const stored = (Array.isArray(providersArray) ? providersArray : []).map((p) => ({
    id: p.id,
    type: p.type || "openai",
    baseUrl: p.baseUrl || "",
    apiKey: encryptApiKey(p.apiKey || ""),
    model: p.model || "",
  }));
  sysSet("llmProviders", stored);
  return stored;
}

module.exports = {
  chat,
  testProvider,
  getProvider,
  getChatProvider,
  getVisionProvider,
  saveProviders,
  encryptApiKey,
  decryptApiKey,
};
