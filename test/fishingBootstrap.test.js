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
  const received = []; // 真正推给 Flash 影片的数据（JSON 字符串）

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
    player: { PETEventOnReceived: (s) => received.push(s) },
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
    received,
    windowStub,
    evalIn,
    getUpLoad: () => evalIn("getUpLoad()"),
    // player 是 var 声明的模块级变量，真实里由 load 回调赋值；测试里直接换
    setPlayer: (p) => {
      ctx.player = p;
    },
    push: (resultData) =>
      evalIn(`setPETEVENT(${JSON.stringify(resultData)})`),
    // 触发所有待跑定时器（可能又排出新的），返回本轮实际触发次数
    tick: () => tickOnce(timers),
    // 反复触发直到没有待跑定时器，返回累计触发次数
    drain: (guard = 1e4) => {
      let n = 0;
      while (timers.length) {
        n += tickOnce(timers);
        if (n > guard) throw new Error("定时器没有终止");
      }
      return n;
    },
  };
}

function tickOnce(timers) {
  const due = timers.splice(0, timers.length);
  for (const t of due) t.fn();
  return due.length;
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

// ==========================================================================================
// setPETEVENT：把数据快照推给 Flash 影片时的重试预算
//
// 关注的 bug：重试计数器原先是模块级共享的（`let i = 0; if (i++ > 30) return;`）。
// 30 次预算被首次装载耗光后，之后**每一次**刷新推送（买鱼 / 喂食 / 收获都会触发
// getPetInfoAgain → setPETEVENT）都在第一次尝试就被直接丢弃，连一次重试都没有，
// 而且丢弃分支是裸 `return`，日志里一行痕迹都没有。
// 修法：预算改为每次推送独立（闭包内局部变量），并在放弃时留一条说明降级行为的告警。
// ==========================================================================================

const PUSH_MAX_TRIES = makeSandbox().evalIn("PETEVENT_PUSH_MAX_TRIES");
const PUSH_INTERVAL_MS = makeSandbox().evalIn("PETEVENT_PUSH_INTERVAL_MS");

// 一份形状与真实推送一致的数据（setPetInfo / getPetInfoAgain 都是这个结构）
const SNAPSHOT = (yb = 100) => ({
  data: { yb, fishes: [], harvestfish: 3, canusecnt: 1 },
  head: { cmd: 1, game: 6, key: "", svr: 0, ver: 1 },
});
// 影片还没把回调注册到 <embed> 上
const NOT_READY = {};

test("推送重试的间隔与上限是命名常量，乘积才是单次推送的等待总时长 1.5s", () => {
  const s = makeSandbox();
  assert.equal(typeof PUSH_MAX_TRIES, "number");
  assert.equal(typeof PUSH_INTERVAL_MS, "number");
  assert.equal(
    PUSH_MAX_TRIES * PUSH_INTERVAL_MS,
    1500,
    "两个常量相乘才是单次推送的等待总时长；改间隔却不改次数会悄悄改变超时上限"
  );
  assert.equal(
    s.evalIn("PETEVENT_PUSH_TIMEOUT_MS"),
    PUSH_MAX_TRIES * PUSH_INTERVAL_MS,
    "日志里用的总时长必须由两个常量算出，不能再写死"
  );
});

test("影片已就绪时立即推送一次原始数据，且不排定时器", () => {
  const s = makeSandbox();
  s.push(SNAPSHOT(42));
  assert.equal(s.received.length, 1, "应恰好推送一次");
  assert.deepEqual(JSON.parse(s.received[0]), SNAPSHOT(42), "推的必须是原始数据");
  assert.equal(s.timers.length, 0, "已就绪不该再排定时器");
  assert.deepEqual(s.logs.warn, [], "正常推送不该有告警");
});

test("影片未就绪时按命名常量的间隔重试，就绪后恰好推送一次", () => {
  const s = makeSandbox();
  s.setPlayer(NOT_READY);
  s.push(SNAPSHOT());
  assert.equal(s.received.length, 0);
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, PUSH_INTERVAL_MS, "重试间隔必须走命名常量");

  for (let k = 0; k < 5; k++) {
    assert.equal(s.tick(), 1, `第 ${k + 1} 轮应恰好触发一个待跑定时器`);
    assert.equal(s.received.length, 0, "影片没就绪就不该推");
  }
  s.setPlayer({ PETEventOnReceived: (str) => s.received.push(str) });
  assert.equal(s.tick(), 1);
  assert.equal(s.received.length, 1, "就绪后应恰好推一次");
  assert.equal(s.timers.length, 0, "推成功后必须停止重试");
  assert.deepEqual(s.logs.warn, [], "最终推成功了就不该告警");
});

