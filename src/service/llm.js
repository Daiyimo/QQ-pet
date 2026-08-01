const _require = eval("require");
const providers = _require("./llm/providers.js");
const { extractJsonObject } = _require("./llm/jsonParse.js");

const DEFAULT_MODEL = "deepseek-chat";
const LEGACY_BASE_URL = "https://api.deepseek.com/v1";
const MAX_QUEUE = 3;
// 台词链超时：原值 8000 与本文件的 512 max_tokens 预算自相矛盾——512 的依据正是
// "推理模型的 thinking 也吃输出额度"，而推理模型 8 秒内几乎出不完 thinking + 正文，
// 结果是服务端已生成并计费、客户端一律掐断降级。取 30000 与 llm/providers.js 的
// DEFAULT_TIMEOUT_MS、perception/loop.js 的感知超时同值（不引入第三个量级）：
// 台词是预取/异步、失败即离线兜底，不阻塞 UI；且 _pending 互斥保证同一 tolkName
// 最多一条在途，拉长超时不会堆积请求。
const TIMEOUT_MS = 30000;
// 台词字段长度上限：提示词要求 tolk ≤15 字、submitText ≤5 字，这里留约 3~4 倍余量
// 只兜住"模型跑飞写出长篇"，正常输出不会被截。气泡正文与按钮宽度都有限。
const MAX_TOLK_LEN = 60;
const MAX_SUBMIT_LEN = 10;

// —— 连续失败退避（Key 失效 / 欠费 / 断网时的止损）——
// 此前无退避：待机、喂食、清洁、升级、上线每个触发点都各打一次请求，每次刷一条完整堆栈。
// 阈值 3 与 perception/loop.js 的 PERCEPTION_FAILURE_NOTIFY_THRESHOLD 同值：
// 足以滤掉单次网络抖动，又能快速识别"必然失败"的配置错误。
const FAILURE_THRESHOLD = 3;
// 冷却 5 分钟：用户发现台词变离线 → 打开设置页改配置的典型耗时量级；
// 冷却到期后放一次请求探活（不清零计数），恢复后首次成功即完全复位，无需重启。
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
// 日志节流，与 loop.js 的 PERCEPTION_FAILURE_LOG_EVERY 同值：首次 + 进入冷却时各一条，
// 之后每 10 次一条（配合 5 分钟冷却≈每 50 分钟一条，足够确认故障仍在持续又不刷屏）。
const FAILURE_LOG_EVERY = 10;

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

// 台词字段归一化：模型偶发把本该是字符串的字段写成 {"text":"…"} 或 ["…"]
// （temperature 0.9 + 15 字硬约束下确实会发生），String() 会得到 "[object Object]"
// 并被调用方直接塞进气泡正文 / 按钮文案。与 perception/loop.js 的 str() 同口径
// （对象/数组一律判空 + trim + 限长）；那里的弹幕曾因此上屏，本文件当时漏改。
// 说明：本函数没有做成 llm/jsonParse.js 里的共用导出（那才是两处该共用的落点），
// 原因是本次改动被限定在 llm.js / providers.js 内，见交付说明。
function normSpeakField(value, limit) {
  if (value == null) return "";
  if (typeof value === "object") return "";
  return String(value).trim().slice(0, limit);
}

// 走统一提供商层发起单轮对话，并解析 {tolk,submitText} JSON 契约。
// 解析走 llm/jsonParse.js 的健壮实现（模型带前置解释文字 / markdown 围栏 / 被截断都能救回），
// 与 perception/loop.js 共用同一套标准。
// 解析出的字段还要过一层类型/长度归一：tolk 归一后为空即视为本次生成失败（抛错 → 调用方
// 走离线兜底），submitText 归一后为空则交给调用方既有的 `|| "嗯"` 兜底——
// 只是按钮文案缺失，没必要让整条台词作废。
function callLLM(providerCfg, messages) {
  return providers
    .chat({
      providerCfg,
      messages,
      maxTokens: 512, // 推理模型的 thinking 会消耗输出额度，需留足预算（台词本身仍很短）
      temperature: 0.9,
      timeoutMs: TIMEOUT_MS,
    })
    .then((content) => {
      const raw = extractJsonObject(content, "台词模型");
      const tolk = normSpeakField(raw.tolk, MAX_TOLK_LEN);
      if (!tolk) {
        throw new Error(
          "台词模型的 tolk 字段不是非空字符串: " +
            JSON.stringify(raw).slice(0, 200)
        );
      }
      return {
        ...raw,
        tolk,
        submitText: normSpeakField(raw.submitText, MAX_SUBMIT_LEN),
      };
    });
}

