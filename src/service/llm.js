const _require = eval("require");
const providers = _require("./llm/providers.js");
const { extractJsonObject } = _require("./llm/jsonParse.js");

const DEFAULT_MODEL = "deepseek-chat";
const LEGACY_BASE_URL = "https://api.deepseek.com/v1";
const MAX_QUEUE = 3;
const TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = (petInfo) => {
  const info = petInfo?.info || {};
  const maxInfo = petInfo?.maxInfo || {};
  return (
    `你是主人「${info.host || "主人"}」的桌宠，名叫「${info.name || "宠物"}」，是一只可爱的企鹅。` +
    `说话风格：活泼可爱，句子15字以内，用第一人称，偶尔提到主人名字。` +
    `当前状态：心情${info.mood || 0}/1000，等级${maxInfo.level || 1}，健康${info.health || 5}/5。` +
    `只回复JSON，格式：{"tolk":"宠物说的话（15字内）","submitText":"主人回应（5字内）"}`
  );
};

const USER_PROMPTS = {
  smallTalk: "宠物在日常闲聊，说一句有趣的生活感悟或小抱怨。",
  toHeartTolk: "主人刚刚摸了摸宠物，宠物感受到互动，说一句温暖的撒娇话。",
};

const MAX_CLIPBOARD_LEN = 500;
const DYNAMIC_PROMPTS = {
  clipboardText: (text) =>
    `主人刚刚复制了一段内容：\n"""\n${text}\n"""\n` +
    `请简短俏皮地评论一下这段内容是什么（如代码/邮件/链接/聊天/数字等），或鼓励主人。不要复述原文。`,
  godMode: () =>
    `主人刚刚按了"上帝模式"快捷键（Ctrl+方向键），俏皮回应他这个神秘按键，可以装作收到了神秘信号。`,
  enter: (ctx) =>
    `现在是${ctx.timeStr}，距上次见面${ctx.intervalStr}。说一句温暖的入场问候，` +
    `要带上主人称呼，体现时间和间隔感（凌晨提醒早睡、深夜关心、白天精神等）。`,
  stateEat: (ctx) =>
    `宠物饥饿值剩 ${ctx.percent}%（${ctx.value}/${ctx.max}）。` +
    `${ctx.percent < 20 ? "已经很饿了" : ctx.percent < 50 ? "有点饿" : "稍微饿"}，` +
    `说一句撒娇求吃的话，体现具体饥饿程度。`,
  stateClean: (ctx) =>
    `宠物清洁值剩 ${ctx.percent}%（${ctx.value}/${ctx.max}）。` +
    `${ctx.percent < 20 ? "已经很脏了" : ctx.percent < 50 ? "有点脏" : "稍微脏"}，` +
    `说一句求洗澡的话，体现脏污程度。`,
  levUp: (ctx) =>
    `宠物刚升级到 ${ctx.level} 级（${ctx.ageStage}阶段）！` +
    `说一句开心炫耀的话，体现里程碑感。`,
  focusEye: (ctx) =>
    `主人已经连续盯屏 ${ctx.activeMin} 分钟了。说一句关心眼睛的话，` +
    `提醒远眺或休息，要温暖不说教。`,
  sedentary: (ctx) =>
    `主人坐着不动已经 ${ctx.sedentaryMin} 分钟了。` +
    `说一句催促起身活动的话，可以撒娇或调皮，但要有真切的关心。`,
  lateNight: (ctx) =>
    `现在是${ctx.hour}点，深夜了主人还在工作。` +
    `说一句劝主人早睡的话，要心疼但不啰嗦。`,
  welcomeBack: (ctx) =>
    `主人离开 ${ctx.awayMin} 分钟后刚刚回来。` +
    `说一句开心的欢迎话，体现想念感和久别重逢。`,
};

// 解析当前生效的提供商：统一走 providers 层。
// 旧的明文 llmApiKey/llmModel 配置由 providers.getChatProvider() 内部一次性迁移为
// 加密的 legacy-deepseek 提供商，因此这里不再直接读明文键，老配置依旧不失效。
function resolveProvider() {
  return providers.getChatProvider();
}

