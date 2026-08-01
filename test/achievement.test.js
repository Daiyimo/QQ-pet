// 成就系统单元测试：各成就 check 边界、幂等不重复庆祝、字段缺失容错。
// 运行：node --test test/achievement.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ACHIEVEMENTS,
  createAchievementService,
} = require("../src/service/achievement.js");

// 构造可注入的服务实例：petInfo / sys 数据 / 内存 store / 记录 setPetInfo 与 openSpeak 调用
function makeService(petInfo, sys = {}) {
  const calls = { setPetInfo: [], openSpeak: [] };
  const mem = { map: {} };
  const service = createAchievementService({
    getPetInfo: () => petInfo,
    setPetInfo: (d) => calls.setPetInfo.push(d),
    openSpeak: (opt) => calls.openSpeak.push(opt),
    getSys: (name) => (name ? sys[name] : sys),
    store: {
      get: () => mem.map,
      set: (m) => {
        mem.map = m;
      },
    },
  });
  return { service, calls, mem };
}

// 基础 petInfo 骨架（字段可覆盖）
function pet(over = {}) {
  return {
    info: { growth: 0, yb: 0, onLineTime: 0, ...(over.info || {}) },
    maxInfo: { level: "", ...(over.maxInfo || {}) },
    fishing: { harvestfish: 0, ...(over.fishing || {}) },
  };
}

// 成长值阈值（取自 src/windows/util/pet/level.js 的 levels 表，level k 对应 levels[k-1]）
// level 5 -> 1100, level 20 -> 63600, level 30 -> 216700
test("破壳而出：等级 5 边界", () => {
  let r = makeService(pet({ info: { growth: 1099 } }));
  assert.deepEqual(r.service.check("levelup"), []);
  r = makeService(pet({ info: { growth: 1100 } }));
  const newly = r.service.check("levelup");
  assert.equal(newly.length, 1);
  assert.equal(newly[0].id, "hatch");
  // 庆祝气泡内容
  assert.equal(r.calls.openSpeak.length, 1);
  assert.ok(r.calls.openSpeak[0].data.data.includes("成就达成：破壳而出"));
});

test("茁壮成长：等级 20 边界", () => {
  let r = makeService(pet({ info: { growth: 63599 } }));
  // 等级 19：只有 hatch 解锁，grow20 不解锁
  assert.deepEqual(
    r.service.check().map((a) => a.id),
    ["hatch"]
  );
  r = makeService(pet({ info: { growth: 63600 } }));
  const ids = r.service.check().map((a) => a.id);
  assert.ok(ids.includes("grow20"));
  assert.ok(ids.includes("hatch")); // 低等级成就一并解锁
});

test("永远的神：等级 30 边界（svg 图标 yyds）", () => {
  // 等级 29：hatch/grow20 会解锁，但 yyds 不解锁
  let r = makeService(pet({ info: { growth: 216699 } }));
  assert.ok(!r.service.check().some((a) => a.id === "yyds"));
  r = makeService(pet({ info: { growth: 216700 } }));
  const ids = r.service.check().map((a) => a.id);
  assert.ok(ids.includes("yyds"));
  const def = ACHIEVEMENTS.find((a) => a.id === "yyds");
  assert.equal(def.icon, "yyds");
});

test("等级优先取 maxInfo.level（主进程已换算值）", () => {
  const r = makeService(pet({ maxInfo: { level: 30 } }));
  const ids = r.service.check().map((a) => a.id);
  assert.ok(ids.includes("yyds"));
});

test("养鱼大师：harvestfish 1000 边界", () => {
  let r = makeService(pet({ fishing: { harvestfish: 999 } }));
  assert.deepEqual(r.service.check(), []);
  r = makeService(pet({ fishing: { harvestfish: 1000 } }));
  const newly = r.service.check("fishing");
  assert.equal(newly.length, 1);
  assert.equal(newly[0].id, "fishMaster");
});

test("环游中国：travel_china 缺失不报错，34 省边界", () => {
  // 字段完全缺失
  let r = makeService(pet());
  assert.deepEqual(r.service.check(), []);
  // 33 个省份不解锁
  r = makeService(pet({ info: { travel_china: new Array(33).fill("x") } }));
  assert.deepEqual(r.service.check(), []);
  // 34 个解锁
  r = makeService(pet({ info: { travel_china: new Array(34).fill("x") } }));
  const newly = r.service.check("travel");
  assert.equal(newly.length, 1);
  assert.equal(newly[0].id, "travelChina");
  // 非数组脏数据不报错
  r = makeService(pet({ info: { travel_china: "bad" } }));
  assert.deepEqual(r.service.check(), []);
});

