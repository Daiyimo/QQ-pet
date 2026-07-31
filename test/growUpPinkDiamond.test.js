// GrowUp.js 回归测试：粉钻过期结算顺序、内嵌等级表封顶、成长率权重表的非数字守卫。
//
// 注意：GrowUp.js 是 webpack 压缩产物，内部**自带一份 level.js 的副本**（模块 527），
// 宠物成长主循环走的是这份内嵌副本而不是 src/windows/util/pet/level.js。
// 因此等级/粉钻的修复必须在两处都验证，本文件覆盖内嵌副本。
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// ---- 全局桩 ----
let petInfo;
let writes; // setPetInfo 收到的全部载荷

global.getPetInfo = () => JSON.parse(JSON.stringify(petInfo));
global.setPetInfo = (d) => {
  writes.push(JSON.parse(JSON.stringify(d)));
  for (const g of Object.keys(d)) {
    petInfo[g] = { ...(petInfo[g] || {}), ...d[g] };
  }
};
global.JSONto = (e) => JSON.parse(JSON.stringify(e));
global.isNumber = (e) => (+e == +e && +e) || 0;
global.getRandom = (a, b) => (b === undefined ? 0 : a);
global.getRatio = () => false;
global.isStudyUpLevel = () => false;
global.addGoods = () => {};
global.$test = false;
// 与 src/ini/tool.js 同实现（匹配则返回键，否则返回 0）
global.getInterval = (e, t) => {
  let r = 0;
  for (let a in t) {
    if ("object" != typeof t[a]) {
      if (t[a]) {
        r = a;
        break;
      }
    } else if (+e <= t[a][1] && +e >= t[a][0]) {
      r = a;
      break;
    }
  }
  return r;
};
global.tool = {
  getTime: ({ addDay = 0 } = {}) => {
    const d = new Date(2026, 6, 31);
    d.setDate(d.getDate() + +addDay);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  },
  getDayHourTime: () => new Date(2026, 6, 31, 6, 0).getTime(),
};

const { GrowUp } = require(
  path.join(__dirname, "..", "src", "windows", "util", "pet", "GrowUp.js")
);

const DAY = 864e5;

function basePetInfo(over = {}) {
  return {
    info: {
      growth: 1000,
      hunger: 3000,
      clean: 3000,
      mood: 500,
      health: 5,
      onLineTime: 0,
      onlineDataTime: 0,
      lastLoginTime: 0,
      ...(over.info || {}),
    },
    maxInfo: { stopGrowth: false, growthRate: 260, hunger: 3300, clean: 3300, mood: 1000, health: 5, ...(over.maxInfo || {}) },
    activeOption: { work: null, study: null, trip: null, ill: null, background: null, ...(over.activeOption || {}) },
    activeValue: { study: {}, work: {} },
    otherOptions: {
      pinkDiamond: false,
      growth: 0,
      growthValue: 0,
      pinkDiamondLevel: 0,
      pinkDiamondBeginDate: 0,
      pinkDiamondExpirationDate: 0,
      sweetHeart: false,
      ...(over.otherOptions || {}),
    },
    fishing: { allvipcnt: 0, canusecnt: 0, harvestfish: 0, fishes: [] },
  };
}

// 构造实例（构造函数会调 doChangeMaxInfo -> setPetInfo），返回实例并清空写入记录
function makeGrowUp(over) {
  petInfo = basePetInfo(over);
  writes = [];
  const gu = new GrowUp({ petInfo: JSON.parse(JSON.stringify(petInfo)), callBackState: () => {} });
  return gu;
}

// 触发一次「跨天结算」：lastLoginTime 在过去 + stopGrowth 让 GrowUpMain 结算完即返回
function runDailyRollover(over) {
  const gu = makeGrowUp({
    ...over,
    info: { lastLoginTime: Date.now() - 1000, ...((over && over.info) || {}) },
    maxInfo: { stopGrowth: true, ...((over && over.maxInfo) || {}) },
  });
  writes = [];
  gu.GrowUpMain();
  return writes;
}

// ------------------------------------------------ 粉钻过期结算顺序

test("粉钻过期当天不再发放钓鱼 VIP 可用次数", () => {
  const w = runDailyRollover({
    otherOptions: {
      pinkDiamond: true,
      pinkDiamondLevel: 5,
      growth: 1200,
      growthValue: 20,
      pinkDiamondBeginDate: Date.now() - 3 * DAY,
      pinkDiamondExpirationDate: Date.now() - 1000, // 刚过期
    },
  });
  const payload = w.find((x) => x.otherOptions || x.fishing);
  assert.ok(payload, "跨天分支应写入 otherOptions/fishing");
  assert.equal(payload.otherOptions.pinkDiamond, false, "前置：粉钻应判为已过期");
  assert.equal(
    payload.fishing.canusecnt,
    0,
    "toChangeOtherDatas 必须吃到结算后的状态；旧实现传旧值会白送一天 VIP 次数"
  );
});

