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
    } catch (e) {}
  });
  perceptionLoop.on("pet-show", () => {
    try {
      if (petMain.window && !petMain.window.isDestroyed()) petMain.window.show();
    } catch (e) {}
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
  // 注意：doMain 顶层 require 本模块时 sys 尚未初始化（setSys({init}) 在 createMain
  // 回调里），此时 getSys() 会抛错，必须等 sys 就绪后再执行。
  const boot = () => {
    // getSys(key) 会把存储的 false 吞成 undefined（pet.js 用 || 取值），判原始值要读整个 sys 对象
    const sys = getSys() || {};
    // 弹幕开关默认值落盘：感知循环对未设置的 barrageEnabled 视为开，
    // 这里显式写入 true，保证设置页 UI 与实际行为一致
    if (sys.barrageEnabled === undefined) {
      setSys({ name: "barrageEnabled", value: true });
    }
    if (sys.perceptionEnabled) {
      startPerception();
    }
    // 成就定时巡检：喂食/钓鱼/升级/元宝/在线时长等触发点分散在压缩代码里，
    // 用周期 check 统一覆盖（幂等，只有新解锁才会气泡庆祝）
    const t = setInterval(() => {
      try {
        global.achievement && global.achievement.check("timer");
      } catch (e) {}
    }, 60000);
    t.unref && t.unref();
  };
  const bootTimer = setInterval(() => {
    try {
      if (typeof getSys !== "function") return;
      getSys(); // sys 未初始化时会抛 TypeError，下一轮再试
      clearInterval(bootTimer);
      boot();
    } catch (e) {
      /* sys 未就绪，继续等 */
    }
  }, 2000);
  bootTimer.unref && bootTimer.unref();

  // 供设置页"开启/关闭感知"后手动控制
  global.aiWiring = { startPerception, stopPerception };
})();