test("player 尚未被 load 回调赋值时按未就绪重试，而不是在定时器里抛 TypeError", () => {
  const s = makeSandbox();
  s.setPlayer(undefined);
  s.push(SNAPSHOT()); // 旧写法 player.PETEventOnReceived 在这里就抛了
  assert.equal(s.timers.length, 1, "应排一次重试");
  assert.deepEqual(s.logs.error, [], "不该有异常逃到日志里");
});

test("每次推送各有独立的重试预算：前一次耗光预算后，后一次仍能推成功", () => {
  // 这是本项修复的核心。共享计数器下：第一次推送把 30 次预算用光，
  // 第二次推送即便影片早已就绪，也会在第一行被直接 return 掉，界面永远刷不出新数据。
  const s = makeSandbox();
  s.setPlayer(NOT_READY);
  s.push(SNAPSHOT(1)); // 第一次推送：一路重试到放弃
  assert.equal(s.drain(), PUSH_MAX_TRIES + 1, "第一次推送的重试次数应是上限 + 1");
  assert.equal(s.logs.warn.length, 1, "第一次推送应留恰好一条放弃告警");
  assert.equal(s.received.length, 0, "前置：第一次推送确实没推出去");

  s.setPlayer({ PETEventOnReceived: (str) => s.received.push(str) });
  s.push(SNAPSHOT(2)); // 第二次推送：影片这会儿就绪了
  assert.equal(s.received.length, 1, "第二次推送必须推出去（预算不是共享的）");
  assert.deepEqual(JSON.parse(s.received[0]), SNAPSHOT(2));
  assert.equal(s.logs.warn.length, 1, "第二次推送成功，不该再多一条告警");
});

test("每次推送各有独立的重试预算：后一次也拿到完整的重试次数", () => {
  const s = makeSandbox();
  s.setPlayer(NOT_READY);
  s.push(SNAPSHOT(1));
  assert.equal(s.drain(), PUSH_MAX_TRIES + 1);

  s.push(SNAPSHOT(2)); // 影片仍未就绪
  assert.equal(
    s.drain(),
    PUSH_MAX_TRIES + 1,
    "第二次推送应重新拿到完整预算，而不是继承第一次用光的计数"
  );
  assert.equal(s.logs.warn.length, 2, "两次推送各留一条放弃告警");
});

test("放弃推送时必须留一条告警：写清是哪次推送、丢了什么、界面会怎样", () => {
  const s = makeSandbox();
  s.setPlayer(NOT_READY);
  s.push(SNAPSHOT());
  s.drain();

  assert.equal(s.logs.warn.length, 1, "应恰好告警一次（不是零次，也不是每轮重试都刷）");
  const line = s.logs.warn[0];
  assert.match(line, /^\[fishing\/html\]/, "日志前缀必须是 [fishing/html]");
  assert.match(line, /PETEventOnReceived/, "要写清等的是哪个回调");
  assert.match(
    line,
    new RegExp(String(PUSH_MAX_TRIES * PUSH_INTERVAL_MS) + "ms"),
    "要写清等了多久（毫秒数由常量算出，改常量时日志同步变化）"
  );
  assert.match(line, /cmd=1/, "要能认出丢的是哪一次推送");
  assert.match(line, /yb,fishes,harvestfish,canusecnt/, "要写清丢了哪些数据字段");
  assert.match(line, /旧值/, "必须写清降级后的行为：界面停在上一次的旧值");
});

test("放弃推送后不留悬空定时器", () => {
  const s = makeSandbox();
  s.setPlayer(NOT_READY);
  s.push(SNAPSHOT());
  s.drain();
  assert.equal(s.timers.length, 0, "放弃后不得再挂着定时器空转");
  assert.equal(s.received.length, 0);
});

test("重试预算不再是模块级共享变量", () => {
  // 行为已由上面两个用例锁住；这条只钉住那个被删掉的模块级计数器不会被谁改回来。
  assert.ok(
    !/let i = 0;\s*const setPETEVENT/.test(CODE),
    "setPETEVENT 前不应再出现模块级计数器 `let i = 0`"
  );
  assert.ok(
    !/if \(i\+\+ > 30\)/.test(CODE),
    "不应再出现裸字面量 30 的共享计数判断"
  );
});