test("粉钻生效期内跨天照常发放钓鱼 VIP 可用次数", () => {
  const w = runDailyRollover({
    otherOptions: {
      pinkDiamond: true,
      pinkDiamondLevel: 5,
      growth: 1200,
      growthValue: 20,
      pinkDiamondBeginDate: Date.now() - 3 * DAY,
      pinkDiamondExpirationDate: Date.now() + 2 * DAY,
    },
  });
  const payload = w.find((x) => x.fishing);
  assert.equal(payload.otherOptions.pinkDiamond, true);
  assert.equal(payload.fishing.canusecnt, payload.fishing.allvipcnt);
  assert.ok(payload.fishing.canusecnt > 0);
});

test("从未开通粉钻时跨天不产生 NaN 钓鱼次数", () => {
  const w = runDailyRollover({});
  const payload = w.find((x) => x.fishing);
  assert.ok(payload, "跨天分支总会写 fishing");
  assert.ok(Number.isFinite(payload.fishing.allvipcnt), "allvipcnt 不能是 NaN");
  assert.ok(Number.isFinite(payload.fishing.canusecnt), "canusecnt 不能是 NaN");
  assert.equal(payload.fishing.canusecnt, 0);
});

// ------------------------------------------------ 内嵌等级表封顶

test("内嵌等级表：成长值封顶时 maxInfo.level 为 400 且阈值不为 undefined", () => {
  petInfo = basePetInfo({ info: { growth: 999999999 } });
  writes = [];
  const gu = new GrowUp({ petInfo: JSON.parse(JSON.stringify(petInfo)), callBackState: () => {} });
  gu.doChangeMaxInfo(JSON.parse(JSON.stringify(petInfo)));
  const w = writes.filter((x) => x.maxInfo).pop();
  assert.equal(w.maxInfo.level, 400);
  assert.equal(typeof w.maxInfo.upGrowth, "number");
  assert.equal(typeof w.maxInfo.nextGrowth, "number");
});

test("内嵌等级表：不会把上次换算的等级泄漏给封顶调用", () => {
  petInfo = basePetInfo();
  writes = [];
  const gu = new GrowUp({ petInfo: JSON.parse(JSON.stringify(petInfo)), callBackState: () => {} });
  gu.doChangeMaxInfo(basePetInfo({ info: { growth: 200000000 } }));
  const mid = writes.filter((x) => x.maxInfo).pop().maxInfo.level;
  gu.doChangeMaxInfo(basePetInfo({ info: { growth: 999999999 } }));
  const over = writes.filter((x) => x.maxInfo).pop().maxInfo.level;
  assert.notEqual(over, mid);
  assert.equal(over, 400);
});

test("内嵌等级表：普通成长值换算正确", () => {
  petInfo = basePetInfo();
  writes = [];
  const gu = new GrowUp({ petInfo: JSON.parse(JSON.stringify(petInfo)), callBackState: () => {} });
  gu.doChangeMaxInfo(basePetInfo({ info: { growth: 100 } }));
  assert.equal(writes.filter((x) => x.maxInfo).pop().maxInfo.level, 2);
});

// ---- 内嵌粉钻等级表（成长主循环走的就是这份，standalone 那份见 levelCap.test.js）----

test("内嵌粉钻表：成长值 >=2800 时顶级 7 可达（不是停在 6）", () => {
  const DAY_MS = 864e5;
  const w = runDailyRollover({
    otherOptions: {
      pinkDiamond: true,
      pinkDiamondLevel: 6,
      growth: 3000, // 已过 2800 阈值
      growthValue: 20,
      pinkDiamondBeginDate: Date.now() - 2 * DAY_MS,
      pinkDiamondExpirationDate: Date.now() + 5 * DAY_MS,
    },
  });
  const payload = w.find((x) => x.otherOptions);
  assert.ok(payload, "跨天分支应写入 otherOptions");
  assert.equal(
    payload.otherOptions.pinkDiamondLevel,
    7,
    "内嵌副本旧实现循环到 k<=7 时比较 levels[7]=undefined，7 级不可达"
  );
});

