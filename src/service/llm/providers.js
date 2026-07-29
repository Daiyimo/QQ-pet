// 云端 LLM 提供方层：OpenAI 兼容 + Anthropic 双协议，多服务商可切换。
// 本文件在 Electron 主进程运行；全局 getSys/setSys 由 src/ini/pet.js 提供。
// 所有全局依赖均为惰性访问，保证普通 node 下直接 require 也不会炸。
const _require = eval("require");
const https = _require("https");

const DEFAULT_TIMEOUT_MS = 30000;
const ENC_PREFIX = "enc:"; // apiKey 落盘时加密 base64 的前缀标记，无前缀视为明文（兼容旧数据）
const ENCRYPT_FAILED = "encfail:"; // 加密不可用时的失败信号；只在内存中流转，落盘前必须被拦截

// —— 旧版（DeepSeek 时代）明文配置键：仅迁移逻辑使用，其他模块不要再直接读 ——
const LEGACY_API_KEY_KEY = "llmApiKey";
const LEGACY_MODEL_KEY = "llmModel";
const LEGACY_BASE_URL_KEY = "llmBaseUrl";
const LEGACY_PROVIDER_ID = "legacy-deepseek";
const LEGACY_BASE_URL = "https://api.deepseek.com/v1";
const LEGACY_DEFAULT_MODEL = "deepseek-chat";

// —— sys 配置惰性访问 ——
function sysGet(key) {
  return typeof getSys === "function" ? getSys(key) : undefined;
}

function sysSet(key, value) {
  // 注意：pet.js 的 setSys 签名是 setSys({name, value})，直接传字符串会被静默丢弃
  if (typeof setSys === "function") setSys({ name: key, value });
}

// safeStorage 惰性获取（普通 node 下没有 electron）；
// _safeStorageStub 是单元测试注入点，生产运行时恒为 null
let _safeStorageStub = null;

function getSafeStorage() {
  if (_safeStorageStub) return _safeStorageStub;
  try {
    return _require("electron").safeStorage || null;
  } catch (e) {
    return null;
  }
}

// 加密可用性判断：safeStorage 存在且系统凭据服务就绪
function isEncryptionAvailable() {
  const ss = getSafeStorage();
  try {
    return !!(ss && ss.isEncryptionAvailable && ss.isEncryptionAvailable());
  } catch (e) {
    console.error("[llm/providers] 查询 safeStorage 可用性失败", e);
    return false;
  }
}

// apiKey 落盘：safeStorage.encryptString → base64（加 enc: 前缀）；
// safeStorage 不可用时**绝不退回明文**，返回 ENCRYPT_FAILED 失败信号并记错误日志。
// 已带 enc: 前缀的不重复加密。
function encryptApiKey(plain) {
  if (!plain) return "";
  const raw = String(plain);
  if (raw.startsWith(ENC_PREFIX)) return raw;
  if (!isEncryptionAvailable()) {
    console.error(
      "[llm/providers] safeStorage 不可用，拒绝把 API Key 明文落盘",
      new Error("safeStorage unavailable")
    );
    return ENCRYPT_FAILED;
  }
  try {
    return ENC_PREFIX + getSafeStorage().encryptString(raw).toString("base64");
  } catch (e) {
    console.error("[llm/providers] API Key 加密失败，拒绝明文落盘", e);
    return ENCRYPT_FAILED;
  }
}

// 加密失败信号判定：调用方据此提示用户「填了 key 但没能保存」
function isEncryptFailed(value) {
  return value === ENCRYPT_FAILED;
}