// 产品定位：离线 + AI 版不设资源门槛，新档默认 yb 为 999999999（src/ini/doMain.js 新宠物分支），
// 所以成就体系里不能存在以元宝存量为判据的成就（原「小富翁」yb >= 10000 开局即达成）。
test("元宝存量不再作为任何成就的判据：新档级巨额元宝不解锁任何成就", () => {
  assert.equal(ACHIEVEMENTS.find((a) => a.id === "rich"), undefined);
  const r = makeService(pet({ info: { yb: 999999999 } }));
  assert.deepEqual(r.service.check("shop"), []);
  assert.equal(r.calls.openSpeak.length, 0);
  assert.equal(r.calls.setPetInfo.length, 0);
  // 全部定义在「只有巨额元宝」的存档下都应是未解锁
  assert.deepEqual(
    r.service.getAll().filter((a) => a.unlocked),
    []
  );
});

// 签到状态的权威存储是 sys.signin（signIn.js 走 setSys；info.signin 不在 ini/pet.js 的
// 默认 info 表里，会被 setPetInfo 静默丢弃）。原用例直接注入 info.signin，这个前置条件
// 生产环境永远不成立 —— 属于假绿测试，这里改成经 getSys 的真实链路。
// 端到端链路（signIn.doSignIn -> sys.signin -> 成就解锁）另见 test/achievementSignin.test.js。
test("签到达人：streak 取自 sys.signin，7 天边界", () => {
  // 无签到记录：不报错也不解锁
  let r = makeService(pet());
  assert.deepEqual(r.service.check("signin"), []);
  // 连签 6 天：不解锁
  r = makeService(pet(), { signin: { streak: 6 } });
  assert.deepEqual(r.service.check("signin"), []);
  // 连签 7 天：解锁
  r = makeService(pet(), { signin: { streak: 7 } });
  const newly = r.service.check("signin");
  assert.equal(newly.length, 1);
  assert.equal(newly[0].id, "signMaster");
});

test("忠实陪伴：onLineTime 单位为分钟，100 小时 = 6000 分钟", () => {
  let r = makeService(pet({ info: { onLineTime: 5999 } }));
  assert.deepEqual(r.service.check(), []);
  r = makeService(pet({ info: { onLineTime: 6000 } }));
  const newly = r.service.check("online");
  assert.equal(newly.length, 1);
  assert.equal(newly[0].id, "online100");
});

test("幂等：重复 check 不重复解锁、不重复庆祝", () => {
  const r = makeService(pet({ fishing: { harvestfish: 2000 } }));
  const first = r.service.check();
  assert.equal(first.length, 1);
  assert.equal(first[0].id, "fishMaster");
  const second = r.service.check();
  assert.deepEqual(second, []);
  assert.equal(r.calls.openSpeak.length, 1); // 只庆祝一次
  assert.equal(r.calls.setPetInfo.length, 1); // 只写入一次
});

test("解锁写入 setPetInfo 的 info.achievements（ISO 时间）", () => {
  const r = makeService(pet({ fishing: { harvestfish: 1000 } }));
  r.service.check();
  const arg = r.calls.setPetInfo[0];
  assert.ok(arg.info.achievements.fishMaster);
  assert.doesNotThrow(() =>
    new Date(arg.info.achievements.fishMaster).toISOString()
  );
});

test("getAll：返回全部定义并带解锁状态", () => {
  const r = makeService(pet({ fishing: { harvestfish: 1000 } }));
  r.service.check();
  const all = r.service.getAll();
  assert.equal(all.length, ACHIEVEMENTS.length);
  const fish = all.find((a) => a.id === "fishMaster");
  assert.equal(fish.unlocked, true);
  assert.ok(fish.unlockedAt);
  const hatch = all.find((a) => a.id === "hatch");
  assert.equal(hatch.unlocked, false);
  assert.equal(hatch.unlockedAt, null);
  // 不带 check 函数（可 IPC 序列化）
  assert.equal(typeof fish.check, "undefined");
});

test("getAll 能从 petInfo.info.achievements 读取已解锁（双写并集）", () => {
  const r = makeService(
    pet({ info: { achievements: { hatch: "2026-01-01T00:00:00.000Z" } } })
  );
  const all = r.service.getAll();
  assert.equal(all.find((a) => a.id === "hatch").unlocked, true);
  // 已解锁的不再重复庆祝
  assert.deepEqual(r.service.check(), []);
  assert.equal(r.calls.openSpeak.length, 0);
});

