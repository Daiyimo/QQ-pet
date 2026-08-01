// macOS: 全局 EPIPE 防护 — 必须在最前面
// 原项目有几百个 console.log，管道断开时会 EPIPE 崩溃
const _origLog = console.log;
const _origErr = console.error;
const _origWarn = console.warn;
const safeFn = (fn) => (...args) => { try { fn(...args); } catch (e) { if (e?.code !== "EPIPE") throw e; } };
console.log = safeFn(_origLog);
console.error = safeFn(_origErr);
console.warn = safeFn(_origWarn);
process.stdout?.on?.("error", () => {});
process.stderr?.on?.("error", () => {});
process.on("uncaughtException", (err) => {
  // EPIPE 是管道断开（父进程/终端关闭），属预期噪音，静默即可
  if (err?.code === "EPIPE" || err?.message?.includes("EPIPE")) return;
  // 其余全部是意料外异常，必须带完整堆栈落日志，否则故障不可诊断
  // 注意：此处刻意不 app.exit() — 桌宠是长驻进程，单个未捕获异常不应导致用户宠物消失。
  // 代价是进程可能处于未定义状态，因此堆栈日志是唯一的排查线索。
  console.error("[FATAL] 未捕获异常:", err?.stack || err);
});
process.on("unhandledRejection", (reason, promise) => {
  // 9 个 service 与全部 LLM 调用都是异步的，这里静默等于让密钥失效/配额耗尽/感知失败全部无声
  console.error("[FATAL] 未处理的 Promise 拒绝:", reason?.stack || reason, "promise:", promise);
});

const { app } = require("electron");
const path = require("path");

const gotTheLock = app.requestSingleInstanceLock();

// 禁用测试后门
global.$test = false;

global.initData = {};

let useTool = null;

try {
  // 命令行与环境变量两条路径统一过同一白名单：环境变量此前未做校验，
  // 任意值都会被拼进下面的 require（不存在则启动崩溃，可控则加载任意本地 js）。
  const { resolveToolName } = require("./src/ini/toolResolver.js");
  const toolName = resolveToolName(process.argv, process?.env?.NODE_TOOL);
  if (toolName) {
    initData.NODE_TOOL = toolName;
    useTool = require("./src/windows/tool/" + toolName + "/main.js");
  }
} catch (e) {
  // 工具模式解析/加载失败不应阻断启动，降级为「非工具模式」正常启动桌宠
  useTool = null;
  initData.NODE_TOOL = undefined;
  console.warn("[启动] 工具窗模式加载失败，按普通桌宠模式启动:", e?.stack || e);
}

const createWindow = async () => {
  try {
    require("./src/ini/init.js");
    app.setAppUserModelId("com.qqlocal.desktop");

    if (gotTheLock) {
      if (useTool) {
        useTool.cleate("only");
      } else {
        require("./src/ini/doMain.js");
        const { startDataWatcher } = require("./src/ini/dataWatcher.js");
        startDataWatcher();
      }
    } else {
      app.exit(true);
    }
  } catch (e) {
    // 启动阶段的致命异常必须结束进程，不能落到上面的 unhandledRejection。
    // 那个处理器刻意「只记日志不退出」——对运行期的孤立异常是对的（桌宠是长驻进程，
    // 不该因为一次异常就让用户的宠物消失），但对 init 阶段是错的：此时既没有窗口
    // 也没有托盘，进程却活着并占用 requestSingleInstanceLock，用户再点图标也起不来，
    // 只能去任务管理器杀，且毫无提示。所以这里显式告知 + 退出。
    console.error("[FATAL] 启动失败，进程将退出:", e?.stack || e);
    try {
      const { dialog } = require("electron");
      dialog.showErrorBox(
        "QQ宠物启动失败",
        "初始化时发生无法恢复的错误，程序将退出。\n\n" +
          "常见原因：存档目录 %APPDATA%\\qq-local 不可写、磁盘空间不足、" +
          "或该目录被安全软件占用。\n\n" +
          "错误信息：" +
          (e?.message || String(e))
      );
    } catch (e2) {
      // 弹窗本身失败（dialog 不可用等）不该掩盖原始错误，记下后照样退出
      console.error("[FATAL] 展示启动失败弹窗时又出错:", e2?.stack || e2);
    }
    app.exit(1);
  }
};

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(() => {
  createWindow();
});
