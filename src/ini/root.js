const _require = eval("require");

// 端口被占用（EADDRINUSE）时最多再试几个相邻端口。
// 依据：只需躲开"上次进程残留 / 其他软件恰好占了 33385"这类冲突，
// 试 5 个端口足够；再多只会拖长用户点按到窗口出现的等待。
const LISTEN_MAX_ATTEMPTS = 5;

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
  tryPort(Number.isFinite(start) ? start : 33385, 1);
};

// 本机无法进行js与flash交互有安全机制问题， 通过开端口形式进行flash页面引入
const createMain = (fn, post, ip, fileName, none) => {
  if (none) {
    fn(post, ip, fileName);
    return;
  }
  const express = _require("express");
  const app = express();
  const path = _require("path");
  app.get("/", function (req, res) {
    // res.render('index');
    res.send("this is the Homepage");
  });
  // fileName = 'u'
  mountStatic(app, fileName, express, path);
  // 离线本地版：只绑定 127.0.0.1，不对局域网暴露 src/ 静态目录
  listenWithRetry(
    app,
    post,
    ip || "127.0.0.1",
    function (server) {
      var host = server.address().address;
      var port = server.address().port;
      fn(port, host, fileName);
      console.log("express at http://%s:%s/%s", host, port, fileName);
    },
    function () {
      // 端口全被占用：把 null 交给调用方降级，不能让回调永不触发
      console.error(
        `[ini/root] 本机静态服务启动失败（${LISTEN_MAX_ATTEMPTS} 个端口均不可用），依赖它的窗口将无法加载`
      );
      fn(null, null, fileName);
    }
  );
};

// 本文件已删除的死代码（git 历史可查）：
// - openWS：nodejs-websocket 本机 ws 服务，全仓无调用点；依赖也随之从 package.json 移除。
// - getLocalIP：唯一的两个调用点是 createMain / openLocalHost 里未被使用的
//   `let aotuIp = getLocalIP()`，随本轮监听重构一并删除后即成死代码（59 行，含一段
//   注释掉的 readline 选 IP 交互）。本地版只绑 127.0.0.1，不需要枚举网卡。
// 用 typeof 判定替代原来的 `try{...}catch(error){}`：module 缺失是可预期分支，
// 不该用裸 catch 表达（裸 catch 会顺手吞掉真正的赋值异常）。
if (typeof module !== "undefined" && module) {
  module.exports = { createMain, listenWithRetry, LISTEN_MAX_ATTEMPTS };
}
/**
 * 
sad
var mx:int = this.mouseX;
         var my:int = this.mouseY;
         ExternalInterface.call("API.GetCursorPositionHtml",mx,my);
         if(mx < -30)
         {
            mx = 34;
         }
         if(my < -79)
         {
            my = 0;
         }
         return new Point(mx,my);
happy peaceful
var mx:int = this.mouseX;
         var my:int = this.mouseY;
         ExternalInterface.call("API.GetCursorPositionHtml",mx,my);
         if(mx < -70)
         {
            mx = 0;
         }
         if(my < -70)
         {
            my = 0;
         }
         return new Point(mx,my);

prostrate
var mx:int = this.mouseX;
         var my:int = this.mouseY;
         ExternalInterface.call("API.GetCursorPositionHtml",mx,my);
         if(mx < -33)
         {
            mx = 35;
         }
         if(my < -83)
         {
            my = 21;
         }
         return new Point(mx,my);
upset
var mx:int = this.mouseX;
         var my:int = this.mouseY;
         ExternalInterface.call("API.GetCursorPositionHtml",mx,my);
         if(mx < -38)
         {
            mx = 29;
         }
         if(my < -68)
         {
            my = 24;
         }
         return new Point(mx,my);

 */

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
  let post = "33385";
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
        `[ini/root] 本机静态服务启动失败（33385 起 ${LISTEN_MAX_ATTEMPTS} 个端口均被占用），Flash/Ruffle 窗口无法加载`
      );
      flushPending(null);
    }
  );
};
