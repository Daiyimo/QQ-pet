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
let tool = ["floatStyle"];

try {
  let e = process.argv;
  for (let t in tool) {
    let a = false;
    for (let o in e) {
      if (e[o].indexOf(tool[t]) !== -1) {
        initData.NODE_TOOL = tool[t];
        a = true;
        break;
      }
    }
    if (a) break;
  }
} catch (e) {
  // 工具模式参数解析失败不应阻断启动，降级为「非工具模式」正常启动桌宠
  console.warn("[启动] 解析工具模式命令行参数失败，按普通模式启动:", e?.stack || e);
}

if (process?.env?.NODE_TOOL) {
  initData.NODE_TOOL = process.env.NODE_TOOL;
}

if (initData?.NODE_TOOL && typeof initData?.NODE_TOOL === "string") {
  useTool = require("./src/windows/tool/" + initData.NODE_TOOL + "/main.js");
}

const createWindow = async () => {
  require("./src/ini/init.js");
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  app.setAppUserModelId("pet");

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
};

// macOS: 不加载 PepFlash DLL（使用 Ruffle WASM 替代）
app.commandLine.appendSwitch("disable-site-isolation-trials");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(() => {
  createWindow();
});
