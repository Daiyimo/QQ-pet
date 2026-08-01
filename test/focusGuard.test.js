// src/service/focusGuard.js 的提醒状态机测试（此前零覆盖）。
//
// focusGuard 是一台完整的多状态提醒机：护眼 / 久坐 / 深夜劝睡 / 久别问候四类，
// 各自有阈值 + 冷却 + 清零规则，全部由 30s 巡检驱动。纯逻辑、分支密集、边界明确。
//
// 注入方式（不改生产结构）：
//   · electron 的 powerMonitor 与 ./llm/providers.js 走 Module.prototype.require 拦截
//     （focusGuard 内部是 eval("require")，与 test/rootListen.test.js、
//      test/captureLazyPng.test.js 同一套桩法），纯 node 下可跑、不碰 Electron；
//   · getSys / openSpeak / llmService / getPetInfo 本来就是生产用的全局注入点；
//   · 时间全部走假时钟（替换 globalThis.Date），零 sleep、零真实等待。
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// 允许把被测源码指向别处，仅用于变异自证时加载临时副本；正常跑用仓库里的真源码。
const FOCUS_PATH = require.resolve("../src/service/focusGuard.js");

// 与 focusGuard.js 里的 TICK_INTERVAL_MS / ACTIVE_THRESHOLD_SEC 对应；
// 这里刻意写死数值，源码把 30s 巡检或 60s 活跃判定改掉就必须来改测试。
const TICK_SEC = 30;
const ACTIVE_THRESHOLD_SEC = 60;
// 四类提醒的离线兜底文案（源码 FALLBACK_TEXT 的副本，用来精确断言到底弹的是哪一类）
const FALLBACK = {
  focusEye: "主人，眼睛已经盯屏 25 分钟啦，远眺一下吧~",
  sedentary: "主人，坐了好久了，起来活动活动吧！",
  lateNight: "主人，这么晚了，早点睡哦~",
  welcomeBack: "主人回来啦~欢迎欢迎！",
};

// 2026-08-01 10:00:00 本地时间：白天，保证深夜劝睡不会混进其他用例
const DAYTIME = new Date(2026, 7, 1, 10, 0, 0).getTime();
const at = (hour, minute = 0, day = 1) =>
  new Date(2026, 7, day, hour, minute, 0).getTime();

/** 假 Date：new Date() 与 Date.now() 都读 clock.now，其余用法保持原生行为 */
function installClock(clock) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() {
      return clock.now;
    }
  }
  globalThis.Date = FakeDate;
  return () => {
    globalThis.Date = RealDate;
  };
}

/**
 * 载入一份全新的 focusGuard 实例，并接好全部注入点。
 * 返回的 env 是本次用例的"世界"：改 env.idleSec 就是改系统空闲时间，
 * env.speaks 是气泡流水，env.clock.now 是当前时刻。
 */
function makeEnv(opts = {}) {
  const env = {
    idleSec: 0,
    hasChatProvider: false,
    speaks: [],
    llmCalls: [],
    errors: [],
    clock: { now: opts.now === undefined ? DAYTIME : opts.now },
    sys: {
      focusEnabled: true,
      focusEyeReminder: true,
      focusSedentaryReminder: true,
      focusLateNightReminder: true,
      focusWelcomeBack: true,
      llmEnabled: false,
      ...(opts.sys || {}),
    },
  };

  const electron = {
    powerMonitor: { getSystemIdleTime: () => env.idleSec },
  };
  const providers = { hasChatProvider: () => env.hasChatProvider };

  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "electron") return electron;
    if (id === "./llm/providers.js") return providers;
    return origRequire.apply(this, arguments);
  };
  try {
    delete require.cache[FOCUS_PATH];
    require(FOCUS_PATH);
  } finally {
    Module.prototype.require = origRequire;
  }
  env.guard = global.focusGuard;

  const saved = {
    getSys: global.getSys,
    openSpeak: global.openSpeak,
    llmService: global.llmService,
    getPetInfo: global.getPetInfo,
    error: console.error,
  };
  global.getSys = (k) => env.sys[k];
  global.openSpeak = (payload) => env.speaks.push(payload);
  global.getPetInfo = () => ({ info: { name: "小狗" } });
  console.error = (...args) => env.errors.push(args.join(" "));
  const restoreClock = installClock(env.clock);

  env.restore = () => {
    restoreClock();
    console.error = saved.error;
    global.getSys = saved.getSys;
    global.openSpeak = saved.openSpeak;
    global.getPetInfo = saved.getPetInfo;
    if (saved.llmService === undefined) delete global.llmService;
    else global.llmService = saved.llmService;
    env.guard.stop();
    delete require.cache[FOCUS_PATH];
  };

  // 接 LLM：拦下 generateOnce 的入参，台词由 responder 决定
  env.useLLM = (responder) => {
    env.sys.llmEnabled = true;
    env.hasChatProvider = true;
    global.llmService = {
      generateOnce: (type, ctx, petInfo) => {
        env.llmCalls.push({ type, ctx, petInfo });
        return responder(type, ctx, petInfo);
      },
    };
  };

  // 走 n 轮巡检，每轮把假时钟推进 30s（与真实巡检周期一致）
  env.tick = (idleSec, times = 1) => {
    for (let i = 0; i < times; i++) {
      env.idleSec = idleSec;
      env.guard._tick();
      env.clock.now += TICK_SEC * 1000;
    }
  };
  env.texts = () => env.speaks.map((s) => s.data.data);
  return env;
}