class LLMService {
  _queues = {};
  _pending = {};
  // 连续失败计数与冷却截止时间戳（0 表示未冷却）；跨 tolkName/promptType 共享，
  // 因为主因（Key 失效 / 欠费 / 断网）是全局的，按触发点分别计数只会把请求数乘以触发点数量。
  _failCount = 0;
  _cooldownUntil = 0;

  _inCooldown() {
    return this._cooldownUntil > Date.now();
  }

  _noteSuccess() {
    this._failCount = 0;
    this._cooldownUntil = 0;
  }

  // 失败记账 + 日志节流。降级行为不变（调用方继续用离线台词），
  // 只是不再每次都刷一条完整堆栈，并在连续失败达阈值后停止发请求。
  _noteFailure(label, e) {
    this._failCount += 1;
    const n = this._failCount;
    const entering = n === FAILURE_THRESHOLD;
    if (n >= FAILURE_THRESHOLD) {
      this._cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    }
    if (n === 1 || entering || n % FAILURE_LOG_EVERY === 0) {
      console.error(
        `[llm] ${label}失败（连续第 ${n} 次${
          entering
            ? `，已进入 ${FAILURE_COOLDOWN_MS / 60000} 分钟冷却，期间直接用离线台词`
            : ""
        }），已降级为离线台词:`,
        e && e.stack ? e.stack : e
      );
    }
  }

  dequeue(tolkName) {
    return this._queues[tolkName]?.shift() || null;
  }

  prefetch(tolkName, petInfo) {
    if (!getSys("llmEnabled")) return;
    const providerCfg = resolveProvider();
    if (!providerCfg) return;
    if (this._inCooldown()) return;
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
        this._noteSuccess();
      })
      .catch((e) => {
        // 降级行为不变（本次预取作废，调用方继续用离线台词）；
        // Key 失效 / 欠费 / 断网 / 模型返回非 JSON 都在这里，日志与冷却统一由 _noteFailure 管
        this._noteFailure(`台词预取（tolkName=${tolkName}）`, e);
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
    if (this._inCooldown()) return Promise.resolve(null);
    const builder = DYNAMIC_PROMPTS[promptType];
    const userPrompt = builder
      ? builder(contextData)
      : USER_PROMPTS[promptType];
    if (!userPrompt) return Promise.resolve(null);
    return callLLM(providerCfg, [
      { role: "system", content: SYSTEM_PROMPT(petInfo) },
      { role: "user", content: userPrompt },
    ])
      .then((r) => {
        if (!r?.tolk) return null;
        this._noteSuccess();
        return r;
      })
      .catch((e) => {
        // 降级为 null（调用方走离线兜底台词）；日志与冷却统一由 _noteFailure 管
        this._noteFailure(`台词生成（promptType=${promptType}）`, e);
        return null;
      });
  }
}

global.llmService = new LLMService();
global.LLM_MAX_CLIPBOARD_LEN = MAX_CLIPBOARD_LEN;
// 以下仅暴露给单元测试（校验提示词量纲/字段归一/退避常量），生产代码不要引用
module.exports = {
  __SYSTEM_PROMPT: SYSTEM_PROMPT,
  __LLMService: LLMService,
  __normSpeakField: normSpeakField,
  __TIMEOUT_MS: TIMEOUT_MS,
  __MAX_TOLK_LEN: MAX_TOLK_LEN,
  __MAX_SUBMIT_LEN: MAX_SUBMIT_LEN,
  __FAILURE_THRESHOLD: FAILURE_THRESHOLD,
  __FAILURE_COOLDOWN_MS: FAILURE_COOLDOWN_MS,
  __FAILURE_LOG_EVERY: FAILURE_LOG_EVERY,
};
