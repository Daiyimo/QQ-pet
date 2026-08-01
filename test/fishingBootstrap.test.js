// 钓鱼渲染层启动握手回归测试：等待宿主注入 selfeLoad 的轮询（getUpLoad）。
//
// 关注的 bug：轮询到上限后 `return` 静默退出，window.getPetInfoFromMain() 永不调用，
// 钓鱼界面停在无数据状态，而日志里一行痕迹都没有。
//
// 这里沿用 test/fishingBalance.test.js 的做法：用内置 vm 在带 window/document 桩的沙箱里
// 加载 indexOnLine.js（渲染层普通脚本，无导出），setTimeout 换成可控假实现，逐次驱动轮询。
// 只有一层桩（沙箱全局），够不上「不值得测试」的门槛，所以做真实行为测试而非源码文本断言。
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const FILE = path.join(
  __dirname,
  "..",
  "src",
  "windows",
  "popups",
  "fishing",
  "indexOnLine.js"
);
const CODE = fs.readFileSync(FILE, "utf8");

// 每个用例一个全新沙箱（getupI 是模块级计数器，必须隔离）
function makeSandbox() {
  const jar = new Map();
  const timers = []; // 待触发的定时器：{ fn, ms }
  const logs = { warn: [], error: [] };
  const calls = { getPetInfoFromMain: 0 };

  const documentStub = {
    getElementById: () => ({ PETEventOnReceived: () => {} }),
    get cookie() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(str) {
      const [pair] = String(str).split(";");
      const idx = pair.indexOf("=");
      jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    },
  };

  // window 与沙箱全局分离：真实渲染层里宿主是往 iframe 的 contentWindow 上挂回调的，
  // selfeLoad / getPetInfoFromMain 都读自 window 而不是脚本作用域。
  const windowStub = {
    addEventListener: () => {},
    selfeLoad: undefined,
    getPetInfoFromMain: () => {
      calls.getPetInfoFromMain++;
    },
  };

  const ctx = {
    window: windowStub,
    document: documentStub,
    player: { PETEventOnReceived: () => {} },
    console: {
      log: () => {},
      warn: (...a) => logs.warn.push(a.join(" ")),
      error: (...a) => logs.error.push(a.join(" ")),
    },
    JSON,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    isNaN,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    close_game: () => {},
    saveInfoData: () => {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: FILE });

  // getUpLoad / 常数都是顶层 const（词法绑定，不挂在 global 上），
  // 同 context 的后续脚本可以直接读到。
  const evalIn = (expr) => vm.runInContext(expr, ctx);

  return {
    ctx,
    timers,
    logs,
    calls,
    windowStub,
    evalIn,
    getUpLoad: () => evalIn("getUpLoad()"),
    // 触发所有待跑定时器（可能又排出新的），返回本轮实际触发次数
    tick: () => {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
      return due.length;
    },
  };
}

const MAX_TRIES = (() => {
  const s = makeSandbox();
  return s.evalIn("SELFE_LOAD_POLL_MAX_TRIES");
})();
const INTERVAL_MS = (() => {
  const s = makeSandbox();
  return s.evalIn("SELFE_LOAD_POLL_INTERVAL_MS");
})();

test("轮询间隔与上限是命名常量，乘积即 10s 等待总时长", () => {
  assert.equal(typeof MAX_TRIES, "number");
  assert.equal(typeof INTERVAL_MS, "number");
  assert.equal(
    MAX_TRIES * INTERVAL_MS,
    10000,
    "两个常量相乘才是等待总时长；改间隔却不改次数会悄悄改变超时上限"
  );
});

test("selfeLoad 已就绪时立即请求一次宠物数据且不排轮询", () => {
  const s = makeSandbox();
  s.windowStub.selfeLoad = true;
  s.getUpLoad();
  assert.equal(s.calls.getPetInfoFromMain, 1);
  assert.equal(s.timers.length, 0, "已就绪不该再排定时器");
});