/** 每个用例都在独立 env 里跑，收尾一定还原全局 */
function withEnv(opts, fn) {
  const env = makeEnv(opts);
  try {
    return fn(env);
  } finally {
    env.restore();
  }
}
async function withEnvAsync(opts, fn) {
  const env = makeEnv(opts);
  try {
    return await fn(env);
  } finally {
    env.restore();
  }
}
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- 正常路径

test("护眼提醒：连续活跃满 25 分钟弹一次护眼气泡", () => {
  withEnv({}, (env) => {
    env.tick(0, 49); // 49 轮 = 24.5 分钟
    assert.deepEqual(env.texts(), []);
    env.tick(0, 1); // 第 50 轮凑满 25 分钟
    assert.deepEqual(env.texts(), [FALLBACK.focusEye]);
    assert.equal(env.speaks[0].nextActiveStr, "speak");
    assert.equal(env.speaks[0].data.submitText, "好的");
  });
});

test("久坐提醒：连续活跃 50 分钟触发，且护眼计时与久坐计时各自独立", () => {
  withEnv({}, (env) => {
    env.tick(0, 100); // 50 分钟：护眼在第 50、100 轮各一次，久坐在第 100 轮一次
    assert.deepEqual(env.texts(), [
      FALLBACK.focusEye,
      FALLBACK.focusEye,
      FALLBACK.sedentary,
    ]);
  });
});

// ------------------------------------------------------------------ 边界

test("护眼阈值边界：差 1 毫秒不提醒，刚好满 25 分钟才提醒", () => {
  withEnv({}, (env) => {
    env.guard.continuousActiveSec = 25 * 60 - TICK_SEC - 0.001;
    env.tick(0, 1); // 累计 1499.999s
    assert.deepEqual(env.texts(), []);
    env.guard.continuousActiveSec = 25 * 60 - TICK_SEC;
    env.tick(0, 1); // 累计 1500s，正好等于阈值
    assert.deepEqual(env.texts(), [FALLBACK.focusEye]);
  });
});

test("久坐阈值边界：差 1 毫秒不提醒，刚好满 50 分钟才提醒", () => {
  withEnv({ sys: { focusEyeReminder: false } }, (env) => {
    env.guard.continuousSedentarySec = 50 * 60 - TICK_SEC - 0.001;
    env.tick(0, 1);
    assert.deepEqual(env.texts(), []);
    env.guard.continuousSedentarySec = 50 * 60 - TICK_SEC;
    env.tick(0, 1);
    assert.deepEqual(env.texts(), [FALLBACK.sedentary]);
  });
});

test("深夜劝睡时段边界：21:59 不劝，22:00 开始劝", () => {
  const onlyLateNight = {
    sys: { focusEyeReminder: false, focusSedentaryReminder: false },
  };
  withEnv({ ...onlyLateNight, now: at(21, 59) }, (env) => {
    env.tick(0, 1);
    assert.deepEqual(env.texts(), []);
  });
  withEnv({ ...onlyLateNight, now: at(22, 0) }, (env) => {
    env.tick(0, 1);
    assert.deepEqual(env.texts(), [FALLBACK.lateNight]);
  });
});

test("深夜劝睡时段边界：次日 01:00 仍劝，04:00 起不再劝", () => {
  const onlyLateNight = {
    sys: { focusEyeReminder: false, focusSedentaryReminder: false },
  };
  withEnv({ ...onlyLateNight, now: at(1, 0, 2) }, (env) => {
    env.tick(0, 1);
    assert.deepEqual(env.texts(), [FALLBACK.lateNight]);
  });
  withEnv({ ...onlyLateNight, now: at(4, 0, 2) }, (env) => {
    env.tick(0, 1);
    assert.deepEqual(env.texts(), []);
  });
});

