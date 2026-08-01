// 日程信息图生成：移植自 jarvis_backend/memory/image_generation.py（OpenAI 兼容
// images/edits multipart 客户端，几乎 1:1）。Node 内置 https 手工拼装
// multipart/form-data，不引第三方依赖。
// 参考图改为从 sys 配置读取（getSys("imageGenRefs")：两个文件路径），
// 不再内置 jarvis 的角色/风格参考图。
const _require = eval("require");
const fs = _require("fs");
const http = _require("http");
const https = _require("https");
const crypto = _require("crypto");

const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_JSON_BYTES = 36 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300000; // 300s

// PNG/JPEG/WEBP 魔数校验（_is_supported_image）
function isSupportedImage(content) {
  if (!Buffer.isBuffer(content) || content.length < 12) return false;
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return true;
  if (
    content.subarray(0, 4).toString("latin1") === "RIFF" &&
    content.subarray(8, 12).toString("latin1") === "WEBP"
  ) return true;
  return false;
}

// 由魔数推断扩展名（_image_extension）
function imageExtension(content) {
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "jpg";
  if (content.subarray(0, 4).toString("latin1") === "RIFF" && content.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  throw new Error("generated image uses an unsupported format");
}

function redact(value, secret) {
  return secret ? String(value).split(secret).join("[redacted]") : String(value);
}

// endpoint：baseUrl 必须是绝对 http(s) URL 且不含凭据；自动补 /images/edits。
// http:// 明文只放行回环地址：非回环 http 会把 Authorization: Bearer <apiKey>、
// 参考图与日记正文明文发给远端。回环判定复用 llm/providers.js 的 isLoopbackHost
// （唯一实现，不在此复制第二份）；惰性 require 与本文件 generateDailyImage 中
// 取 providers 的方式一致，不引入模块加载期耦合。
function buildEndpoint(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/+$/, "");
  let u;
  try {
    u = new URL(value);
  } catch (e) {
    throw new Error("image API base URL must be an absolute HTTP(S) URL");
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.host) {
    throw new Error("image API base URL must be an absolute HTTP(S) URL");
  }
  if (u.username || u.password) {
    throw new Error("image API base URL must not contain credentials");
  }
  if (u.protocol === "http:" && !_require("../llm/providers.js").isLoopbackHost(u.hostname)) {
    // 文案与 llm/providers.js 的 postJson 对齐，避免两个设置标签页给出两种说法
    throw new Error(
      `图像 API 地址使用 http:// 明文协议仅限本机回环地址（127.x.x.x / localhost / [::1]），` +
        `已拒绝：${u.hostname}。云端服务商请改用 https://`
    );
  }
  return value.endsWith("/images/edits") ? value : value + "/images/edits";
}

