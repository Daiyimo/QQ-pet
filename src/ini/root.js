const _require = eval("require");

// 端口被占用（EADDRINUSE）时最多再试几个相邻端口。
// 依据：只需躲开"上次进程残留 / 其他软件恰好占了 33385"这类冲突，
// 试 5 个端口足够；再多只会拖长用户点按到窗口出现的等待。
const LISTEN_MAX_ATTEMPTS = 5;

// 本机静态服务的默认起始端口。
// 依据：沿用 1.2.5 官方客户端 flash 页面引入所用的 33385（见 windows/main/indexOnline.html
// 里残留的 http://<ip>:33385/u/... 资源路径），换端口不影响功能但会让老截图/日志对不上。
// 修复前这个数字在本文件里散落 4 份（含一份写死在错误消息文案里），改端口必漏；
// doMain.js 调用 createMain 时也传了同一个字面量，两侧一致性由
// test/rootListen.test.js 的跨文件断言钉死。
const DEFAULT_PORT = 33385;

// 本机静态服务只暴露实际被访问的子目录（修复前整个 src/ 被挂载，虽只绑
// 127.0.0.1，本机任意进程仍可读到源码与存档相关文件）。当前仅三处走该服务：
// - windows/popups/fishing  池塘钓鱼 indexOnLine.html 及其 swf / pet / legacy_124 资源
// - windows/popups/backRoom 密室逃脱 indexOnLine.html 及其 swf / cmd*.xml 资源
// - windows/js/ruffle       两个页面以 ../../js/ruffle/ruffle.js 引入的 Ruffle 运行时（含 wasm）
// 注意：windows/main/indexOnline.html 的远程加载分支在 main.js 中是死代码
// （bd 恒为 true，走本地 jsFiles），若将来启用需补挂 windows/main 与 assets。
const STATIC_SUBDIRS = [
  "windows/popups/fishing",
  "windows/popups/backRoom",
  "windows/js/ruffle",
];
const mountStatic = (app, fileName, express, path) => {
  for (const sub of STATIC_SUBDIRS) {
    app.use("/" + fileName + "/" + sub, express.static(path.join(__dirname, "../../src", sub)));
  }
};

/**
 * 带 error 处理与端口自增重试的 listen。
 *
 * 背景（本次修复的缺陷）：原实现三处 `app.listen(port, host, cb)` 都只传成功回调，
 * 没有 server.on("error")。EADDRINUSE 通过 'error' 事件抛出，会落到 main.js 的
 * uncaughtException（设计上只记日志不退出），于是成功回调永不执行——
 * 用户点"池塘 / 游戏 / 密室"时窗口永远不出现，且没有任何提示。
 *
 * @param {object} expressApp express 实例
 * @param {number|string} basePort 起始端口
 * @param {string} host 绑定地址（本项目恒为 127.0.0.1）
 * @param {Function} onListening (server) => void 绑定成功
 * @param {Function} onGiveUp    (error) => void  全部端口失败，调用方必须降级
 */
const listenWithRetry = (expressApp, basePort, host, onListening, onGiveUp) => {
  const start = Number(basePort);
  const tryPort = (port, attempt) => {
    let settled = false;
    const server = expressApp.listen(port, host, function () {
      if (settled) return;
      settled = true;
      onListening(server);
    });
    // listen 失败只会通过 'error' 事件暴露，必须挂监听，否则直接变未捕获异常
    server.on("error", function (error) {
      if (settled) return;
      settled = true;
      console.error(
        `[ini/root] 本机静态服务绑定 ${host}:${port} 失败（第 ${attempt}/${LISTEN_MAX_ATTEMPTS} 次尝试）:`,
        error && error.stack ? error.stack : error
      );
      const canRetry = error && error.code === "EADDRINUSE" && attempt < LISTEN_MAX_ATTEMPTS;
      if (canRetry) {
        tryPort(port + 1, attempt + 1);
        return;
      }
      onGiveUp(error);
    });
  };
  tryPort(Number.isFinite(start) ? start : DEFAULT_PORT, 1);
};

// 本机无法进行js与flash交互有安全机制问题， 通过开端口形式进行flash页面引入
//
// 本函数只剩"直通"语义：把 (post, ip, fileName) 原样交给启动回调。
// 修复前它还有一整段 express 引导（express() → path → "/" 首页桩 → mountStatic →
// listenWithRetry），与下方 global.openLocalHost 里的 5 步逐行同构，但那是生产死代码——
// 唯一调用方 src/ini/doMain.js 恒传第 5 个参数 none=!0，命中直通提前返回，express 分支
// 只被测试撑着。两份同构代码的实际危害是：改端口 / 改挂载目录时只改活的那份也能全绿。
// 删除而非抽公共函数，是因为给一份永不执行的代码做抽象只是把死代码藏得更深。
//
// 注：doMain.js 仍传第 5 个参数（none），此处刻意不再声明——它已无分支可选。
// 真的需要本机静态服务时请用 global.openLocalHost（唯一活着的那份引导），
// 不要在这里把 express 分支加回来。
const createMain = (fn, post, ip, fileName) => {
  fn(post, ip, fileName);
};

