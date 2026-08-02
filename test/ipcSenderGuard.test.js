"use strict";

/**
 * _guardIpc（IPC 发送方三层校验）的**行为**测试。
 *
 * 为什么单独开一个文件：test/electronSecurityInvariants.test.js 里那条
 * 「ipcMain 注册必须过发送方校验」是纯源码文本断言（indexOf + assert.match），
 * 它能证明「三层校验的代码字面存在」，但从不执行守卫。三条 fail-open 缺陷
 * （帧属性访问在 try 外、senderFrame 为 null 时静默跳过第 2/3 层、setPreload 裸注册）
 * 正是这么漏过去的：源码里 frame.parent / "app.html" 都在，文本断言全绿，
 * 运行时该拒的照样放行。所以这里把守卫真的跑起来。
 *
 * 取到被测函数的手法与 test/clipPrivacy.test.js 同源：src/windows/window.js 是 webpack
 * 压缩单行产物、顶层 eval("require")("electron") 在纯 node 下会炸，无法 require；
 * 但 _guardIpc 是纯函数，对外只有 console / URL 两个自由标识符，把源码切出来交给
 * new Function 注入 console 即可执行，不需要 Electron 运行时。entry / event 全是桩。
 *
 * 变异自证入口：QQ_SEC_SRC_ROOT=<目录>，语义与 electronSecurityInvariants.test.js 一致
 * （存在 <目录>/src/windows/window.js 就读它，否则回落仓库文件），
 * 用于把改坏的副本写进临时目录验证这些用例真的会红，无需改动仓库里的 src/。
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const OVERRIDE_ROOT = process.env.QQ_SEC_SRC_ROOT || "";
const WINDOW_FACTORY = "src/windows/window.js";

/** 顶层壳窗的真实文档地址形态：percent-encoded 的 file:// URL，末段是 app.html。 */
const APP_URL = "file:///C:/Program%20Files/QQ%E5%AE%A0%E7%89%A9+AI%E7%89%88/src/windows/app.html";

function resolveSource(rel) {
  if (OVERRIDE_ROOT) {
    const overridden = path.join(OVERRIDE_ROOT, rel);
    if (fs.existsSync(overridden)) return overridden;
  }
  return path.join(REPO_ROOT, rel);
}

/**
 * 从压缩产物里切出 _guardIpc 的完整源码并变成可调用函数。
 *
 * 定位只依赖 `function _guardIpc(` 这一个结构锚点 + 花括号配对，同文件里其它改动
 * （加窗口、改 webPreferences、改日志文案）都不影响抽取。
 */
