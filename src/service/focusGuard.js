const _require = eval("require");
const { powerMonitor } = _require("electron");
const providers = _require("./llm/providers.js");

const TICK_INTERVAL_MS = 30 * 1000;
const ACTIVE_THRESHOLD_SEC = 60;

const DEFAULTS = {
  focusEyeMin: 25,
  focusEyeCooldownMin: 20,
  sedentaryMin: 50,
  sedentaryCooldownMin: 30,
  lateNightCooldownMin: 60,
  welcomeBackThresholdMin: 15,
  welcomeBackCooldownMin: 30,
  activeResetIdleMin: 5,
  sedentaryResetIdleMin: 10,
};

const FALLBACK_TEXT = {
  focusEye: "主人，眼睛已经盯屏 25 分钟啦，远眺一下吧~",
  sedentary: "主人，坐了好久了，起来活动活动吧！",
  lateNight: "主人，这么晚了，早点睡哦~",
  welcomeBack: "主人回来啦~欢迎欢迎！",
};

class FocusGuard {
  constructor() {
    this.timer = null;
    this.lastIdleSec = 0;
    this.continuousActiveSec = 0;
    this.continuousSedentarySec = 0;
    this.lastReminders = {};
    // 每次 start()/stop() 自增：_fireReminder 里在途的 LLM 台词靠它判断"自己是否已过期"
    this._epoch = 0;
  }

  start() {
    if (this.timer) return;
    this._epoch += 1;
    this.lastIdleSec = 0;
    this.continuousActiveSec = 0;
    this.continuousSedentarySec = 0;
    this.lastReminders = {};
    this.timer = setInterval(() => {
      try {
        this._tick();
      } catch (e) {
        // 巡检异常不能让定时器静默失效：降级为跳过本轮，但必须留完整堆栈
        console.error("[focusGuard] 巡检 tick 异常，跳过本轮:", e && e.stack ? e.stack : e);
      }
    }, TICK_INTERVAL_MS);
    // 与 aiWiring / courses.manager / perception.loop 的定时器一致：护眼巡检是"可丢弃"的
    // 提醒链（丢一轮只是少一次提醒，无数据损失），不得让退出时多等一个 30s 周期。
    // 与 storeCache 的落盘定时器不同——那条刻意不 unref 是为了保住玩家进度。
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this._epoch += 1;
    }
  }

  _canRemind(type, cooldownSec) {
    const now = Date.now();
    const last = this.lastReminders[type] || 0;
    return now - last >= cooldownSec * 1000;
  }

  _markReminded(type) {
    this.lastReminders[type] = Date.now();
  }

  _tick() {
    if (!getSys("focusEnabled")) return;
    if (typeof powerMonitor?.getSystemIdleTime !== "function") return;
    if (typeof openSpeak !== "function") return;

    const idleSec = powerMonitor.getSystemIdleTime();
    const isActive = idleSec < ACTIVE_THRESHOLD_SEC;
    const wasActive = this.lastIdleSec < ACTIVE_THRESHOLD_SEC;
    const tickSec = TICK_INTERVAL_MS / 1000;

    if (isActive) {
      if (!wasActive) {
        const awaySec = this.lastIdleSec;
        if (awaySec > DEFAULTS.activeResetIdleMin * 60) {
          this.continuousActiveSec = 0;
        }
        if (awaySec > DEFAULTS.sedentaryResetIdleMin * 60) {
          this.continuousSedentarySec = 0;
        }
        if (
          awaySec > DEFAULTS.welcomeBackThresholdMin * 60 &&
          getSys("focusWelcomeBack") &&
          this._canRemind(
            "welcomeBack",
            DEFAULTS.welcomeBackCooldownMin * 60
          )
        ) {
          this._fireReminder("welcomeBack", {
            awayMin: Math.floor(awaySec / 60),
          });
        }
      }
      this.continuousActiveSec += tickSec;
      this.continuousSedentarySec += tickSec;

      if (
        getSys("focusEyeReminder") &&
        this.continuousActiveSec >= DEFAULTS.focusEyeMin * 60 &&
        this._canRemind("focusEye", DEFAULTS.focusEyeCooldownMin * 60)
      ) {
        this._fireReminder("focusEye", {
          activeMin: Math.floor(this.continuousActiveSec / 60),
        });
        this.continuousActiveSec = 0;
      }

      if (
        getSys("focusSedentaryReminder") &&
        this.continuousSedentarySec >= DEFAULTS.sedentaryMin * 60 &&
        this._canRemind("sedentary", DEFAULTS.sedentaryCooldownMin * 60)
      ) {
        this._fireReminder("sedentary", {
          sedentaryMin: Math.floor(this.continuousSedentarySec / 60),
        });
        this.continuousSedentarySec = 0;
      }

      const hour = new Date().getHours();
      if (
        getSys("focusLateNightReminder") &&
        (hour >= 22 || hour < 4) &&
        this._canRemind("lateNight", DEFAULTS.lateNightCooldownMin * 60)
      ) {
        this._fireReminder("lateNight", { hour });
      }
    } else {
      if (idleSec > DEFAULTS.activeResetIdleMin * 60) {
        this.continuousActiveSec = 0;
      }
      if (idleSec > DEFAULTS.sedentaryResetIdleMin * 60) {
        this.continuousSedentarySec = 0;
      }
    }

    this.lastIdleSec = idleSec;
  }

  _fireReminder(type, ctx) {
    this._markReminded(type);
    const epoch = this._epoch;

    // 尊重"启用 AI 对话"总开关（llmEnabled，默认关）；开启后需已配置可用的云端服务商。
    // 旧的明文 llmApiKey 由 providers 层一次性迁移为加密提供商，这里不再直接读明文键。
    const useLLM =
      typeof llmService !== "undefined" &&
      getSys("llmEnabled") &&
      providers.hasChatProvider();

    const showFallback = () => {
      const txt = FALLBACK_TEXT[type] || "主人~";
      openSpeak({
        data: { type: "text", data: txt, submitText: "好的" },
        nextActiveStr: "speak",
      });
    };

    if (!useLLM) {
      showFallback();
      return;
    }

    let petInfo = {};
    try {
      petInfo = typeof getPetInfo === "function" ? getPetInfo() : {};
    } catch (e) {
      console.error(
        "[focusGuard] 读取宠物信息失败，按空信息生成台词:",
        e && e.stack ? e.stack : e
      );
    }

    llmService
      .generateOnce(type, ctx, petInfo)
      .then((r) => {
        // stop() 已发生（用户关了专注守护 / 正在退出）：在途台词不得再弹气泡，
        // 否则关掉开关后仍会冒出一条"迟到"的提醒，与 perception/loop.js 同类问题。
        if (epoch !== this._epoch) return;
        if (r?.tolk) {
          openSpeak({
            data: {
              type: "text",
              data: r.tolk,
              submitText: r.submitText || "好的",
            },
            nextActiveStr: "speak",
          });
        } else {
          showFallback();
        }
      })
      .catch((e) => {
        // generateOnce 内部已记日志，这里补记"提醒降级为离线文案"的上下文
        console.error(
          `[focusGuard] ${type} 提醒的 AI 台词生成失败，改用离线文案:`,
          e && e.stack ? e.stack : e
        );
        if (epoch !== this._epoch) return;
        showFallback();
      });
  }
}

global.focusGuard = new FocusGuard();
module.exports = {};
