// signIn.js 每日签到逻辑单元测试：首签、连签、断签重置、七日大奖、重复签到拒绝。
// 逻辑层惰性读取全局 getSys/setSys/getPetInfo/setPetInfo/openSpeak，这里注入内存 mock；
// 时间通过 getStatus/doSignIn 的可选 todayStr 参数注入，与真实日期无关。
const test = require("node:test");
const assert = require("node:assert/strict");

const signIn = require("../src/service/signIn.js");

// 每个用例前重置一套干净的全局 mock，返回 { store, speaks } 便于断言
function setup() {
  signIn.__resetMemoryState(); // 模块级内存兜底态也必须复位，否则跨用例泄漏
  const store = {
    sys: {}, // 模拟 $Store("sys")：setSys({name, value}) -> sys[name] = value
    pet: { info: { yb: 300, growth: 0, name: "小Q" } }, // 模拟宠物数据
  };
  const speaks = []; // 记录 openSpeak 调用
  global.getSys = (name) => (name ? store.sys[name] : store.sys);
  global.setSys = ({ name, value }) => {
    store.sys[name] = value;
  };
  global.getPetInfo = () => store.pet;
  global.setPetInfo = ({ info }) => {
    Object.assign(store.pet.info, info);
  };
  global.openSpeak = (opt) => speaks.push(opt);
  return { store, speaks };
}

// 连续签 from 起的 n 天（from 为 "YYYY-MM-DD"）
function signDays(from, n) {
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(signIn.doSignIn(signIn.addDays(from, i)));
  }
  return results;
}

test("首签：streak=1、total=1，基础奖励 +20 元宝 +5 成长值，气泡带 [host]", () => {
  const { store, speaks } = setup();
  const res = signIn.doSignIn("2026-07-29");
  assert.equal(res.ok, true);
  assert.equal(res.streak, 1);
  assert.equal(res.total, 1);
  assert.deepEqual(res.rewards, { yb: 20, growth: 5, big: false });
  // 状态写入 sys.signin
  assert.deepEqual(store.sys.signin, {
    last: "2026-07-29",
    streak: 1,
    total: 1,
  });
  // 奖励写入宠物数据
  assert.equal(store.pet.info.yb, 320);
  assert.equal(store.pet.info.growth, 5);
  // 气泡庆祝，文案含 [host] 占位符
  assert.equal(speaks.length, 1);
  assert.equal(speaks[0].data.type, "text");
  assert.ok(speaks[0].data.data.includes("[host]"));
});

test("重复签到：当天第二次返回 already，状态与奖励不变", () => {
  const { store, speaks } = setup();
  signIn.doSignIn("2026-07-29");
  const res = signIn.doSignIn("2026-07-29");
  assert.deepEqual(res, { ok: false, reason: "already" });
  assert.equal(store.sys.signin.total, 1);
  assert.equal(store.pet.info.yb, 320); // 只发了一次 +20
  assert.equal(speaks.length, 1); // 不再重复庆祝
});

test("连签：昨天签过则 streak+1", () => {
  const { store } = setup();
  signIn.doSignIn("2026-07-28");
  const res = signIn.doSignIn("2026-07-29");
  assert.equal(res.ok, true);
  assert.equal(res.streak, 2);
  assert.equal(res.total, 2);
  assert.equal(store.pet.info.yb, 340); // 300 + 20 + 20
});

test("断签重置：昨天没签则 streak 重置为 1", () => {
  setup();
  signIn.doSignIn("2026-07-26"); // 第一天
  const res = signIn.doSignIn("2026-07-29"); // 中间漏了 27、28
  assert.equal(res.ok, true);
  assert.equal(res.streak, 1);
  assert.equal(res.total, 2);
});

test("七日大奖：连续第 7 天额外 +100 元宝（7 天一轮）", () => {
  const { store } = setup();
  const results = signDays("2026-07-23", 7); // 07-23 ~ 07-29 连签 7 天
  const day7 = results[6];
  assert.equal(day7.streak, 7);
  assert.deepEqual(day7.rewards, { yb: 120, growth: 5, big: true });
  assert.equal(store.pet.info.yb, 300 + 20 * 6 + 120); // 前 6 天基础 + 第 7 天大奖
  // 继续连签到第 14 天再次触发大奖
  const day14 = signDays("2026-07-30", 7)[6];
  assert.equal(day14.streak, 14);
  assert.equal(day14.rewards.yb, 120);
  assert.equal(day14.rewards.big, true);
});

test("getStatus：signedToday/streak/total 与断签后 streak 归 0", () => {
  setup();
  signIn.doSignIn("2026-07-28");
  // 当天看：已签，streak=1
  let s = signIn.getStatus("2026-07-28");
  assert.equal(s.signedToday, true);
  assert.equal(s.streak, 1);
  assert.equal(s.total, 1);
  // 次日看：未签，streak 仍有效（昨天签过）
  s = signIn.getStatus("2026-07-29");
  assert.equal(s.signedToday, false);
  assert.equal(s.streak, 1);
  // 隔一天看：已断签，streak 归 0
  s = signIn.getStatus("2026-07-30");
  assert.equal(s.signedToday, false);
  assert.equal(s.streak, 0);
});

test("getStatus.week：周一到周日 7 格，已签/今天/未到/未签四态正确", () => {
  setup();
  signIn.doSignIn("2026-07-28"); // 周二签
  signIn.doSignIn("2026-07-29"); // 周三（今天）签
  const s = signIn.getStatus("2026-07-29"); // 2026-07-29 是周三
  assert.equal(s.week.length, 7);
  assert.deepEqual(
    s.week.map((d) => d.date),
    [
      "2026-07-27", // 周一
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02", // 周日
    ]
  );
  assert.deepEqual(s.week.map((d) => d.state), [
    "missed", // 周一漏签
    "signed",
    "signed", // 今天已签优先显示已签
    "future",
    "future",
    "future",
    "future",
  ]);
  assert.equal(s.week[2].isToday, true);
  assert.equal(s.streak, 2);
});