// 本文件已删除的死代码（git 历史可查）：
// - openWS：nodejs-websocket 本机 ws 服务，全仓无调用点；依赖也随之从 package.json 移除。
// - getLocalIP：唯一的两个调用点是 createMain / openLocalHost 里未被使用的
//   `let aotuIp = getLocalIP()`，随本轮监听重构一并删除后即成死代码（59 行，含一段
//   注释掉的 readline 选 IP 交互）。本地版只绑 127.0.0.1，不需要枚举网卡。
// - createMain 的 express 引导分支：与 openLocalHost 逐行同构，而唯一调用方 doMain.js
//   恒传 none=!0，生产中永不执行（详见 createMain 上方注释）。
// - 一段 57 行的 ActionScript 鼠标坐标片段（sad / happy peaceful / prostrate / upset 四种
//   情绪各一份 mouseX/mouseY 钳制 + ExternalInterface.call("API.GetCursorPositionHtml")）：
//   反编译宠物 SWF 时贴进来的草稿，与本文件的 express 引导毫无关系。该 API 的协议说明与
//   实现落在 src/windows/util/pet/petExternalApi.js（那里 GetCursorPositionHtml 是 noop，
//   本批素材不调用）。原文见 `git show 22cf878:src/ini/root.js` 的 114-170 行。
// 用 typeof 判定替代原来的 `try{...}catch(error){}`：module 缺失是可预期分支，
// 不该用裸 catch 表达（裸 catch 会顺手吞掉真正的赋值异常）。
if (typeof module !== "undefined" && module) {
  module.exports = { createMain, listenWithRetry, LISTEN_MAX_ATTEMPTS, DEFAULT_PORT };
}

// 随机 URL 路径段的字符表：openLocalHost 里 upDownArr(shuffleArr(fileNames)).join("")
// 把整个数组打乱 + 随机大小写后拼成一个 37 字符的段（如 /aQb_KcJ.../），让本机静态服务的
// 挂载前缀每次启动都不同，外部进程猜不到。
// 关于 A–J 出现两次（共 37 项而非 27 项）：因为是"整表 join"而非"随机取一项"，重复
// 并不构成任何权重，唯一效果是段长 37 而非 27、且 A–J 各出现两次（大小写独立随机）。
// 看着像复制粘贴残留，但无注释佐证、也无法从行为上反推作者意图，故保留原样——
// 改动需谨慎：src/ini/doMain.js 里有一份完全相同的副本（变量名 fileName），
// 只改一边会让两处路径段长度悄悄分叉。
let fileNames = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "_",
];

let url = {
  host: "",
  port: "",
  fileName: "",
};
// 启动中的请求队列：绑定要等 listen 回调（失败还要重试相邻端口），
// 期间用户可能连点多次「池塘 / 游戏 / 密室」。不排队的话每次点击都会新起一个
// express 实例各自重试，端口越占越乱。
let starting = false;
let pending = [];
const flushPending = (result) => {
  const waiters = pending;
  pending = [];
  starting = false;
  for (const waiter of waiters) {
    try {
      waiter(result);
    } catch (e) {
      // 单个调用方的回调抛错不能影响其他等待者，但必须留堆栈
      console.error("[ini/root] openLocalHost 回调执行失败:", e && e.stack ? e.stack : e);
    }
  }
};
global.openLocalHost = (fn) => {
  if (!fn) {
    return;
  }
  if (url.host) {
    fn(url);
    return;
  }
  pending.push(fn);
  if (starting) return;
  starting = true;
  const express = _require("express");
  const app = express();
  const path = _require("path");
  app.get("/", function (req, res) {
    // res.render('index');
    res.send("this is the Homepage");
  });
  let fileName = upDownArr(shuffleArr(fileNames)).join("");
  // fileName = 'u'
  mountStatic(app, fileName, express, path);
  let post = DEFAULT_PORT;
  // 离线本地版：只绑定 127.0.0.1
  listenWithRetry(
    app,
    post,
    "127.0.0.1",
    function (server) {
      var host = server.address().address;
      var port = server.address().port;
      url = {
        host: host,
        port: port,
        fileName: fileName,
      };
      console.log("express at http://%s:%s/%s", host, port, fileName);
      flushPending(url);
    },
    function () {
      // 端口全占用：回调收到 null，调用方必须按"打不开"降级并提示用户，
      // 绝不能像修复前那样让回调永不触发、窗口静默不出现。
      console.error(
        `[ini/root] 本机静态服务启动失败（${DEFAULT_PORT} 起 ${LISTEN_MAX_ATTEMPTS} 个端口均被占用），Flash/Ruffle 窗口无法加载`
      );
      flushPending(null);
    }
  );
};
