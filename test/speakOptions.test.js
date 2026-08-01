// openSpeak 选项形状一致性测试（service 侧三个调用方：signIn / achievement / travel）。
// windows 侧 global.openSpeak 消费 {data, active, nextActiveStr, communication, otherOpt}：
// active 缺省回退 "speak"，nextActiveStr 缺省不排队后续动作。三家统一传
// {active:"speak", nextActiveStr:"speak"}，本文件把这个约定钉死。
// （perception/loop.js 的主动发言调用方也已补齐为同样形状，未在本文件覆盖。）
const test = require("node:test");
const assert = require("node:assert/strict");

const signIn = require("../src/service/signIn.js");
const { createAchievementService } = require("../src/service/achievement.js");
const { createTravelService } = require("../src/service/travel.js");

function assertSpeakShape(opt, label) {
  assert.equal(typeof opt, "object", label);
  assert.ok(opt.data && opt.data.type === "text", label + " data.type");
  assert.equal(opt.active, "speak", label + " active");
  assert.equal(opt.nextActiveStr, "speak", label + " nextActiveStr");
}

test("signIn 庆祝气泡：{active, nextActiveStr} 齐全", () => {
  signIn.__resetMemoryState();
  const speaks = [];
  global.getSys = () => undefined;
  global.setSys = () => {};
  global.getPetInfo = () => ({ info: { yb: 0, growth: 0 } });
  global.setPetInfo = () => {};
  global.openSpeak = (o) => speaks.push(o);
  signIn.doSignIn("2026-07-29");
  assert.equal(speaks.length, 1);
  assertSpeakShape(speaks[0], "signIn");
});

test("achievement 庆祝气泡：{active, nextActiveStr} 齐全", () => {
  const speaks = [];
  const svc = createAchievementService({
    getPetInfo: () => ({ info: { growth: 0 }, maxInfo: { level: 5 } }), // 触发「破壳而出」
    setPetInfo: () => {},
    getSys: () => undefined,
    openSpeak: (o) => speaks.push(o),
    store: { get: () => ({}), set: () => {} },
  });
  const newly = svc.check("test");
  // 解锁数与气泡数都要钉住：只断言 newly 的话，成就不再发气泡（speaks 为空）时下面的
  // for 循环会一次都不执行，本条测试会假绿。
  assert.equal(newly.length, 1, "growth 0 + 5 级应且只应解锁「破壳而出」");
  assert.equal(speaks.length, 1, "每解锁一条成就应发一个庆祝气泡");
  assertSpeakShape(speaks[0], "achievement");
});

test("travel 气泡：{active, nextActiveStr} 齐全", () => {
  const speaks = [];
  const svc = createTravelService({
    now: () => 1000000,
    random: () => 0,
    setTimeout: () => null, // 不挂真实定时器，避免拖住测试进程
    clearTimeout: () => {},
    getPetInfo: () => ({
      info: { mood: 500, yb: 300 },
      maxInfo: { mood: 1000 },
      activeOption: { work: null, study: null, trip: null, ill: null, die: null },
    }),
    setPetInfo: () => {},
    openSpeak: (o) => speaks.push(o),
    mainWindow: { show: true, window: { webContents: { send: () => {} }, hide: () => {}, show: () => {} } },
    store: { getItem: () => null, setItem: () => {} },
  });
  const r = svc.startTravel();
  assert.equal(r.ok, true);
  assert.ok(speaks.length >= 1);
  for (const opt of speaks) assertSpeakShape(opt, "travel");
});