test("空 petInfo / 字段全缺失不抛错", () => {
  const r = makeService({});
  assert.deepEqual(r.service.check(), []);
  assert.equal(r.service.getAll().length, ACHIEVEMENTS.length);
});

// ---- 兜底存储读失败（$Store.getItem 现在上抛，见 src/ini/store.js）----
// aiWiring.js 用 60 秒定时器周期调 check("timer")。若读失败退化成「空表」，
// 每一轮都会把已达成的成就重新判成新解锁：气泡刷屏 + 用残缺表覆盖两路存储。

// 读失败的服务实例：store.get 抛错，其余依赖同 makeService
function makeFailingStoreService(petInfo, sys = {}) {
  const calls = { setPetInfo: [], openSpeak: [], storeSet: [] };
  const err = new Error("store read boom");
  const service = createAchievementService({
    getPetInfo: () => petInfo,
    setPetInfo: (d) => calls.setPetInfo.push(d),
    openSpeak: (opt) => calls.openSpeak.push(opt),
    getSys: (name) => (name ? sys[name] : sys),
    store: {
      get: () => {
        throw err;
      },
      set: (m) => calls.storeSet.push(m),
    },
  });
  return { service, calls, err };
}

test("兜底存储读失败时 check 跳过本轮：不解锁、不庆祝、不落盘", () => {
  const r = makeFailingStoreService(pet({ fishing: { harvestfish: 2000 } }));
  assert.deepEqual(r.service.check("timer"), []);
  assert.equal(r.calls.openSpeak.length, 0, "读不到记录时不得弹庆祝气泡");
  assert.equal(r.calls.setPetInfo.length, 0, "不得把残缺表写回 petInfo");
  assert.equal(r.calls.storeSet.length, 0, "不得把残缺表写回 $Store");
});

test("兜底存储读失败时 check 不上抛（60 秒巡检不因一次读失败断流）", () => {
  const r = makeFailingStoreService(pet({ fishing: { harvestfish: 2000 } }));
  assert.doesNotThrow(() => r.service.check("timer"));
});

test("连续多轮读失败不会重复庆祝：三轮巡检气泡数仍为 0", () => {
  const r = makeFailingStoreService(pet({ info: { growth: 216700 }, fishing: { harvestfish: 2000 } }));
  r.service.check("timer");
  r.service.check("timer");
  r.service.check("timer");
  assert.equal(r.calls.openSpeak.length, 0);
  assert.equal(r.calls.setPetInfo.length, 0);
});

test("读失败只是跳过一轮：下一轮读成功后照常解锁并庆祝（幂等补上）", () => {
  // 前一半用会抛的 store，后一半换成正常内存 store，验证「跳过」不是「永久放弃」
  const calls = { setPetInfo: [], openSpeak: [] };
  const mem = { map: {}, fail: true };
  const petInfo = pet({ fishing: { harvestfish: 2000 } });
  const service = createAchievementService({
    getPetInfo: () => petInfo,
    setPetInfo: (d) => calls.setPetInfo.push(d),
    openSpeak: (opt) => calls.openSpeak.push(opt),
    getSys: () => undefined,
    store: {
      get: () => {
        if (mem.fail) throw new Error("store read boom");
        return mem.map;
      },
      set: (m) => {
        mem.map = m;
      },
    },
  });
  assert.deepEqual(service.check("timer"), []);
  mem.fail = false;
  assert.deepEqual(
    service.check("timer").map((a) => a.id),
    ["fishMaster"]
  );
  assert.equal(calls.openSpeak.length, 1, "恢复后只庆祝一次");
  assert.equal(calls.setPetInfo.length, 1);
});

test("兜底存储读失败时 getAll 不上抛，降级用 petInfo.info.achievements 渲染", () => {
  const ISO = "2026-01-01T00:00:00.000Z";
  const r = makeFailingStoreService(pet({ info: { achievements: { hatch: ISO } } }));
  let all;
  assert.doesNotThrow(() => {
    all = r.service.getAll();
  });
  assert.equal(all.length, ACHIEVEMENTS.length, "面板不得因读失败变空白");
  assert.equal(all.find((a) => a.id === "hatch").unlocked, true);
  assert.equal(all.find((a) => a.id === "hatch").unlockedAt, ISO);
  assert.equal(all.find((a) => a.id === "fishMaster").unlocked, false);
  assert.equal(r.calls.setPetInfo.length, 0, "展示路径不得写存储");
});

