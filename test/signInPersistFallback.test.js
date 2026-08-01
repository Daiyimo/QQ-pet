// signIn.js 落盘失败的内存兜底回归测试：
//   writeState 先写 memoryState 再 setSys；setSys 抛错时奖励已发但 sys 读不回新状态，
//   readState 必须在 memoryState.last >= sys.last（"YYYY-MM-DD" 定长零填充，字典序即
//   时间序）时优先内存态，否则当天可重复签到刷奖励。
// 另覆盖 grantRewards 的错误日志形式（[signIn] 前缀 + console.error）。
const test = require("node:test");
const assert = require("node:assert/strict");

const signIn = require("../src/service/signIn.js");

// setSysBehavior: "ok" 正常落盘 / "throw" 抛错模拟落盘失败
function setup(opt = {}) {
  signIn.__resetMemoryState();
  const store = {
    sys: opt.sys || {},
    pet: { info: { yb: 300, growth: 0, name: "小Q" } },
  };
  const speaks = [];
  global.getSys = (name) => (name ? store.sys[name] : store.sys);
  global.setSys = ({ name, value }) => {
    if (opt.setSysBehavior === "throw") throw new Error("disk full");
    store.sys[name] = value;
  };
  global.getPetInfo = () => store.pet;
  global.setPetInfo = ({ info }) => {
    if (opt.setPetInfoBehavior === "throw") throw new Error("pet store broken");
    Object.assign(store.pet.info, info);
  };
  global.openSpeak = (o) => speaks.push(o);
  return { store, speaks };
}

function captureConsoleError(fn) {
  const errors = [];
  const orig = console.error;
  console.error = (...args) => errors.push(args.map((a) => String(a)).join(" "));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return errors;
}

test("setSys 落盘失败：当天重复签到被拒绝（内存态兜底），奖励只发一次", () => {
  const { store, speaks } = setup({ setSysBehavior: "throw" });
  const first = signIn.doSignIn("2026-07-29");
  assert.equal(first.ok, true);
  // sys 里确实没写上（落盘失败）
  assert.equal(store.sys.signin, undefined);
  // 当天第二次签到：readState 必须读到内存态的 last=今天，判定 already
  const second = signIn.doSignIn("2026-07-29");
  assert.deepEqual(second, { ok: false, reason: "already" });
  assert.equal(store.pet.info.yb, 320, "奖励只应发一次");
  assert.equal(speaks.length, 1, "只庆祝一次");
  // getStatus 同样以内存态为准
  const s = signIn.getStatus("2026-07-29");
  assert.equal(s.signedToday, true);
  assert.equal(s.streak, 1);
  assert.equal(s.total, 1);
});

test("setSys 落盘失败：次日签到基于内存态连签，不丢 streak", () => {
  const { store } = setup({ setSysBehavior: "throw" });
  signIn.doSignIn("2026-07-28");
  signIn.doSignIn("2026-07-29");
  const s = signIn.getStatus("2026-07-29");
  assert.equal(s.streak, 2, "sys 始终没落盘，streak 也必须正确");
  assert.equal(s.total, 2);
  assert.equal(store.pet.info.yb, 340);
});

test("setSys 恢复后：sys 与内存态一致，行为不变", () => {
  const { store } = setup();
  signIn.doSignIn("2026-07-29"); // setSys 正常
  assert.deepEqual(store.sys.signin, { last: "2026-07-29", streak: 1, total: 1 });
  const res = signIn.doSignIn("2026-07-29");
  assert.deepEqual(res, { ok: false, reason: "already" });
});

test("sys 比内存态新（如其他路径写入）：以 sys 为准", () => {
  const { store } = setup({ setSysBehavior: "throw" });
  signIn.doSignIn("2026-07-28"); // 只进了内存态（落盘失败）
  // 模拟 sys 被其他路径写入了更新的状态
  store.sys.signin = { last: "2026-07-30", streak: 5, total: 9 };
  const s = signIn.getStatus("2026-07-30");
  assert.equal(s.signedToday, true);
  assert.equal(s.streak, 5);
  assert.equal(s.total, 9);
});

test("grantRewards 失败：console.error 带 [signIn] 前缀，不裸 console.log", () => {
  setup({ setPetInfoBehavior: "throw" });
  const errors = captureConsoleError(() => {
    const res = signIn.doSignIn("2026-07-29");
    assert.equal(res.ok, true, "奖励失败不影响签到状态落盘");
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith("[signIn]"), "日志必须带模块前缀: " + errors[0]);
  assert.match(errors[0], /grantRewards/);
});