test("久别问候边界：离开正好 15 分钟不算久别，超过 15 分钟才问候", () => {
  withEnv({}, (env) => {
    env.tick(15 * 60, 1); // 空闲 900s：判定为不活跃
    env.tick(0, 1); // 回来了，awaySec === 900，不超过阈值
    assert.deepEqual(env.texts(), []);

    env.tick(15 * 60 + 1, 1); // 空闲 901s
    env.tick(0, 1); // 回来了，超过阈值 1 秒
    assert.deepEqual(env.texts(), [FALLBACK.welcomeBack]);
  });
});

test("活跃判定边界：空闲 59 秒仍算活跃并继续累计，60 秒起算离开", () => {
  withEnv({}, (env) => {
    env.tick(ACTIVE_THRESHOLD_SEC - 1, 2);
    assert.equal(env.guard.continuousActiveSec, 2 * TICK_SEC);
    env.tick(ACTIVE_THRESHOLD_SEC, 1); // 恰好 60s：不再算活跃，计时停住
    assert.equal(env.guard.continuousActiveSec, 2 * TICK_SEC);
  });
});

// ---------------------------------------------------------------- 错误路径

test("AI 台词生成失败时降级为离线文案，并记录带堆栈的错误日志", async () => {
  await withEnvAsync({}, async (env) => {
    env.useLLM(() => Promise.reject(new Error("provider 502")));
    env.guard.continuousActiveSec = 25 * 60 - TICK_SEC;
    env.tick(0, 1);
    assert.deepEqual(env.texts(), []); // 台词在途，还没弹
    await flush();
    assert.deepEqual(env.texts(), [FALLBACK.focusEye]);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /\[focusGuard\] focusEye .*失败.*离线文案/);
    assert.match(env.errors[0], /provider 502/);
  });
});

test("AI 返回空台词时降级为离线文案，不弹空气泡", async () => {
  await withEnvAsync({}, async (env) => {
    env.useLLM(() => Promise.resolve({ tolk: "" }));
    env.guard.continuousActiveSec = 25 * 60 - TICK_SEC;
    env.tick(0, 1);
    await flush();
    assert.deepEqual(env.texts(), [FALLBACK.focusEye]);
    assert.deepEqual(env.errors, []);
  });
});

test("AI 台词可用时弹 AI 文案，并把提醒类型与上下文原样交给 generateOnce", async () => {
  await withEnvAsync({}, async (env) => {
    env.useLLM(() => Promise.resolve({ tolk: "歇会儿吧", submitText: "遵命" }));
    env.guard.continuousActiveSec = 25 * 60 - TICK_SEC;
    env.tick(0, 1);
    await flush();
    assert.deepEqual(env.texts(), ["歇会儿吧"]);
    assert.equal(env.speaks[0].data.submitText, "遵命");
    assert.equal(env.llmCalls.length, 1);
    assert.equal(env.llmCalls[0].type, "focusEye");
    assert.deepEqual(env.llmCalls[0].ctx, { activeMin: 25 });
    assert.deepEqual(env.llmCalls[0].petInfo, { info: { name: "小狗" } });
  });
});

test("读取宠物信息抛错时仍照常出提醒，按空信息生成台词", async () => {
  await withEnvAsync({}, async (env) => {
    env.useLLM(() => Promise.resolve({ tolk: "歇会儿吧" }));
    global.getPetInfo = () => {
      throw new Error("pet store 损坏");
    };
    env.guard.continuousActiveSec = 25 * 60 - TICK_SEC;
    env.tick(0, 1);
    await flush();
    assert.deepEqual(env.texts(), ["歇会儿吧"]);
    assert.deepEqual(env.llmCalls[0].petInfo, {});
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /pet store 损坏/);
  });
});

// ----------------------------------------------------------------- 状态机

test("同一次久坐只提醒一次：触发后计时归零，冷却期内不再重复", () => {
  withEnv({ sys: { focusEyeReminder: false } }, (env) => {
    env.tick(0, 100); // 第 100 轮触发久坐
    assert.deepEqual(env.texts(), [FALLBACK.sedentary]);
    assert.equal(env.guard.continuousSedentarySec, 0);
    env.tick(0, 100); // 再坐 50 分钟：计时够了，但离上次只过了 50 分钟 > 30 分钟冷却
    assert.deepEqual(env.texts(), [FALLBACK.sedentary, FALLBACK.sedentary]);
  });
});