// ---- 老存档兼容：已解锁过「小富翁」（id: rich，已从定义表移除）的存档 ----
// 定义表已无 rich，但老存档的 $Store.achievements / info.achievements 里仍有这条记录。

test("老存档残留的 rich 记录：面板不出现未知成就，其它成就记录不丢", () => {
  const ISO = "2026-01-01T00:00:00.000Z";
  const petInfo = pet({
    info: { yb: 999999999, achievements: { rich: ISO } },
    fishing: { harvestfish: 1000 },
  });
  const r = makeService(petInfo);
  // 兜底存储侧也有老记录（双写两路都可能残留）
  r.mem.map = { rich: ISO, hatch: ISO };

  const all = r.service.getAll();
  assert.equal(all.length, ACHIEVEMENTS.length);
  assert.equal(ACHIEVEMENTS.length, 7); // 移除 rich 后为 7 条
  assert.equal(all.some((a) => a.id === "rich"), false); // 不渲染未知成就
  assert.equal(all.find((a) => a.id === "hatch").unlocked, true); // 别的记录仍在
  assert.equal(all.find((a) => a.id === "hatch").unlockedAt, ISO);
  // 渲染层的 unlockedCount / list.length 口径（popups/achievement/index.js + index.html）
  assert.equal(all.filter((a) => a.unlocked).length, 1);

  // check 不因残留记录报错，也不会为它补一次庆祝气泡
  const newly = r.service.check("load");
  assert.deepEqual(newly.map((a) => a.id), ["fishMaster"]);
  assert.equal(r.calls.openSpeak.length, 1);
  assert.ok(r.calls.openSpeak[0].data.data.includes("成就达成：养鱼大师"));
});

test("老存档 rich 记录在后续解锁落盘时被原样保留，不覆盖不删除", () => {
  const ISO = "2026-01-01T00:00:00.000Z";
  const r = makeService(pet({ info: { growth: 1100 } }));
  r.mem.map = { rich: ISO };

  const newly = r.service.check("levelup");
  assert.deepEqual(newly.map((a) => a.id), ["hatch"]);
  // 兜底存储：老记录 + 新记录
  assert.equal(r.mem.map.rich, ISO);
  assert.ok(r.mem.map.hatch);
  // petInfo 侧双写同样带上老记录
  assert.equal(r.calls.setPetInfo.length, 1);
  assert.equal(r.calls.setPetInfo[0].info.achievements.rich, ISO);
  assert.ok(r.calls.setPetInfo[0].info.achievements.hatch);
});

// ---- 钉死 achievement.js 头注释所述的存储机制（放最后：本用例会加载 src/ini/pet.js 并
//      覆写 setPetInfo / getPetInfo 等全局，上面的用例全部走注入依赖，不受影响）----
// 头注释曾断言 info.achievements 会被 setPetInfo 静默丢弃；pet.js 的默认 info 表补上
// achievements:{} 之后这条已不成立。注释与实现漂移过一次，这里用真实 pet.js 钉住。
test("info.achievements 经 ini/pet.js 的 setPetInfo 真的写得进去并随 pet 存档落盘", () => {
  const storeWrites = [];
  global.$Store = { setItem: (k, v) => storeWrites.push([k, v]), getItem: () => ({}) };
  global.windowsMain = { setOpacity: () => {} };
  global.JSONto = (e) => JSON.parse(JSON.stringify(e));
  const PET_PATH = require.resolve("../src/ini/pet.js");
  delete require.cache[PET_PATH];
  require(PET_PATH);

  const ISO = "2026-01-01T00:00:00.000Z";
  globalThis.setPetInfo({ info: { achievements: { hatch: ISO } } });
  assert.deepEqual(
    globalThis.getPetInfo().info.achievements,
    { hatch: ISO },
    "achievements 在默认 info 表里，且对象走引用比较，赋值必定生效"
  );
  const petWrite = storeWrites.filter(([k]) => k === "pet").pop();
  assert.ok(petWrite, "写入 achievements 应触发一次 pet 落盘");
  assert.deepEqual(petWrite[1].info.achievements, { hatch: ISO });

  // 反向对照：不在默认 info 表里的键（signin，见本文件上方签到用例的说明）确实仍被丢弃，
  // 证明上面的断言不是「setPetInfo 什么都收」的恒真结论。
  const before = storeWrites.length;
  globalThis.setPetInfo({ info: { signin: { streak: 7 } } });
  assert.equal(globalThis.getPetInfo().info.signin, undefined, "signin 不在默认表 -> 丢弃");
  assert.equal(storeWrites.length, before, "全部字段被丢弃时不产生落盘");
});