// 读取时解密；无法解密（换机/用户变更）返回空串，避免把密文当 key 发出去。
// 所有降级分支都必须留下错误日志，否则问题不可观测。
function decryptApiKey(stored) {
  if (!stored) return "";
  const raw = String(stored);
  if (raw === ENCRYPT_FAILED) {
    console.error(
      "[llm/providers] 读到加密失败标记，说明 API Key 从未成功保存，请在设置页重新填写",
      new Error("api key was never persisted")
    );
    return "";
  }
  if (!raw.startsWith(ENC_PREFIX)) return raw; // 尚未迁移的旧明文，保持可用
  if (!isEncryptionAvailable()) {
    console.error(
      "[llm/providers] safeStorage 不可用，已保存的 API Key 无法解密，按空 Key 降级",
      new Error("safeStorage unavailable")
    );
    return "";
  }
  try {
    return getSafeStorage().decryptString(
      Buffer.from(raw.slice(ENC_PREFIX.length), "base64")
    );
  } catch (e) {
    console.error(
      "[llm/providers] API Key 解密失败（可能换机或系统凭据变更），按空 Key 降级",
      e
    );
    return "";
  }
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

// —— 旧版明文 API Key 一次性迁移 ——
// 判定明文：sys.llmApiKey 非空且既不是 enc: 密文也不是失败信号。
// 迁移：加密后写入 sys.llmProviders 的 legacy-deepseek 条目（已存在则覆盖），
// 未指定生效提供商时顺带指向它，最后清空明文键。
// 幂等：明文键清空后再次调用直接返回 no-legacy；加密不可用时**不清明文**，留待下次启动重试。
function migrateLegacyApiKey() {
  const legacy = sysGet(LEGACY_API_KEY_KEY);
  const plain = legacy == null ? "" : String(legacy);
  if (!plain) return { migrated: false, reason: "no-legacy" };
  if (plain.startsWith(ENC_PREFIX) || plain === ENCRYPT_FAILED) {
    // 不是明文，无需迁移；顺手清掉这个已废弃的键
    sysSet(LEGACY_API_KEY_KEY, "");
    return { migrated: false, reason: "not-plaintext" };
  }
  const encrypted = encryptApiKey(plain);
  if (isEncryptFailed(encrypted)) {
    console.error(
      "[llm/providers] 旧版明文 API Key 迁移失败：safeStorage 不可用，明文暂时保留，下次启动重试",
      new Error("safeStorage unavailable")
    );
    return { migrated: false, reason: "encrypt-unavailable" };
  }
  const raw = sysGet("llmProviders");
  const list = Array.isArray(raw) ? raw.slice() : [];
  const entry = {
    id: LEGACY_PROVIDER_ID,
    type: "openai",
    baseUrl: sysGet(LEGACY_BASE_URL_KEY) || LEGACY_BASE_URL,
    apiKey: encrypted,
    model: sysGet(LEGACY_MODEL_KEY) || LEGACY_DEFAULT_MODEL,
  };
  const idx = list.findIndex((p) => p && p.id === LEGACY_PROVIDER_ID);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  sysSet("llmProviders", list);
  if (!sysGet("llmActiveProvider")) {
    sysSet("llmActiveProvider", LEGACY_PROVIDER_ID);
  }
  sysSet(LEGACY_API_KEY_KEY, ""); // 清除明文（pet.js 的 getSys 对空串返回 undefined）
  console.log(
    "[llm/providers] 已把旧版明文 API Key 迁移到加密存储，并清除明文键 " +
      LEGACY_API_KEY_KEY
  );
  return { migrated: true, reason: "ok", providerId: LEGACY_PROVIDER_ID };
}

// 进程内只尝试一次，避免每次取 key 都重复迁移/重复告警
let _legacyMigrateTried = false;

function ensureLegacyMigrated() {
  if (_legacyMigrateTried) return;
  _legacyMigrateTried = true;
  migrateLegacyApiKey();
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

// 统一取 key 入口：其他模块一律走这里，不要再直接读旧的明文键
function getChatProvider() {
  ensureLegacyMigrated();
  return getProvider(sysGet("llmActiveProvider"));
}

// 是否已配置可用的对话提供商（含可解密的 key）——供各处的 LLM 门禁判断
function hasChatProvider() {
  const cfg = getChatProvider();
  return !!(cfg && cfg.apiKey);
}

// 感知专用视觉提供商；未单独配置时回退到对话提供商
function getVisionProvider() {
  ensureLegacyMigrated();
  const vid = sysGet("visionProvider");
  return vid ? getProvider(vid) : getChatProvider();
}

// 设置页保存入口：apiKey 加密后落盘。
// 任一 key 加密失败即整体放弃写入并返回 { ok:false, error }，调用方必须把失败告知用户。
function saveProviders(providersArray) {
  const list = Array.isArray(providersArray) ? providersArray : [];
  const stored = [];
  for (const p of list) {
    const apiKey = encryptApiKey(p.apiKey || "");
    if (isEncryptFailed(apiKey)) {
      const error = `提供商「${
        p.id || "未知"
      }」的 API Key 无法加密保存（系统凭据服务不可用），已放弃写入以避免明文落盘`;
      console.error("[llm/providers] " + error, new Error("encrypt failed"));
      return { ok: false, error, providers: null };
    }
    stored.push({
      id: p.id,
      type: p.type || "openai",
      baseUrl: p.baseUrl || "",
      apiKey,
      model: p.model || "",
    });
  }
  sysSet("llmProviders", stored);
  return { ok: true, error: null, providers: stored };
}

module.exports = {
  chat,
  testProvider,
  getProvider,
  getChatProvider,
  hasChatProvider,
  getVisionProvider,
  saveProviders,
  encryptApiKey,
  decryptApiKey,
  isEncryptFailed,
  migrateLegacyApiKey,
  ENC_PREFIX,
  ENCRYPT_FAILED,
  // —— 单元测试注入点（仅测试调用，生产代码不要用）——
  __setSafeStorageStub(ss) {
    _safeStorageStub = ss || null;
  },
  __resetLegacyMigrateFlag() {
    _legacyMigrateTried = false;
  },
};