// multipart/form-data 拼装（_multipart）：字段 + 恰好 2 张参考图（重复 image[] 字段）
function buildMultipart(fields, images) {
  const boundary = `----QQLocal${crypto.randomUUID().replace(/-/g, "")}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`, "utf8"),
      Buffer.from(String(value), "utf8"),
      Buffer.from("\r\n", "utf8")
    );
  }
  for (const { filename, content, contentType } of images) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
        "utf8"
      ),
      content,
      Buffer.from("\r\n", "utf8")
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// 带大小限制的 POST，返回 {statusCode, body(Buffer)}。
// signal（AbortSignal）：调用方关闭功能/结束会话时掐断在途请求（同 llm/providers.js 的做法）。
function postBuffer(urlStr, headers, body, timeoutMs, maxBytes, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("image API request aborted"));
      return;
    }
    const u = new URL(urlStr);
    const mod = u.protocol === "http:" ? http : https;
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
        headers: { "Content-Length": body.length, ...headers },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            finish(reject, new Error("image API response exceeds the allowed size"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(resolve, { statusCode: res.statusCode, body: Buffer.concat(chunks) })
        );
        res.on("error", (e) => finish(reject, e));
      }
    );
    req.on("error", (e) => finish(reject, e));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(reject, new Error("image API request failed: timeout"));
    });
    if (signal) {
      onAbort = () => {
        req.destroy();
        finish(reject, new Error("image API request aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    req.write(body);
    req.end();
  });
}

// 二次下载（响应只给 url 时），同样限 25MB。
// depth：重定向跳数，超过 MAX_REDIRECTS 即失败——否则自指向的 301 会无限跳转，
// Promise 永不结算（每跳都是新请求，单次空闲超时也救不了）。
// signal（AbortSignal）：掐断在途下载；重定向的每一跳都会继承同一个 signal。
const MAX_REDIRECTS = 5;

// 下载地址门禁（SSRF 面）：这个 URL 是**图像服务商响应里给的**，不是我方配置的，
// 可以指向内网/本机。规则：
//   ① 只允许 http/https；
//   ② https 上游不得降级到 http（无论目标是不是回环）——降级重定向没有正当用途；
//   ③ http:// 只放行回环地址，保证本地服务商（Ollama / LM Studio 等）返回
//      http://127.0.0.1/... 的图片地址仍可下载，同时挡住 http://内网主机。
// 回环判定复用 llm/providers.js 的 isLoopbackHost（与 buildEndpoint 同一实现，
// 全仓只此一份，不产生第三份拷贝）。
// fromProtocol：上一跳（首个 URL 时为 endpoint）的协议，用于判定②；未提供则跳过②。
// 返回拒绝原因字符串，通过则返回 null。**每一跳都调用**（见 downloadBuffer 递归）。
function downloadUrlDenialReason(u, fromProtocol) {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "image API returned an unsupported image URL";
  }
  if (u.protocol === "http:" && fromProtocol === "https:") {
    return (
      "generated image download refused: https to http downgrade is not allowed " +
      `(got http://${u.hostname})`
    );
  }
  if (u.protocol === "http:" && !_require("../llm/providers.js").isLoopbackHost(u.hostname)) {
    return (
      "generated image download refused: plain http:// image URL is only allowed for " +
      `loopback hosts (127.x.x.x / localhost / [::1]), got ${u.hostname}`
    );
  }
  return null;
}

