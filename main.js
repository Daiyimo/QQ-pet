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
// 「主窗口是否曾成功创建」的闭锁标志。用 var 而不是 let：下面的 uncaughtException
// 处理器在本行之前就已注册，若模块加载期间抛异常，let 的 TDZ 会让处理器自身再炸一次。
var mainWindowEverCreated = false;
// 启动失败弹窗只允许弹一次（showErrorBox 是模态阻塞的，弹第二次等于卡死用户）
var startupFailureReported = false;
// 本进程是抢不到单实例锁的第二实例：它按设计就不创建窗口、直接退出，不能被误判成启动失败
// （否则用户双击图标唤醒已在运行的宠物时，退出途中的任何异常都会弹一个假的「启动失败」）。
// 用 var 而非读 gotTheLock：那是个 const，模块加载期抛异常时连 typeof 都会撞 TDZ。
var isSecondInstance = false;

// 下面两个用 function 声明（而非 const 箭头）以获得提升：两个 process 处理器注册在它们
// 之前，一旦模块加载期就抛异常，const 的 TDZ 会掩盖真正的错误。

/**
 * 判定进程是否处于「启动失败」状态：从来没有窗口被创建过，且此刻也没有活窗口。
 *
 * 为什么用这两个信号：main.js 无法观测 doMain / 窗口工厂的返回值（它们不在本次可改范围），
 * 但 Electron 自身的 app "browser-window-created" 事件与 BrowserWindow.getAllWindows()
 * 是与实现无关的权威窗口存在性信号。任一为真 ⇒ 用户至少有窗口/托盘可交互，属运行期；
 * 两者皆假 ⇒ 进程只剩一个 requestSingleInstanceLock，用户再点图标也起不来（新实例拿不到
 * 锁直接退出），只能去任务管理器杀且毫无提示 —— 这正是要兜住的僵尸进程。
 */
function isStartupFailure() {
  if (mainWindowEverCreated || isSecondInstance) return false;
  try {
    const { BrowserWindow } = require("electron");
    return BrowserWindow.getAllWindows().length === 0;
  } catch (e) {
    // 读不到窗口列表说明 Electron 环境本身异常，按「没有窗口」的保守侧处理
    console.warn("[main] 读取 BrowserWindow 列表失败，按启动失败处理:", e?.message || e);
    return true;
  }
}

/** 启动失败的统一收尾：记完整堆栈 → 弹一次说明弹窗 → app.exit(1)。createWindow 与两个 process 处理器共用这一份。 */
function fatalStartupExit(err, phase) {
  console.error("[FATAL] 启动失败（" + phase + "），进程将退出:", err?.stack || err);
  if (!startupFailureReported) {
    startupFailureReported = true;
    try {
      const { dialog } = require("electron");
      // 注意：dialog.showErrorBox 是同步阻塞的，且内部会跑一个嵌套消息循环 ——
      // 弹窗期间定时器照样 tick、事件照样派发，弹窗之后写的任何逻辑都可能与那些回调交错
      // （这个性质曾经是一个 P0 的触发路径）。所以弹窗返回后除了 app.exit(1) 什么都不做。
      dialog.showErrorBox(
        "QQ宠物启动失败",
        "初始化时发生无法恢复的错误，程序将退出。\n\n" +
          "常见原因：存档目录 %APPDATA%\\qq-local 不可写、磁盘空间不足、" +
          "或该目录被安全软件占用。\n\n" +
          "错误信息：" +
          (err?.message || String(err))
      );
    } catch (e2) {
      // 弹窗本身失败（dialog 不可用等）不该掩盖原始错误，记下后照样退出
      console.error("[FATAL] 展示启动失败弹窗时又出错:", e2?.stack || e2);
    }
  }
  require("electron").app.exit(1);
}

process.on("uncaughtException", (err) => {
  // EPIPE 是管道断开（父进程/终端关闭），属预期噪音，静默即可
  if (err?.code === "EPIPE" || err?.message?.includes("EPIPE")) return;
  // 启动期（还没有任何窗口）的异常必须结束进程，否则留下占着单实例锁的无窗口僵尸进程
  if (isStartupFailure()) return fatalStartupExit(err, "启动期未捕获异常");
  // 运行期的孤立异常：必须带完整堆栈落日志，否则故障不可诊断
  // 注意：此处刻意不 app.exit() — 桌宠是长驻进程，单个未捕获异常不应导致用户宠物消失。
  // 代价是进程可能处于未定义状态，因此堆栈日志是唯一的排查线索。
  console.error("[FATAL] 未捕获异常:", err?.stack || err);
});
process.on("unhandledRejection", (reason, promise) => {
  // 启动路径大量是异步的（whenReady().then 之后的 microtask、service 的异步 init），
  // 这些拒绝同样会留下无窗口僵尸进程，因此与 uncaughtException 走同一条兜底。
  if (isStartupFailure()) return fatalStartupExit(reason, "启动期未处理的 Promise 拒绝");
  // 9 个 service 与全部 LLM 调用都是异步的，这里静默等于让密钥失效/配额耗尽/感知失败全部无声
  console.error("[FATAL] 未处理的 Promise 拒绝:", reason?.stack || reason, "promise:", promise);
});

const { app, session } = require("electron");
const path = require("path");

// 闭锁：只要有过一个窗口被创建，之后的异常就都算运行期（用户有 UI/托盘可交互，不是僵尸进程）
app.on("browser-window-created", () => {
  mainWindowEverCreated = true;
});

const gotTheLock = app.requestSingleInstanceLock();
isSecondInstance = !gotTheLock;

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
    // 权限门禁必须先于任何窗口创建：未设 handler 时 Electron 默认放行摄像头/麦克风/定位，
    // 且没有权限提示 UI，而 tool/urlWindow 就是用来加载任意网址的。核查与策略见该模块注释。
    require("./src/ini/security.js").installPermissionHandlers(session.defaultSession);

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
    // 那个处理器对运行期的孤立异常刻意「只记日志不退出」（桌宠是长驻进程，不该因为一次
    // 异常就让用户的宠物消失），但对 init 阶段是错的：此时既没有窗口也没有托盘，进程却
    // 活着并占用 requestSingleInstanceLock，用户再点图标也起不来，只能去任务管理器杀，
    // 且毫无提示。弹窗 + 退出的那一份逻辑与 process 处理器共用 fatalStartupExit。
    fatalStartupExit(e, "初始化异常");
  }
};

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(() => {
  createWindow();
});