test("护眼冷却边界：满 20 分钟冷却前差 1 毫秒不提醒，到点才提醒", () => {
  withEnv({}, (env) => {
    env.guard.lastReminders.focusEye = env.clock.now;
    env.guard.continuousActiveSec = 25 * 60;
    env.clock.now += 20 * 60 * 1000 - 1;
    env.guard._tick();
    assert.deepEqual(env.texts(), []);
    env.clock.now += 1; // 冷却正好满 20 分钟
    env.guard._tick();
    assert.deepEqual(env.texts(), [FALLBACK.focusEye]);
  });
});

test("深夜劝睡按 60 分钟冷却复发，没有「每晚只劝一次」的跨天去重", () => {
  withEnv(
    {
      sys: { focusEyeReminder: false, focusSedentaryReminder: false },
      now: at(22, 0),
    },
    (env) => {
      env.tick(0, 1);
      env.clock.now = at(22, 30);
      env.tick(0, 1); // 冷却未满
      assert.deepEqual(env.texts(), [FALLBACK.lateNight]);
      env.clock.now = at(23, 0);
      env.tick(0, 1); // 冷却满 60 分钟，再劝一次
      env.clock.now = at(22, 0, 2); // 第二天同一时刻：照样劝，不存在跨天抑制
      env.tick(0, 1);
      assert.deepEqual(env.texts(), [
        FALLBACK.lateNight,
        FALLBACK.lateNight,
        FALLBACK.lateNight,
      ]);
    }
  );
});

test("离开 5 分钟以上清零护眼计时，10 分钟以上才清零久坐计时", () => {
  withEnv({}, (env) => {
    env.tick(0, 40); // 累计 20 分钟活跃 / 20 分钟久坐
    assert.equal(env.guard.continuousActiveSec, 1200);
    env.tick(6 * 60, 1); // 离开 6 分钟：护眼清零，久坐保留
    assert.equal(env.guard.continuousActiveSec, 0);
    assert.equal(env.guard.continuousSedentarySec, 1200);
    env.tick(11 * 60, 1); // 离开 11 分钟：久坐也清零
    assert.equal(env.guard.continuousSedentarySec, 0);
  });
});

test("久别问候只在「离开→回来」那一轮触发，持续活跃不再重复问候", () => {
  withEnv({ sys: { focusEyeReminder: false } }, (env) => {
    env.tick(20 * 60, 1);
    env.tick(0, 20); // 回来后连续活跃 10 分钟
    assert.deepEqual(env.texts(), [FALLBACK.welcomeBack]);
  });
});

test("久别问候按 30 分钟冷却去重：短时间内两次久别只问候一次", () => {
  withEnv({ sys: { focusEyeReminder: false } }, (env) => {
    env.tick(20 * 60, 1);
    env.tick(0, 1); // 第一次回来：问候
    env.tick(20 * 60, 1);
    env.tick(0, 1); // 20 分钟后又一次久别归来：冷却未满，不问候
    assert.deepEqual(env.texts(), [FALLBACK.welcomeBack]);
    env.clock.now += 30 * 60 * 1000;
    env.tick(20 * 60, 1);
    env.tick(0, 1); // 冷却已满：再问候一次
    assert.deepEqual(env.texts(), [FALLBACK.welcomeBack, FALLBACK.welcomeBack]);
  });
});

test("focusEnabled 关闭时巡检整轮空转：不提醒也不累计计时", () => {
  withEnv({ sys: { focusEnabled: false }, now: at(23, 0) }, (env) => {
    env.tick(0, 200);
    assert.deepEqual(env.texts(), []);
    assert.equal(env.guard.continuousActiveSec, 0);
  });
});

test("单项开关关闭时该类提醒不弹，但计时照常累计（重开后立刻能提醒）", () => {
  withEnv({ sys: { focusEyeReminder: false } }, (env) => {
    env.tick(0, 50);
    assert.deepEqual(env.texts(), []);
    assert.equal(env.guard.continuousActiveSec, 25 * 60);
    env.sys.focusEyeReminder = true;
    env.tick(0, 1);
    assert.deepEqual(env.texts(), [FALLBACK.focusEye]);
  });
});

test("focusWelcomeBack 关闭时久别归来不问候，但计时清零照常发生", () => {
  withEnv({ sys: { focusWelcomeBack: false } }, (env) => {
    env.guard.continuousActiveSec = 600;
    env.tick(20 * 60, 1);
    env.tick(0, 1);
    assert.deepEqual(env.texts(), []);
    assert.equal(env.guard.continuousActiveSec, TICK_SEC); // 清零后本轮重新累计
  });
});