function downloadBuffer(urlStr, timeoutMs, maxBytes, depth = 0, signal, fromProtocol) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("generated image download aborted"));
      return;
    }
    const u = new URL(urlStr);
    const denied = downloadUrlDenialReason(u, fromProtocol);
    if (denied) {
      reject(new Error(denied));
      return;
    }
    const mod = u.protocol === "http:" ? http : https;
    let settled = false;
    let onAbort = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      fn(arg);
    };
    const req = mod.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (depth >= MAX_REDIRECTS) {
          finish(
            reject,
            new Error(
              `generated image download failed: too many redirects (>${MAX_REDIRECTS})`
            )
          );
          return;
        }
        finish(
          resolve,
          downloadBuffer(
            new URL(res.headers.location, u).toString(),
            timeoutMs,
            maxBytes,
            depth + 1,
            signal,
            // 本跳的协议作为下一跳的 fromProtocol：门禁在递归入口重新执行，逐跳复查
            u.protocol
          )
        );
        return;
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          finish(reject, new Error("image API response exceeds the allowed size"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => finish(resolve, Buffer.concat(chunks)));
      res.on("error", (e) => finish(reject, e));
    });
    req.on("error", (e) => finish(reject, e));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(reject, new Error("generated image download failed: timeout"));
    });
    if (signal) {
      onAbort = () => {
        req.destroy();
        finish(reject, new Error("generated image download aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// _response_image：b64_json / base64 / result 优先（可带 data: 头），否则取 url
function responseImage(payload) {
  const candidates = payload.data || payload.images || payload.output || [];
  if (!Array.isArray(candidates) || !candidates.length) return { image: null, url: null };
  const first = candidates[0];
  if (!first || typeof first !== "object") return { image: null, url: null };
  let encoded = first.b64_json || first.base64 || first.result;
  if (typeof encoded === "string" && encoded) {
    if (encoded.startsWith("data:")) encoded = encoded.slice(encoded.indexOf(",") + 1);
    try {
      return { image: Buffer.from(encoded, "base64"), url: null };
    } catch (e) {
      throw new Error("image API returned invalid base64 data");
    }
  }
  const url = typeof first.url === "string" && first.url ? first.url : null;
  return { image: null, url };
}

class ImageGenerationClient {
  // providerCfg = {baseUrl, apiKey, modelName}；referenceImages 恰好 2 个 Buffer。
  // signal（AbortSignal）：可选，功能关闭/会话结束时掐断在途生成。
  // 返回 {imageBuffer, ext}。
  async generate({ providerCfg, prompt, referenceImages, timeoutMs, signal }) {
    const cfg = providerCfg || {};
    const endpoint = buildEndpoint(cfg.baseUrl);
    const apiKey = String(cfg.apiKey || "").trim();
    const modelName = String(cfg.modelName || "").trim();
    if (!apiKey) throw new Error("image API key must not be empty");
    if (!modelName) throw new Error("image model name must not be empty");
    if (!Array.isArray(referenceImages) || referenceImages.length !== 2) {
      throw new Error("exactly two image references are required");
    }
    const files = referenceImages.map((content, i) => {
      if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_IMAGE_BYTES || !isSupportedImage(content)) {
        throw new Error(`invalid reference image: #${i + 1}`);
      }
      return {
        filename: `reference-${i + 1}.${imageExtension(content)}`,
        content,
        contentType: "image/" + imageExtension(content).replace("jpg", "jpeg"),
      };
    });

    const { body, contentType } = buildMultipart(
      { model: modelName, prompt: String(prompt), size: "1536x1024", quality: "high" },
      files
    );
    const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
    const { statusCode, body: respBody } = await postBuffer(
      endpoint,
      {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": contentType,
        Accept: "application/json",
        "User-Agent": "QQ-Local/0.1",
      },
      body,
      timeout,
      MAX_JSON_BYTES,
      signal
    );
    if (statusCode < 200 || statusCode >= 300) {
      let detail = respBody.subarray(0, 4096).toString("utf8");
      try {
        const parsed = JSON.parse(detail);
        const err = parsed && typeof parsed === "object" ? parsed.error : null;
        detail = String(
          (err && typeof err === "object" ? err.message : err) || parsed.message || detail
        );
      } catch (e) {
        // 错误响应体不是 JSON：保留原始文本作为 detail，紧随其后就带着它抛错，
        // 信息不会丢失，因此这里不重复打日志
      }
      throw new Error(`image API returned HTTP ${statusCode}: ${redact(detail, apiKey).slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(respBody.toString("utf8"));
    } catch (e) {
      throw new Error("image API returned invalid JSON");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("image API returned an invalid response object");
    }
    let { image, url } = responseImage(payload);
    if (!image && url) {
      // 传入 endpoint 的协议作为首跳的 fromProtocol：https 服务商返回 http 图片地址
      // 一律拒绝（配置错误或指向内网），http 回环服务商返回 http 回环地址仍可下载
      image = await downloadBuffer(
        url,
        timeout,
        MAX_IMAGE_BYTES,
        0,
        signal,
        new URL(endpoint).protocol
      );
    }
    if (!image || !image.length) throw new Error("image API response contains no image");
    if (image.length > MAX_IMAGE_BYTES) throw new Error("generated image exceeds 25 MB");
    if (!isSupportedImage(image)) throw new Error("image API returned an unsupported image format");
    return { imageBuffer: image, ext: imageExtension(image) };
  }
}

// 落盘：daily-images/<day>/<UTC时间戳>-<uuid8>.<ext> + 同名 .json 元数据
function exportImagesMeta({ store, day, imageBuffer, ext, modelName }) {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .replace("Z", ""); // YYYYMMDDTHHmmss（UTC）
  const uuid8 = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const filename = `${stamp}-${uuid8}.${ext}`;
  const metadata = {
    id: filename,
    date: day,
    filename,
    created_at: now.toISOString(),
    model_name: String(modelName || "").trim(),
  };
  store.writeDailyImage(day, filename, imageBuffer, metadata);
  return metadata;
}

// sys 配置惰性访问
function sysGet(key) {
  return typeof getSys === "function" ? getSys(key) : undefined;
}

// 从 sys 读取两张参考图（getSys("imageGenRefs")：[角色图路径, 风格图路径]）。
// 返回 null 表示不可用（调用方降级为 reason:"no-reference"），但"配置缺失"与
// "路径读不出来/格式不对"是两回事，必须分别落日志，否则用户永远查不出真实原因。
function loadReferenceImages() {
  const refs = sysGet("imageGenRefs");
  if (!Array.isArray(refs) || refs.length !== 2 || refs.some((p) => !p)) return null;
  try {
    const bufs = refs.map((p) => fs.readFileSync(String(p)));
    const bad = bufs.findIndex(
      (b) => !b.length || b.length > MAX_IMAGE_BYTES || !isSupportedImage(b)
    );
    if (bad >= 0) {
      console.error(
        `[memory/imageGen] 参考图 #${bad + 1}（${refs[bad]}）为空、超过 ${MAX_IMAGE_BYTES} 字节` +
          "或不是 PNG/JPEG/WEBP，已按未配置参考图降级",
        new Error("invalid reference image")
      );
      return null;
    }
    return bufs;
  } catch (e) {
    console.error(
      "[memory/imageGen] 读取参考图失败（路径不存在或无权限），已按未配置参考图降级:",
      e && e.stack ? e.stack : e
    );
    return null;
  }
}

// 生成某天的日程信息图。参考图未配置 → {ok:false, reason:"no-reference"}；
// 图像提供商未配置 → {ok:false, reason:"no-provider"}。成功 → {ok:true, metadata}。
// signal（AbortSignal）：可选，贯穿到 generate 的 POST 与二次下载，掐断在途生成。
async function generateDailyImage({ store, dailyService, day, signal }) {
  const refs = loadReferenceImages();
  if (!refs) return { ok: false, reason: "no-reference" };
  const providerRaw = sysGet("imageGenProvider");
  if (!providerRaw || !providerRaw.baseUrl || !providerRaw.apiKey || !providerRaw.modelName) {
    return { ok: false, reason: "no-provider" };
  }
  const providers = _require("../llm/providers.js");
  const prompts = _require("../llm/prompts.js");
  const providerCfg = {
    baseUrl: providerRaw.baseUrl,
    apiKey: providers.decryptApiKey(providerRaw.apiKey),
    modelName: providerRaw.modelName,
  };

  // 没有当日记忆则先生成
  let content = store.readDaily(day);
  if (content == null) {
    const generated = await dailyService.generateDaily(day);
    content = generated.content;
  }
  // _daily_review：取 "## 今日回顾" 之后的正文，压缩空白
  const marker = "## 今日回顾";
  const idx = content.indexOf(marker);
  const review = (idx >= 0 ? content.slice(idx + marker.length) : content).replace(/\s+/g, " ").trim();
  if (!review) throw new Error("daily memory contains no review to visualize");

  const client = new ImageGenerationClient();
  const prompt = prompts.buildDailyImagePrompt({ day, review });
  const { imageBuffer, ext } = await client.generate({ providerCfg, prompt, referenceImages: refs, signal });
  const metadata = exportImagesMeta({ store, day, imageBuffer, ext, modelName: providerCfg.modelName });
  return { ok: true, metadata };
}

module.exports = {
  ImageGenerationClient,
  exportImagesMeta,
  generateDailyImage,
  isSupportedImage,
  imageExtension,
  buildMultipart,
  buildEndpoint,
  downloadUrlDenialReason,
  MAX_IMAGE_BYTES,
};