test("selfeLoad 未就绪时按命名常量的间隔重排，且不请求数据", () => {
  const s = makeSandbox();
  s.getUpLoad();
  assert.equal(s.calls.getPetInfoFromMain, 0);
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, INTERVAL_MS, "重排间隔必须走命名常量");
});

test("轮询期间 selfeLoad 变就绪：只请求一次数据并停止轮询", () => {
  const s = makeSandbox();
  s.getUpLoad();
  for (let i = 0; i < 5; i++) {
    assert.equal(s.tick(), 1, `第 ${i + 1} 轮应恰好触发一个待跑定时器`);
    assert.equal(s.calls.getPetInfoFromMain, 0);
  }
  s.windowStub.selfeLoad = true;
  assert.equal(s.tick(), 1);
  assert.equal(s.calls.getPetInfoFromMain, 1, "就绪后应恰好请求一次");
  assert.equal(s.timers.length, 0, "就绪后必须停止轮询");
  assert.deepEqual(s.logs.warn, [], "正常握手不该有告警");
});

test("轮询到上限放弃时必须留一条说明降级行为的告警，而不是静默 return", () => {
  const s = makeSandbox();
  s.getUpLoad(); // 第 1 次尝试
  let ticks = 0;
  while (s.timers.length) {
    ticks += s.tick();
    assert.ok(ticks <= MAX_TRIES + 2, "轮询必须能终止");
  }
  // 上限判定是 getupI++ > MAX：getupI 取 0..MAX 的 MAX+1 次调用都会重排，
  // 第 MAX+2 次调用命中放弃分支。
  assert.equal(ticks, MAX_TRIES + 1, "定时器重排次数应恰好是上限 + 1");
  assert.equal(s.calls.getPetInfoFromMain, 0, "前置：宿主始终没注入");
  assert.equal(s.logs.warn.length, 1, "放弃时应恰好告警一次（不是零次，也不是每次都刷）");
  assert.match(
    s.logs.warn[0],
    /^\[fishing\/html\]/,
    "日志前缀必须是 [fishing/html]"
  );
  assert.match(
    s.logs.warn[0],
    /selfeLoad/,
    "要写清等的是哪个信号，否则无法定位"
  );
  assert.match(
    s.logs.warn[0],
    new RegExp(String(MAX_TRIES * INTERVAL_MS)),
    "要写清等了多久（毫秒数由常量算出，改常量时日志同步变化）"
  );
  assert.match(
    s.logs.warn[0],
    /无数据/,
    "必须写清降级后的行为：界面停在无数据状态"
  );
});

test("放弃后再被调用也不会复活轮询（不留悬空定时器）", () => {
  const s = makeSandbox();
  s.getUpLoad();
  while (s.timers.length) s.tick();
  const warnCountAfterGiveUp = s.logs.warn.length;
  s.windowStub.selfeLoad = true; // 即便迟到的注入到了
  s.getUpLoad();
  assert.equal(s.calls.getPetInfoFromMain, 0, "已放弃就不再请求数据");
  assert.equal(s.timers.length, 0);
  assert.equal(s.logs.warn.length, warnCountAfterGiveUp + 1, "每次越界调用各留一条痕");
});

test("启动握手区不再留有被注释掉的废弃轮询残留", () => {
  // 原实现在 load 监听里留了 13 行注释掉的 setInterval(getPetInfoFromMain, 100) 与空 try/catch，
  // 会让下一个维护者误以为存在第二条数据获取路径。
  // 用 assert.ok(!re.test(...)) 而不是 doesNotMatch：失败时不把整份源码打进输出。
  assert.ok(
    !/\/\/\s*if\s*\(await getUpLoad\(\)\)/.test(CODE),
    "被注释掉的 `if (await getUpLoad())` 残留应删除"
  );
  assert.ok(
    !/\/\/\s*return true;/.test(CODE),
    "getUpLoad 的返回值契约已废弃，不应再留 `// return true;` 半截注释"
  );
});