test("llmEnabled 关闭时不调用 AI，直接弹离线文案", () => {
  withEnv({}, (env) => {
    env.useLLM(() => Promise.resolve({ tolk: "不该出现的台词" }));
    env.sys.llmEnabled = false; // AI 对话总开关关闭，但服务商已配置
    env.guard.continuousActiveSec = 25 * 60 - TICK_SEC;
    env.tick(0, 1);
    assert.deepEqual(env.texts(), [FALLBACK.focusEye]);
    assert.deepEqual(env.llmCalls, []);
  });
});

test("未配置可用服务商时不调用 AI，直接弹离线文案", () => {
  withEnv({}, (env) => {
    env.useLLM(() => Promise.resolve({ tolk: "不该出现的台词" }));
    env.hasChatProvider = false; // llmEnabled 开着，但一个服务商都没配
    env.guard.continuousActiveSec = 25 * 60 - TICK_SEC;
    env.tick(0, 1);
    assert.deepEqual(env.texts(), [FALLBACK.focusEye]);
    assert.deepEqual(env.llmCalls, []);
  });
});

test("stop() 后再 start()：计时与提醒冷却记录全部清空", () => {
  withEnv({}, (env) => {
    env.tick(0, 50);
    assert.deepEqual(Object.keys(env.guard.lastReminders), ["focusEye"]);
    env.guard.continuousSedentarySec = 999;
    env.guard.lastIdleSec = 888;
    env.guard.start();
    env.guard.stop();
    env.guard.start();
    assert.deepEqual(env.guard.lastReminders, {});
    assert.equal(env.guard.continuousActiveSec, 0);
    assert.equal(env.guard.continuousSedentarySec, 0);
    assert.equal(env.guard.lastIdleSec, 0);
  });
});

// ------------------------------------------------------------- 并发 / 时序

test("start() 连调两次只挂一条定时器，stop() 只清一次", () => {
  withEnv({}, (env) => {
    const realSet = global.setInterval;
    const realClear = global.clearInterval;
    let setCount = 0;
    let clearCount = 0;
    global.setInterval = (...a) => {
      setCount += 1;
      return realSet(...a);
    };
    global.clearInterval = (...a) => {
      clearCount += 1;
      return realClear(...a);
    };
    try {
      env.guard.start();
      const first = env.guard.timer;
      env.guard.start();
      assert.equal(setCount, 1);
      assert.equal(env.guard.timer, first);
      env.guard.stop();
      env.guard.stop();
      assert.equal(clearCount, 1);
      assert.equal(env.guard.timer, null);
    } finally {
      global.setInterval = realSet;
      global.clearInterval = realClear;
    }
  });
});

test("巡检定时器已 unref，不会拖住进程退出", () => {
  withEnv({}, (env) => {
    env.guard.start();
    assert.equal(typeof env.guard.timer.hasRef, "function");
    assert.equal(env.guard.timer.hasRef(), false);
  });
});

test("stop() 后在途的 AI 台词回来时不再弹气泡", async () => {
  await withEnvAsync({}, async (env) => {
    let resolveTolk;
    env.useLLM(() => new Promise((r) => {
      resolveTolk = r;
    }));
    env.guard.start();
    env.guard.continuousActiveSec = 25 * 60 - TICK_SEC;
    env.tick(0, 1);
    assert.equal(env.llmCalls.length, 1);
    env.guard.stop();
    resolveTolk({ tolk: "迟到的提醒" });
    await flush();
    assert.deepEqual(env.texts(), []);
  });
});

test("stop() 后在途的 AI 台词失败时也不弹离线气泡，但仍留错误日志", async () => {
  await withEnvAsync({}, async (env) => {
    let rejectTolk;
    env.useLLM(() => new Promise((_, rej) => {
      rejectTolk = rej;
    }));
    env.guard.start();
    env.guard.continuousActiveSec = 25 * 60 - TICK_SEC;
    env.tick(0, 1);
    env.guard.stop();
    rejectTolk(new Error("provider 超时"));
    await flush();
    assert.deepEqual(env.texts(), []);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /provider 超时/);
  });
});

test("巡检内部抛错不会中断定时器：本轮跳过并记完整堆栈", () => {
  withEnv({}, (env) => {
    env.guard.start();
    const boom = new Error("idle 查询炸了");
    global.getSys = () => {
      throw boom;
    };
    env.guard.timer._onTimeout(); // 手动跑一轮巡检回调，不等真实 30s
    assert.equal(env.guard.timer !== null, true);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0], /\[focusGuard\].*跳过本轮/);
    assert.match(env.errors[0], /idle 查询炸了/);
  });
});
