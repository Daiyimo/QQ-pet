// 多轮 AI 对话管理：移植 jarvis orchestrator/service.py 的 pet_chat 逻辑。
// 历史 deque=4 轮，user 截 1000 字符、assistant 截 1500 字符，并发锁同时只一轮。
// 已删除 jarvis 本地模型的 <|/__END_OF_TURN__ 清洗（云端模型不需要）。
const _require = eval("require");
const providers = _require("./providers.js");
const prompts = _require("./prompts.js");

const MAX_HISTORY_ROUNDS = 4;
const USER_HISTORY_LIMIT = 1000;
const ASSISTANT_HISTORY_LIMIT = 1500;
const MAX_INPUT_LEN = 2000;
const MAX_REPLY_LEN = 4000;
const CHAT_TIMEOUT_MS = 60000;

function getPetInfoSafe() {
  try {
    return typeof getPetInfo === "function" ? getPetInfo() : {};
  } catch (e) {
    console.error(
      "[llm/chat] 读取宠物信息失败，按空信息组装人设:",
      e && e.stack ? e.stack : e
    );
    return {};
  }
}

class PetChatService {
  constructor() {
    this._history = []; // [{user, assistant}]，最多 4 轮（deque 语义）
    this._busy = false; // 并发锁：同时只处理一轮
  }

  // userText: 用户本轮输入；withScreen 时由调用方传入 screenshot（PNG/JPEG Buffer 或 base64）
  async sendMessage(userText, { withScreen = false, screenshot = null } = {}) {
    const cleaned = String(userText || "").trim();
    if (!cleaned) throw new Error("消息不能为空");
    if (cleaned.length > MAX_INPUT_LEN) {
      throw new Error(`消息太长啦，请控制在 ${MAX_INPUT_LEN} 字以内`);
    }
    if (this._busy) throw new Error("企鹅正在思考中，请稍等片刻再发~");
    this._busy = true;
    try {
      const providerCfg = providers.getChatProvider();
      if (!providerCfg) {
        throw new Error("尚未配置 LLM 提供商，请先在设置中添加");
      }
      // 组装 messages：system 人设 + 历史（超限保留尾部，与 jarvis 的截断上限一致）+ 本轮
      const messages = [
        { role: "system", content: prompts.buildPetChatSystemPrompt(getPetInfoSafe()) },
      ];
      for (const turn of this._history) {
        messages.push({ role: "user", content: turn.user.slice(-USER_HISTORY_LIMIT) });
        messages.push({
          role: "assistant",
          content: turn.assistant.slice(-ASSISTANT_HISTORY_LIMIT),
        });
      }
      messages.push({ role: "user", content: cleaned });

      const images = withScreen && screenshot ? [screenshot] : undefined;
      let reply = await providers.chat({
        providerCfg,
        messages,
        images,
        maxTokens: 800,
        temperature: 0.8,
        timeoutMs: CHAT_TIMEOUT_MS,
      });
      reply = String(reply || "").trim().slice(0, MAX_REPLY_LEN);
      if (!reply) throw new Error("模型返回了空回复");

      this._history.push({ user: cleaned, assistant: reply });
      while (this._history.length > MAX_HISTORY_ROUNDS) this._history.shift();
      return reply;
    } finally {
      this._busy = false;
    }
  }

  clearHistory() {
    this._history = [];
  }
}

const petChat = new PetChatService();
global.petChat = petChat;
module.exports = { PetChatService, petChat };
