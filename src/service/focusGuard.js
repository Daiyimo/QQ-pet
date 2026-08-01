const _require = eval("require");
const { powerMonitor } = _require("electron");
const providers = _require("./llm/providers.js");

const TICK_INTERVAL_MS = 30 * 1000;
const ACTIVE_THRESHOLD_SEC = 60;

// 深夜劝睡时段：22:00 起，到次日 04:00 前（04:00 起算清晨，不再劝）。
// 与旧实现的 `hour >= 22 || hour < 4` 判定等价，只是把两个魔法数字提成常量。
const LATE_NIGHT_START_HOUR = 22;
const LATE_NIGHT_END_HOUR = 4;
// "本晚已劝过"的持久化键（存 sys）。值是 _nightId() 生成的夜晚标识（"YYYY-MM-DD"），
// 单键覆盖写：不累积历史记录，因此无需任何清理逻辑，占用恒为一个短字符串。
// sys 不在 storeCache 的 DEBOUNCED_KEYS 里（写穿立即落盘），但本键每晚最多写一次，
// 一晚一次同步写盘的成本可忽略。
const LATE_NIGHT_SYS_KEY = "focusLateNightDoneNight";

const DEFAULTS = {
  focusEyeMin: 25,
  focusEyeCooldownMin: 20,
  sedentaryMin: 50,
  sedentaryCooldownMin: 30,
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
    // 最近一次深夜劝睡的"夜晚标识"（内存镜像，权威值在 sys[LATE_NIGHT_SYS_KEY]）。
    // 刻意**不**在 start() 里清空：用户关掉再打开专注守护、或换个开关折腾一圈，
    // 都不该换来第二次劝睡。
    this._lateNightNightId = "";
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

  /**
   * 把时刻映射成"夜晚标识"（"YYYY-MM-DD"）：
   *   · 22:00-23:59 → 当天日期
   *   · 00:00-03:59 → **前一天**日期
   * 为什么不能直接用当天日期做去重键：深夜时段跨午夜，1 月 1 日 23:50 与 1 月 2 日 00:10
   * 属于同一晚，用当天日期会落到两个不同的键 —— 等于"每晚一次"退化成"每晚两次"。
   * 前移一天后同一晚的午夜两侧共用同一个标识，跨月/跨年由 Date.setDate(-1) 自然处理。
   */
  _nightId(now) {
    const d = new Date(now.getTime());
    if (now.getHours() < LATE_NIGHT_END_HOUR) d.setDate(d.getDate() - 1);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
  }

  /** 这一晚是否已经劝过：内存镜像优先，其次读 sys（覆盖"进程重启后"的情形） */
  _lateNightDone(nightId) {
    if (this._lateNightNightId === nightId) return true;
    return getSys(LATE_NIGHT_SYS_KEY) === nightId;
  }

  _markLateNightDone(nightId) {
    // 先写内存镜像：落盘失败时至少本进程内不会反复唠叨
    this._lateNightNightId = nightId;
    if (typeof setSys !== "function") return;
    try {
      setSys({ name: LATE_NIGHT_SYS_KEY, value: nightId });
    } catch (e) {
      console.error(
        "[focusGuard] 深夜劝睡去重标记落盘失败，本晚去重降级为仅本进程内存生效（重启后可能再劝一次）:",
        e && e.stack ? e.stack : e
      );
    }
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

      const now = new Date();
      const hour = now.getHours();
      if (
        getSys("focusLateNightReminder") &&
        (hour >= LATE_NIGHT_START_HOUR || hour < LATE_NIGHT_END_HOUR)
      ) {
        // 每晚只劝一次（产品决策）：去重键是"夜晚标识"而不是自然日，也不再用时间冷却
        // ——熬到 4 点被劝 6 次是原实现的真实行为，冷却只能控制间隔、控不了总次数。
        const nightId = this._nightId(now);
        if (!this._lateNightDone(nightId)) {
          this._markLateNightDone(nightId);
          this._fireReminder("lateNight", { hour });
        }
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
