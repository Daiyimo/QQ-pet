// 云端模型 JSON 输出的健壮解析（全项目唯一实现）。
// 背景：模型经常不严格遵守"只返回 JSON"——会在前面带一句解释、用 markdown 围栏包裹，
// 或因 max_tokens 耗尽被截断。原先 llm.js 只做去围栏 + JSON.parse（一有前缀就抛错），
// perception/loop.js 却另写了一套"取首个 { → 尾部回退"的健壮解析，两套标准不一致。
// 现统一收敛到这里：llm.js 与 perception/loop.js 都调用本模块。
// 纯逻辑，无任何外部依赖，普通 node 可直接 require 单测。

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 尝试从模型输出里抽出第一个 JSON 对象；无法解析时返回 null（不抛错）。
// 策略（与原 parsePerceptionJson 一致）：
//   1. 去掉 markdown 围栏标记；
//   2. 从首个 "{" 起解析（跳过前置解释文字）；
//   3. 失败则退到最后一个 "}"（丢弃尾部噪声/被截断的残尾）再解析。
function tryExtractJsonObject(text) {
  const source = String(text == null ? "" : text).replace(/```json|```/g, "");
  const start = source.indexOf("{");
  if (start < 0) return null;
  const body = source.slice(start);
  try {
    const value = JSON.parse(body);
    return isPlainObject(value) ? value : null;
  } catch (e) {
    // 尾部有噪声或被截断：退到最后一个右括号再试一次（此处失败属预期，由下方兜底处理）
    const end = body.lastIndexOf("}");
    if (end > 0) {
      try {
        const value = JSON.parse(body.slice(0, end + 1));
        return isPlainObject(value) ? value : null;
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

// 严格版：解析失败即抛错（错误信息带上原文片段，便于定位模型到底返回了什么）。
function extractJsonObject(text, label = "模型") {
  const value = tryExtractJsonObject(text);
  if (!value) {
    const preview = String(text == null ? "" : text).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`${label}未返回可解析的 JSON 对象: ${preview}`);
  }
  return value;
}

module.exports = { tryExtractJsonObject, extractJsonObject, isPlainObject };