test("内嵌粉钻表：顶级的 growthValue_next 为 2800，不被 ||100 兜底吃掉", () => {
  const DAY_MS = 864e5;
  const w = runDailyRollover({
    otherOptions: {
      pinkDiamond: true,
      pinkDiamondLevel: 7,
      growth: 5000,
      growthValue: 20,
      pinkDiamondBeginDate: Date.now() - 2 * DAY_MS,
      pinkDiamondExpirationDate: Date.now() + 5 * DAY_MS,
    },
  });
  const payload = w.find((x) => x.otherOptions);
  assert.equal(payload.otherOptions.pinkDiamondLevel, 7);
  assert.equal(
    payload.otherOptions.growthValue_next,
    2800,
    "nextGrowth 若为 0/undefined，isExpirationDate 的 `||100` 会把阈值错显成 100"
  );
});

test("内嵌粉钻表：顶级换算出的钓鱼次数为 7*2=14（不是 NaN、不是 12）", () => {
  const DAY_MS = 864e5;
  const w = runDailyRollover({
    otherOptions: {
      pinkDiamond: true,
      pinkDiamondLevel: 6,
      growth: 3000,
      growthValue: 20,
      pinkDiamondBeginDate: Date.now() - 2 * DAY_MS,
      pinkDiamondExpirationDate: Date.now() + 5 * DAY_MS,
    },
  });
  const payload = w.find((x) => x.fishing);
  assert.ok(payload, "跨天分支应写入 fishing");
  assert.equal(payload.fishing.allvipcnt, 14, "顶级 7 级 -> 14 次");
  assert.equal(payload.fishing.canusecnt, 14);
});

test("内嵌粉钻表：未到 2800 时仍是 6 级（顶级改动不影响下一档）", () => {
  const DAY_MS = 864e5;
  const w = runDailyRollover({
    otherOptions: {
      pinkDiamond: true,
      pinkDiamondLevel: 5,
      growth: 1800,
      growthValue: 0, // 不额外累加，保持在 1800
      pinkDiamondBeginDate: Date.now() - 2 * DAY_MS,
      pinkDiamondExpirationDate: Date.now() + 5 * DAY_MS,
    },
  });
  const payload = w.find((x) => x.otherOptions);
  assert.equal(payload.otherOptions.pinkDiamondLevel, 6);
  assert.equal(payload.otherOptions.growthValue_next, 2800);
});

// ------------------------------------------------ 成长率权重表守卫

test("getEffectGrowthRate：健康值非数字时按最差健康扣权重，不当成满健康", () => {
  const gu = makeGrowUp();
  const good = gu.getEffectGrowthRate(basePetInfo({ info: { health: 5, mood: 950 } }));
  const bad = gu.getEffectGrowthRate(basePetInfo({ info: { health: "坏了", mood: 950 } }));
  assert.ok(good > 0, "满健康满心情应有正成长率");
  assert.equal(bad, 0, "健康值非数字应触发守卫权重 500，成长率归零（旧实现按 0 扣、等于满健康）");
});

test("getEffectGrowthRate：心情非数字时按守卫权重扣减", () => {
  const gu = makeGrowUp();
  const best = gu.getEffectGrowthRate(basePetInfo({ info: { mood: 950, health: 5 } }));
  const nan = gu.getEffectGrowthRate(basePetInfo({ info: { mood: "坏了", health: 5 } }));
  assert.ok(nan < best, "心情非数字不能拿到与最佳心情相同的成长率");
  assert.equal(best - nan, 100, "守卫权重应为 100");
});

test("getEffectGrowthRate：数字字符串仍按数值档位计算（不被守卫误伤）", () => {
  // ini/pet.js 的 setPetInfo 会把归零的数值字段写成字符串 "0"，守卫不能把它判成非数字
  const gu = makeGrowUp();
  const strZero = gu.getEffectGrowthRate(basePetInfo({ info: { mood: "0", health: 5 } }));
  const numZero = gu.getEffectGrowthRate(basePetInfo({ info: { mood: 0, health: 5 } }));
  assert.equal(strZero, numZero, '"0" 与 0 必须得到同一成长率');
});

test("getEffectGrowthRate：各心情档位权重递减", () => {
  const gu = makeGrowUp();
  const at = (mood) => gu.getEffectGrowthRate(basePetInfo({ info: { mood, health: 5 } }));
  assert.ok(at(950) > at(800), "心情越高成长率越高");
  assert.ok(at(800) > at(600));
  assert.ok(at(600) > at(400));
  assert.ok(at(400) > at(200));
  assert.ok(at(200) > at(50));
});

test("getEffectGrowthRate 结果不为负", () => {
  const gu = makeGrowUp();
  const r = gu.getEffectGrowthRate(basePetInfo({ info: { mood: 0, health: 0, hunger: 0, clean: 0 } }));
  assert.ok(r >= 0, "成长率不能为负");
});
