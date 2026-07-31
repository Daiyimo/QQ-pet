// 「签到达人」成就回归测试：走真实链路（signIn 写 sys.signin -> achievement 读 getSys）。
//
// 背景：签到状态的权威存储是 sys.signin（src/service/signIn.js 头注释说明 info.signin
// 不在 ini/pet.js 的默认 info 表里，会被 setPetInfo 静默丢弃）。旧版 achievement.js
// 读 petInfo.info.signin，生产环境恒为 undefined，成就永不解锁。
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "service");
const { createAchievementService } = require(path.join(SRC, "achievement.js"));

// 用真实的 signIn 模块产生签到状态：注入全局 getSys/setPetInfo/setSys 桩，
// 让 doSignIn 的落盘与 achievement 的读取共用同一份 sys 存储。
function makeEnv(startInfo = {}) {
  const sys = {};
  const petInfo = {
    info: { yb: 0, growth: 0, ...startInfo },
    maxInfo: { level: 1 },
    fishing: {},
  };
  const achStore = {};
  const speaks = [];

  global.getSys = (name) => (name ? sys[name] : sys);
  global.setSys = ({ name, value }) => {
    sys[name] = value;
  };
  global.getPetInfo = () => petInfo;
  global.setPetInfo = (d) => {
    for (const g of Object.keys(d)) petInfo[g] = { ...(petInfo[g] || {}), ...d[g] };
  };
  global.openSpeak = () => {};

  const service = createAchievementService({
    getPetInfo: () => petInfo,
    setPetInfo: global.setPetInfo,
    getSys: global.getSys,
    openSpeak: (o) => speaks.push(o),
    store: {
      get: () => achStore.map || {},
      set: (m) => {
        achStore.map = m;
      },
    },
  });
  return { sys, petInfo, service, speaks, achStore };
}

// 连续签到 n 天：从固定起点逐日调 doSignIn（signIn 支持注入 today 串）
function signInDays(signIn, n, start = "2026-07-01") {
  let day = start;
  for (let i = 0; i < n; i++) {
    signIn.doSignIn(day);
    day = signIn.addDays(day, 1);
  }
  return signIn.addDays(day, -1);
}

test("签到达人：连续签到 7 天后经真实链路解锁", () => {
  const env = makeEnv();
  // 必须在注入全局桩之后再 require，signIn 在调用时惰性取全局
  const signIn = require(path.join(SRC, "signIn.js"));
  signInDays(signIn, 7);
  assert.equal(env.sys.signin.streak, 7, "前置：签到状态应落在 sys.signin");
  assert.equal(env.petInfo.info.signin, undefined, "前置：info.signin 不该存在（会被 setPetInfo 丢弃）");

  const newly = env.service.check("signin");
  const ids = newly.map((x) => x.id);
  assert.ok(ids.includes("signMaster"), "旧实现读 info.signin，此处永远不会解锁");
});

test("签到达人：连续 6 天不解锁", () => {
  const env = makeEnv();
  const signIn = require(path.join(SRC, "signIn.js"));
  signInDays(signIn, 6);
  assert.equal(env.sys.signin.streak, 6);
  const ids = env.service.check("signin").map((x) => x.id);
  assert.ok(!ids.includes("signMaster"));
});

test("签到达人：断签重置后未满 7 天不解锁", () => {
  const env = makeEnv();
  const signIn = require(path.join(SRC, "signIn.js"));
  signInDays(signIn, 5); // 连签 5 天到 2026-07-05
  signIn.doSignIn("2026-07-20"); // 中断后重新开始 -> streak 归 1
  assert.equal(env.sys.signin.streak, 1);
  const ids = env.service.check("signin").map((x) => x.id);
  assert.ok(!ids.includes("signMaster"));
});

test("签到达人：无签到记录时不报错也不解锁", () => {
  const env = makeEnv();
  assert.deepEqual(env.sys, {});
  const ids = env.service.check("signin").map((x) => x.id);
  assert.ok(!ids.includes("signMaster"));
});

test("签到达人：getSys 抛异常时不解锁且留痕", () => {
  const env = makeEnv();
  const service = createAchievementService({
    getPetInfo: () => env.petInfo,
    setPetInfo: () => {},
    getSys: () => {
      throw new Error("sys 存储损坏");
    },
    openSpeak: () => {},
    store: { get: () => ({}), set: () => {} },
  });
  const origErr = console.error;
  let logged = "";
  console.error = (...a) => {
    logged += a.join(" ");
  };
  try {
    const ids = service.check("signin").map((x) => x.id);
    assert.ok(!ids.includes("signMaster"));
  } finally {
    console.error = origErr;
  }
  assert.match(logged, /sys\.signin/, "异常必须留痕，不能裸吞");
});

test("签到达人：sys.signin 缺失但 info.signin 存在时也能解锁（前向兜底）", () => {
  // 将来若把 signin 加进 ini/pet.js 的默认 info 表，这条路径要仍然有效
  const env = makeEnv();
  env.petInfo.info.signin = { streak: 9 };
  const ids = env.service.check("signin").map((x) => x.id);
  assert.ok(ids.includes("signMaster"));
});

test("签到达人：解锁后幂等，不重复庆祝", () => {
  const env = makeEnv();
  const signIn = require(path.join(SRC, "signIn.js"));
  signInDays(signIn, 7);
  const first = env.service.check("signin").map((x) => x.id);
  assert.ok(first.includes("signMaster"));
  const speaksAfterFirst = env.speaks.length;
  const second = env.service.check("signin").map((x) => x.id);
  assert.ok(!second.includes("signMaster"), "已解锁不应再次返回");
  assert.equal(env.speaks.length, speaksAfterFirst, "不应重复弹庆祝气泡");
});

test("getAll 中签到达人的解锁态与 check 一致", () => {
  const env = makeEnv();
  const signIn = require(path.join(SRC, "signIn.js"));
  signInDays(signIn, 7);
  assert.equal(env.service.getAll().find((x) => x.id === "signMaster").unlocked, false);
  env.service.check("signin");
  assert.equal(env.service.getAll().find((x) => x.id === "signMaster").unlocked, true);
});

test("小富翁成就仍按 info.yb 判定（未被本次改动影响）", () => {
  const env = makeEnv({ yb: 10000 });
  const ids = env.service.check("rich").map((x) => x.id);
  assert.ok(ids.includes("rich"));
});