function loadGuard(onWarn) {
  const src = fs.readFileSync(resolveSource(WINDOW_FACTORY), "utf8");
  const head = "function _guardIpc(";
  assert.equal(
    src.split(head).length - 1,
    1,
    `${WINDOW_FACTORY}: 期望恰好一处 _guardIpc 定义。0 处说明守卫被删/改名（同步本测试，别删断言），` +
      `多处说明出现了分叉的守卫实现，需要重新审计哪条注册路径用的是哪个。`
  );
  const at = src.indexOf(head);
  const open = src.indexOf("{", at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  assert.notEqual(end, -1, `${WINDOW_FACTORY}: _guardIpc 的花括号未配对，抽取失败`);
  const factory = new Function("console", `${src.slice(at, end + 1)}\nreturn _guardIpc;`);
  return factory({
    warn: (...a) => onWarn(a),
    log: () => {},
    error: () => {},
  });
}

/**
 * 造一套桩：一个已注册 fishing 通道的窗口 entry，一个记录调用次数的 handler，
 * 以及捕获到的全部 console.warn。
 */
function makeHarness() {
  const warns = [];
  const calls = [];
  const _guardIpc = loadGuard((a) => warns.push(a));
  const webContents = { id: 7 };
  const entry = {
    win: { isDestroyed: () => false, webContents },
    option: { name: "fishing" },
  };
  const channel = "fishing_h_bus_m";
  const wrapped = _guardIpc(entry, channel, (...args) => {
    calls.push(args);
    return "handled";
  });
  return { warns, calls, wrapped, webContents, entry, channel };
}

/** 断言：这次 IPC 被拒——handler 零调用，且恰好留下一条带通道名的拒绝日志。 */
function assertRejected(h, why) {
  assert.equal(h.calls.length, 0, `${why}：handler 不该被调用（fail-open 了）`);
  assert.equal(
    h.warns.length,
    1,
    `${why}：应恰好一条 console.warn，实际 ${h.warns.length} 条。` +
      `0 条 = 静默丢弃（不可诊断，本仓库刚为「功能没反应且零线索」付过 P0 代价）；` +
      `多条 = 走了多个分支，逻辑需要复核。实际日志：${JSON.stringify(h.warns.map((w) => w[0]))}`
  );
  assert.match(
    String(h.warns[0][0]),
    /^\[window\] 已拒绝 IPC/,
    `${why}：拒绝日志必须以「[window] 已拒绝 IPC」开头，实际：${h.warns[0][0]}`
  );
  assert.equal(
    h.warns[0][1],
    h.channel,
    `${why}：拒绝日志第二个参数必须是通道名，否则不知道是哪条 IPC 被拦`
  );
}

test("_guardIpc：senderFrame 取值抛异常（帧已销毁）时拒绝且不把异常抛给调用方", () => {
  const h = makeHarness();
  const event = {
    sender: h.webContents,
    get senderFrame() {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    },
  };
  assert.doesNotThrow(
    () => h.wrapped(event, { a: 1 }),
    "异常不能逃出监听器：ipcMain.on 的监听器抛出会一路落到 main.js 的 uncaughtException（运行期只记日志不退出），" +
      "这条 IPC 被静默丢弃，用户只看到「操作没反应」"
  );
  assertRejected(h, "senderFrame getter 抛异常");
});

test("_guardIpc：senderFrame.parent 抛异常（属性访问期销毁）时同样拒绝且不外抛", () => {
  const h = makeHarness();
  const event = {
    sender: h.webContents,
    senderFrame: {
      get parent() {
        throw new Error("Render frame was disposed before WebFrameMain could be accessed");
      },
      get url() {
        throw new Error("Render frame was disposed before WebFrameMain could be accessed");
      },
    },
  };
  assert.doesNotThrow(
    () => h.wrapped(event, { a: 1 }),
    "WebFrameMain 是在**属性访问**时抛的，只把 event.senderFrame 取值包进 try 挡不住 parent/url"
  );
  assertRejected(h, "senderFrame.parent 抛异常");
});

test("_guardIpc：senderFrame 为 null 时必须拒绝（不得静默跳过子框架与 app.html 校验）", () => {
  const h = makeHarness();
  const event = { sender: h.webContents, senderFrame: null };
  assert.doesNotThrow(() => h.wrapped(event, { a: 1 }));
  assertRejected(
    h,
    "senderFrame 为 null。放行等于第 2、3 层双双失效——对 fishing/backRoom 这类承载 " +
      "http://127.0.0.1 iframe 的窗口，那两层是唯一防线（子框架与顶层帧共用同一 WebContents，" +
      "第一层 event.sender 比对恒等通过）"
  );
});

test("_guardIpc：正常顶层帧（parent 为 null 且文档是 app.html）必须放行", () => {
  const h = makeHarness();
  const event = { sender: h.webContents, senderFrame: { parent: null, url: APP_URL } };
  const ret = h.wrapped(event, { a: 1 });
  assert.equal(
    h.calls.length,
    1,
    "合法 IPC 被拒了。fail-closed 收紧不能误伤正常路径——正常窗口的顶层帧在存活期间 " +
      "senderFrame 始终可取，包含窗口刚创建后的第一条消息"
  );
  assert.deepEqual(h.calls[0], [event, { a: 1 }], "handler 必须原样收到 event 与全部参数");
  assert.equal(ret, "handled", "守卫必须把 handler 的返回值透传出去");
  assert.deepEqual(h.warns, [], `放行路径不该有任何 warn，实际：${JSON.stringify(h.warns)}`);
});

test("_guardIpc：子框架（parent 非 null）发来的 IPC 必须拒绝", () => {
  const h = makeHarness();
  const event = {
    sender: h.webContents,
    senderFrame: { parent: { url: APP_URL }, url: "http://127.0.0.1:8080/index.html" },
  };
  h.wrapped(event, { a: 1 });
  assertRejected(h, "子框架发来的 IPC。钓鱼/密室的 http iframe 与顶层帧共用同一 WebContents");
});

test("_guardIpc：发送方 WebContents 不是注册该通道的窗口时必须拒绝", () => {
  const h = makeHarness();
  const event = {
    sender: { id: 999 },
    senderFrame: { parent: null, url: APP_URL },
  };
  h.wrapped(event, { a: 1 });
  assertRejected(h, "别的窗口冒用通道");
});
