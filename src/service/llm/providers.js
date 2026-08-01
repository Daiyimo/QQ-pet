// 云端 LLM 提供方层：OpenAI 兼容 + Anthropic 双协议，多服务商可切换。
// 本文件在 Electron 主进程运行；全局 getSys/setSys 由 src/ini/pet.js 提供。
// 所有全局依赖均为惰性访问，保证普通 node 下直接 require 也不会炸。
const _require = eval("require");
const https = _require("https");
const http = _require("http");

const DEFAULT_TIMEOUT_MS = 30000;
// 响应体字节上限：正常对话/视觉响应远小于此，配置错误或被劫持的端点可能持续吐数据，
// 而 req.setTimeout 是"空闲超时"，持续有数据时永不触发 → 必须自己封顶。
// 与 memory/imageGen.js 的做法一致（那里对图片/JSON 分别限 25MB/36MB）。
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
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

// http:// 明文协议只放行回环地址：本地 ollama / LM Studio 等端点（127.0.0.0/8、
// localhost、[::1]）可用；非回环 http 会把 API Key 与聊天内容明文发给远端，明确拒绝。
function isLoopbackHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (h === "localhost" || h === "[::1]") return true;
  // 127.0.0.0/8 整段都是回环
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// 底层 POST JSON（Node 内置 http/https）。
// - 按 URL 的 protocol 选择模块与默认端口（本地端点如 http://127.0.0.1:11434/v1 也能用；
//   过去恒用 https + 443，填 http 地址会报天书般的 OpenSSL 错误）；
//   http:// 明文仅限回环地址（见 isLoopbackHost），非回环 http 直接拒绝；
// - 响应体累计超过 MAX_RESPONSE_BYTES 立即中断，避免主进程内存被撑爆；
// - 按 Buffer 收集后一次性 toString("utf8")，避免多字节字符在 chunk 边界被截成乱码；
// - 支持 signal（AbortSignal）：调用方关闭功能时可真正掐断在途请求。
function postJson(urlStr, headers, payload, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(
        new Error(`API 地址无效（${urlStr || "空"}），请在设置页检查服务商配置`)
      );
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return reject(
        new Error(`API 地址协议不支持（${u.protocol}），只支持 http/https`)
      );
    }
    if (u.protocol === "http:" && !isLoopbackHost(u.hostname)) {
      return reject(
        new Error(
          `API 地址使用 http:// 明文协议仅限本机回环地址（127.x.x.x / localhost / [::1]），` +
            `已拒绝：${u.hostname}。云端服务商请改用 https://`
        )
      );
    }
    // 与 memory/imageGen.js 的 buildEndpoint 对齐：拒绝 URL 内嵌凭据，
    // 避免 user:pass@host 被静默带进请求并可能写进日志
    if (u.username || u.password) {
      return reject(
        new Error("API 地址不允许内嵌用户名密码，请在设置页检查服务商配置")
      );
    }
    if (signal && signal.aborted) {
      return reject(new Error("request aborted"));
    }
    const mod = u.protocol === "http:" ? http : https;
    const body = JSON.stringify(payload);
    let settled = false;
    let onAbort = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      fn(arg);
    };
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy();
            req.destroy();
            finish(
              reject,
              new Error(
                `API 响应体超过 ${MAX_RESPONSE_BYTES} 字节上限，已中断（请检查服务商地址是否正确）`
              )
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(resolve, {
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
        res.on("error", (e) => finish(reject, e));
      }
    );
    req.on("error", (e) => finish(reject, e));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(reject, new Error("timeout"));
    });
    if (signal) {
      onAbort = () => {
        req.destroy();
        finish(reject, new Error("request aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
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

// 错误体脱敏：HTTP 错误片段会进日志，可能回显 apiKey，先替换再拼接
// （与 memory/imageGen.js 的 redact 等价，仅替换符不同）
function redact(value, secret) {
  return secret ? String(value).split(secret).join("***") : String(value);
}

// baseUrl 末段是否已经是 API 版本段（/v1、/v2…）。
// 服务商官网首页给的地址半数带版本段（https://api.moonshot.cn/v1）、半数不带
// （https://api.deepseek.com、https://api.anthropic.com）；自建网关还会带路径前缀
// （https://gw.example.com/openai/v1）或用 /v2。两条协议分支必须共用这一个判定，
// 否则同一个 baseUrl 换个 type 就得到不同结果——本文件此前只有 anthropic 侧判了
// endsWith("/v1")，openai 侧裸拼 /chat/completions，用户填不带 /v1 的地址永久 404。
// 口径与原 anthropic 分支一致（只看末段），仅把写死的 /v1 放宽为 /v{数字}。
const API_VERSION_SEGMENT_RE = /\/v\d+$/;

function hasApiVersionSegment(base) {
  return API_VERSION_SEGMENT_RE.test(base);
}

async function chatOpenAI(cfg, { messages, images, maxTokens, temperature, timeoutMs, signal }) {
  const base = String(cfg.baseUrl || "").replace(/\/+$/, "");
  const url = hasApiVersionSegment(base)
    ? base + "/chat/completions"
    : base + "/v1/chat/completions";
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
    timeoutMs || DEFAULT_TIMEOUT_MS,
    signal
  );
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`openai HTTP ${statusCode}: ${redact(body, cfg.apiKey).slice(0, 500)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`openai 响应解析失败: ${redact(body, cfg.apiKey).slice(0, 200)}`);
  }
  if (parsed.error) {
    throw new Error(redact(parsed.error.message || JSON.stringify(parsed.error), cfg.apiKey));
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

async function chatAnthropic(cfg, { messages, images, maxTokens, temperature, timeoutMs, signal }) {
  const base = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  // baseUrl 已带版本段时（如 Step Plan 的 .../step_plan/v1）直接拼 /messages，
  // 否则补 /v1/messages（如 https://api.anthropic.com）；判定见 hasApiVersionSegment
  const url = hasApiVersionSegment(base) ? base + "/messages" : base + "/v1/messages";
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
    timeoutMs || DEFAULT_TIMEOUT_MS,
    signal
  );
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`anthropic HTTP ${statusCode}: ${redact(body, cfg.apiKey).slice(0, 500)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`anthropic 响应解析失败: ${redact(body, cfg.apiKey).slice(0, 200)}`);
  }
  if (parsed.error) {
    throw new Error(redact(parsed.error.message || JSON.stringify(parsed.error), cfg.apiKey));
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
// signal：可选 AbortSignal，调用方（如感知循环 stop()）用它掐断在途请求。
async function chat({ providerCfg, messages, images, maxTokens, temperature, timeoutMs, signal }) {
  if (!providerCfg) throw new Error("未配置 LLM 提供商");
  if (!providerCfg.apiKey) {
    throw new Error(`提供商「${providerCfg.id || "未知"}」缺少 API Key`);
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("messages 不能为空");
  }
  const args = { messages, images, maxTokens, temperature, timeoutMs, signal };
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

// 进程内只尝试一次，避免每次取 key 都重复迁移/重复告警；
// 标志位在正常返回后才置位：migrateLegacyApiKey 抛错（如 sys 未初始化）时允许下次重试
let _legacyMigrateTried = false;

function ensureLegacyMigrated() {
  if (_legacyMigrateTried) return;
  migrateLegacyApiKey();
  _legacyMigrateTried = true;
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
  isLoopbackHost,
  ENC_PREFIX,
  ENCRYPT_FAILED,
  MAX_RESPONSE_BYTES,
  // —— 单元测试注入点（仅测试调用，生产代码不要用）——
  __setSafeStorageStub(ss) {
    _safeStorageStub = ss || null;
  },
  __resetLegacyMigrateFlag() {
    _legacyMigrateTried = false;
  },
};
