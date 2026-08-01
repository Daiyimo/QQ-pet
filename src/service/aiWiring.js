// AI 功能统一接线：把感知/记忆/课程/弹幕/对话窗各模块桥接进主进程。
// 在 src/ini/doMain.js 中 require 本文件（require 顺序：各服务模块已先挂载 global 单例）。
//
// 桥接内容：
//   感知 activity         → 记忆系统记录 + 课程模块非课程计数
//   感知 course-perception → 课程管理器
//   感知 keyframe-requested → 截屏回调课程关键帧
//   感知 pet-hide/pet-show → 游戏场景隐藏/恢复桌宠窗口
//   Ctrl+M 快捷键          → 开关 AI 对话窗
//   perceptionEnabled      → 启动感知循环
(() => {
  const { perceptionLoop, startPerception, stopPerception } = require("./perception/index.js");
  const { captureScreen } = require("./perception/capture.js");
  const aiChat = require("../windows/popups/aiChat/main.js");
  const petMain = require("../windows/main/main.js");

  // ---- 感知 → 记忆 / 课程 ----
  perceptionLoop.on("activity", (payload) => {
    try {
      if (global.memoryService) {
        global.memoryService.handlePerceptionActivity({
          scene: payload.scene,
          confidence: payload.confidence,
          observation: payload.text,
          // course_title 必须转发：memory/activity.js 在 course 场景 observation 为空时
          // 用它兜底生成"正在学习课程：{title}"，丢了会整段漏记
          course_title: payload.course_title,
          timestamp: payload.timestamp,
        });
      }
      // 每次非课程感知都计入课程自动退出判定（连续 4 次且 ≥90s 自动 finish）
      if (payload.scene !== "course" && global.courseManager) {
        global.courseManager.handleNonCourse();
      }
    } catch (e) {
      console.warn("[aiWiring] activity 桥接失败:", e?.message || e);
    }
  });

  perceptionLoop.on("course-perception", (result) => {
    try {
      global.courseManager && global.courseManager.handleCoursePerception(result);
    } catch (e) {
      console.warn("[aiWiring] course-perception 桥接失败:", e?.message || e);
    }
  });

  // ---- 课程关键帧：courseManager 节流（≤40 张、≥30s）后发 "keyframe-capture"，
  // 这里负责截屏并回写仓库 ----
  const wireKeyframeCapture = () => {
    if (!global.courseManager) return false;
    global.courseManager.on("keyframe-capture", async ({ timestampMs, note } = {}) => {
      try {
        const mgr = global.courseManager;
        if (!mgr || !mgr.currentSession) return;
        const shot = await captureScreen({ maxWidth: 1280 });
        mgr.recordKeyframe({
          timestampMs: typeof timestampMs === "number" ? timestampMs : 0,
          pngBuffer: shot.pngBuffer,
          note: note || "",
        });
      } catch (e) {
        console.warn("[aiWiring] 关键帧截屏失败:", e?.message || e);
      }
    });
    return true;
  };
  if (!wireKeyframeCapture()) {
    const t = setInterval(() => {
      if (wireKeyframeCapture()) clearInterval(t);
    }, 2000);
    t.unref && t.unref();
  }

  // ---- 游戏场景：隐藏桌宠（弹幕接管），退出游戏恢复 ----
  perceptionLoop.on("pet-hide", () => {
    try {
      if (petMain.window && !petMain.window.isDestroyed()) petMain.window.hide();
    } catch (e) {
      console.error("[aiWiring] 隐藏桌宠窗口失败:", e && e.stack ? e.stack : e);
    }
  });
  perceptionLoop.on("pet-show", () => {
    try {
      if (petMain.window && !petMain.window.isDestroyed()) petMain.window.show();
    } catch (e) {
      console.error("[aiWiring] 恢复桌宠窗口失败:", e && e.stack ? e.stack : e);
    }
  });

  // ---- Ctrl+M 开关 AI 对话窗（shotycutsMain 由主窗口创建后挂载，轮询等待）----
  const shortcutTimer = setInterval(() => {
    if (!global.shotycutsMain) return;
    clearInterval(shortcutTimer);
    try {
      global.shotycutsMain.upShotycut("aiChat", ["CTRL", "M"], () => {
        aiChat.show ? aiChat.doClose() : aiChat.cleate();
      });
    } catch (e) {
      console.warn("[aiWiring] 快捷键注册失败:", e?.message || e);
    }
  }, 2000);
  shortcutTimer.unref && shortcutTimer.unref();

  // ---- 启动引导：感知自启 + 弹幕开关默认值落盘 ----
  // 就绪判定只认 doMain.js 在 setSys({init}) / setCache({init}) 之后置的
  // global.__sysReady，不能用 getSys() 探测，原因（已核对 src/ini/pet.js）：
  //   1) pet.js 在模块加载期就把 e.system 赋成默认字面量（快捷键/透明度/皮肤等默认值）；
  //   2) getSys 无参调用是 `t ? ... : e.system`，直接返回该对象，任何情况都不抛错。
  // 所以"getSys() 不抛错"恒为真，等于没有等待。这正是历史缺陷的成因：boot() 在存档
  // 载入前就跑，第一件事又是 setSys 落盘，而 setSys 末尾无条件
  // $Store.setItem("sys", e.system) 且是全量覆盖（无合并语义、无提示），于是磁盘上的
  // sys 被默认值整体覆盖——用户的快捷键/透明度/皮肤/免打扰/llmEnabled/perceptionEnabled
  // 以及 safeStorage 加密保存的 API Key 全部丢失。
  const isSysReady = () => global.__sysReady === true;

  // 等待 sys 就绪的轮询参数
  const SYS_READY_POLL_MS = 2000; // 与本文件另两处引导轮询（关键帧接线、快捷键注册）一致
  // 30 次 × 2s ≈ 60s 上限：doMain 里 setSys({init}) 与本模块 require 属同一次启动流程，
  // 正常情况第一次 tick 就已就绪；60s 足以覆盖 HDD / 杀软扫描导致的存档读取延迟。
  // 超过则说明就绪信号根本不会来（存档读取失败已提前 return，或启动流程中断），
  // 再轮询只是空转，必须放弃并留下线索——不能无限静默重试。
  const SYS_READY_MAX_ATTEMPTS = 30;

  const boot = () => {
    // 防御断言：sys 未就绪时绝不写 sys。下面第一件事就是 setSys 落盘，而未就绪时
    // 内存里的 e.system 还是 pet.js 的默认字面量，写下去等于清空用户存档。
    // 即使上游就绪判定将来又被改坏，这一层也必须挡住。
    if (!isSysReady()) {
      console.error(
        "[aiWiring] sys 未就绪却尝试执行启动引导，已拒绝以免默认设置覆盖用户存档：" +
          "本次不落盘 barrageEnabled、不自启感知、不启动成就巡检"
      );
      return false;
    }
    // 弹幕开关默认值落盘：感知循环对未设置的 barrageEnabled 视为开，
    // 这里显式写入 true，保证设置页 UI 与实际行为一致
    // （已核对 pet.js：getSys 为 `key in e.system` 语义，存储的 false 能如实读出，
    //   不会被误判成"未设置"而反复覆写成 true）
    if (getSys("barrageEnabled") === undefined) {
      setSys({ name: "barrageEnabled", value: true });
    }
    if (getSys("perceptionEnabled")) {
      startPerception();
    }
    // 成就定时巡检：喂食/钓鱼/升级/元宝/在线时长等触发点分散在压缩代码里，
    // 用周期 check 统一覆盖（幂等，只有新解锁才会气泡庆祝）
    const t = setInterval(() => {
      try {
        global.achievement && global.achievement.check("timer");
      } catch (e) {
        console.error("[aiWiring] 成就巡检失败:", e && e.stack ? e.stack : e);
      }
    }, 60000);
    t.unref && t.unref();
    return true;
  };

  // 探针与启动分离：探针只负责判定就绪并停表，boot() 由独立 try/catch 兜住。
  // 历史缺陷（故障路径 B）：clearInterval 写在 boot() 之前，且整段被一个空体 catch
  // 包住。boot() 里 startPerception() 要新建弹幕 BrowserWindow，多显示器热插拔 /
  // GPU 进程异常时会抛——此时表已停 → 不会重试，异常又被吞掉 → 感知 + 弹幕 +
  // 成就巡检三个功能同时永久失效，且日志里一个字都没有。
  // setIntervalFn / clearIntervalFn 可注入，供测试用手动时钟驱动（无需真实等待 2s）。
  const startBootWatcher = ({
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) => {
    let attempts = 0;
    const timer = setIntervalFn(() => {
      attempts += 1;
      if (!isSysReady()) {
        if (attempts >= SYS_READY_MAX_ATTEMPTS) {
          clearIntervalFn(timer);
          console.error(
            `[aiWiring] 等待 sys 就绪超过 ${SYS_READY_MAX_ATTEMPTS * SYS_READY_POLL_MS}ms，` +
              "放弃启动 AI 功能：感知不会自启、弹幕开关默认值不落盘、成就巡检不运行。" +
              "常见原因是 doMain.js 的 setSys({init}) 未执行（存档读取失败或启动流程提前中断）"
          );
        }
        return;
      }
      clearIntervalFn(timer); // 已就绪，先停表：boot 只跑一次，不因抛错被反复重入
      try {
        boot();
      } catch (e) {
        console.error(
          "[aiWiring] 启动引导失败，本次感知自启 / 弹幕默认值 / 成就巡检均未生效（需重启应用恢复）:",
          e && e.stack ? e.stack : e
        );
      }
    }, SYS_READY_POLL_MS);
    timer && timer.unref && timer.unref();
    return timer;
  };
  const bootTimer = startBootWatcher();

  // 供设置页"开启/关闭感知"后手动控制
  global.aiWiring = { startPerception, stopPerception };

  // 仅供测试：注入时钟驱动引导轮询、直接验证 boot 的防御断言。
  // 生产侧 doMain.js 只 require 本文件取副作用，不读这些导出。
  module.exports = {
    boot,
    startBootWatcher,
    bootTimer,
    SYS_READY_POLL_MS,
    SYS_READY_MAX_ATTEMPTS,
  };
})();