// 走统一提供商层发起单轮对话，并解析 {tolk,submitText} JSON 契约。
// 解析走 llm/jsonParse.js 的健壮实现（模型带前置解释文字 / markdown 围栏 / 被截断都能救回），
// 与 perception/loop.js 共用同一套标准。
function callLLM(providerCfg, messages) {
  return providers
    .chat({
      providerCfg,
      messages,
      maxTokens: 512, // 推理模型的 thinking 会消耗输出额度，需留足预算（台词本身仍很短）
      temperature: 0.9,
      timeoutMs: TIMEOUT_MS,
    })
    .then((content) => extractJsonObject(content, "台词模型"));
}

class LLMService {
  _queues = {};
  _pending = {};

  dequeue(tolkName) {
    return this._queues[tolkName]?.shift() || null;
  }

  prefetch(tolkName, petInfo) {
    if (!getSys("llmEnabled")) return;
    const providerCfg = resolveProvider();
    if (!providerCfg) return;
    if (!this._queues[tolkName]) this._queues[tolkName] = [];
    if (this._queues[tolkName].length >= MAX_QUEUE || this._pending[tolkName]) return;
    this._pending[tolkName] = true;
    const prompt = USER_PROMPTS[tolkName] || USER_PROMPTS.smallTalk;
    callLLM(providerCfg, [
      { role: "system", content: SYSTEM_PROMPT(petInfo) },
      { role: "user", content: prompt },
    ])
      .then((r) => {
        if (r?.tolk) this._queues[tolkName].push(r);
      })
      .catch((e) => {
        // 降级行为不变（本次预取作废，调用方继续用离线台词），但必须留下完整堆栈：
        // Key 失效 / 欠费 / 断网 / 模型返回非 JSON 都在这里，静默吞掉会让问题不可观测
        console.error(
          `[llm] 台词预取失败（tolkName=${tolkName}），本次跳过:`,
          e && e.stack ? e.stack : e
        );
      })
      .finally(() => {
        this._pending[tolkName] = false;
      });
  }

  // 适配新提供商层：传入 apiKey 时构造临时提供商做连通性测试（旧设置页用法），
  // 地址/模型沿用当前生效提供商（不再读旧的明文 llmBaseUrl/llmModel 键）；
  // 不传时测试当前生效的提供商。返回 Promise<boolean>。
  test(apiKey, petInfo) {
    const active = resolveProvider();
    const providerCfg = apiKey
      ? {
          id: "test",
          type: active?.type || "openai",
          baseUrl: active?.baseUrl || LEGACY_BASE_URL,
          apiKey,
          model: active?.model || DEFAULT_MODEL,
        }
      : active;
    if (!providerCfg) return Promise.resolve(false);
    return providers
      .testProvider(providerCfg)
      .then((r) => {
        // testProvider 自己不抛错，失败信息在 r.error 里，同样要落日志
        if (!r || !r.ok) {
          console.error(
            "[llm] 连通性测试未通过:",
            (r && r.error) || "provider returned no result"
          );
        }
        return !!r?.ok;
      })
      .catch((e) => {
        console.error(
          "[llm] 连通性测试异常，按失败处理:",
          e && e.stack ? e.stack : e
        );
        return false;
      });
  }

  generateOnce(promptType, contextData, petInfo) {
    if (!getSys("llmEnabled")) return Promise.resolve(null);
    const providerCfg = resolveProvider();
    if (!providerCfg) return Promise.resolve(null);
    const builder = DYNAMIC_PROMPTS[promptType];
    const userPrompt = builder
      ? builder(contextData)
      : USER_PROMPTS[promptType];
    if (!userPrompt) return Promise.resolve(null);
    return callLLM(providerCfg, [
      { role: "system", content: SYSTEM_PROMPT(petInfo) },
      { role: "user", content: userPrompt },
    ])
      .then((r) => (r?.tolk ? r : null))
      .catch((e) => {
        // 降级为 null（调用方走离线兜底台词），但必须留完整堆栈
        console.error(
          `[llm] 台词生成失败（promptType=${promptType}），已降级为离线台词:`,
          e && e.stack ? e.stack : e
        );
        return null;
      });
  }
}

global.llmService = new LLMService();
global.LLM_MAX_CLIPBOARD_LEN = MAX_CLIPBOARD_LEN;
// SYSTEM_PROMPT 仅暴露给单元测试校验量纲/字段（生产代码不要引用）
module.exports = { __SYSTEM_PROMPT: SYSTEM_PROMPT };
