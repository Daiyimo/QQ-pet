// level.js 等级换算回归测试：封顶行为、单例残留、粉钻顶级可达性、NaN 防护。
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

global.tool = global.tool || { getDayHourTime: () => 0, getTime: () => "2026-07-31" };
const { Level, pinkDiamondLevel } = require(
  path.join(__dirname, "..", "src", "windows", "util", "pet", "level.js")
);

const LEVELS = Level.levels;
const CAP = 400; // README：等级上限 400 级

test("getNowLevel 成长值超过封顶阈值时返回 400 级而非默认值", () => {
  const r = Level.getNowLevel(999999999);
  assert.equal(r.level, CAP);
  assert.equal(r.upGrowth, LEVELS[CAP - 1]);
  assert.equal(r.nextGrowth, LEVELS[CAP]);
});

test("getNowLevel 不会把上一次调用的等级泄漏给下一次调用", () => {
  // 单例 Level 被 GrowUp 与 achievement 共用；旧实现未匹配时直接返回 this.level
  const mid = Level.getNowLevel(200000000);
  assert.ok(mid.level > 1 && mid.level < CAP, "前置：中间等级应正常换算");
  const over = Level.getNowLevel(999999999);
  assert.notEqual(over.level, mid.level, "封顶结果不能等于上一次调用的残留值");
  assert.equal(over.level, CAP);
});

test("getNowLevel 封顶档的 upGrowth/nextGrowth 不为 undefined", () => {
  for (const g of [LEVELS[CAP], LEVELS[CAP] + 1, LEVELS[CAP + 1], 1e12]) {
    const r = Level.getNowLevel(g);
    assert.equal(typeof r.upGrowth, "number", `growth=${g} 的 upGrowth 必须是数字`);
    assert.equal(typeof r.nextGrowth, "number", `growth=${g} 的 nextGrowth 必须是数字`);
    assert.equal(r.level, CAP);
  }
});

test("getNowLevel 等级边界左闭右开", () => {
  assert.equal(Level.getNowLevel(99).level, 1);
  assert.equal(Level.getNowLevel(100).level, 2);
  assert.equal(Level.getNowLevel(299).level, 2);
  assert.equal(Level.getNowLevel(300).level, 3);
  assert.equal(Level.getNowLevel(LEVELS[CAP - 1]).level, CAP);
  assert.equal(Level.getNowLevel(LEVELS[CAP - 1] - 1).level, CAP - 1);
});

test("getNowLevel 非法成长值回落 1 级", () => {
  for (const g of [0, "", null, undefined, NaN, "abc"]) {
    const r = Level.getNowLevel(g);
    assert.equal(r.level, 1);
    assert.equal(r.upGrowth, 0);
    assert.equal(r.nextGrowth, LEVELS[1]);
  }
});

test("粉钻 getNowLevel 顶级 7 可达", () => {
  const r = pinkDiamondLevel.getNowLevel(2800);
  assert.equal(r.level, 7, "levels 有 7 档，2800 起就是 7 级（旧实现最高只能到 6）");
  assert.equal(typeof r.nextGrowth, "number");
  assert.equal(pinkDiamondLevel.getNowLevel(999999).level, 7);
});

test("粉钻 getNowLevel 各档边界", () => {
  const expect = [
    [0, 1],
    [99, 1],
    [100, 2],
    [299, 2],
    [300, 3],
    [1099, 4],
    [1100, 5],
    [1799, 5],
    [1800, 6],
    [2799, 6],
    [2800, 7],
  ];
  for (const [g, lv] of expect) {
    assert.equal(pinkDiamondLevel.getNowLevel(g).level, lv, `growth=${g} 应为 ${lv} 级`);
  }
});

test("粉钻 getNowLevel 首次以封顶成长值调用也不返回 undefined", () => {
  // 旧实现 pinkDiamondFn 缺 level=1 字段初始化，全新进程首调 growth>=2800 得 undefined
  const fresh = new pinkDiamondLevel.constructor();
  const r = fresh.getNowLevel(3000);
  assert.equal(r.level, 7);
  assert.equal(typeof r.upGrowth, "number");
  assert.equal(typeof r.nextGrowth, "number");
});

test("toChangeOtherDatas 等级缺失时钓鱼次数为 0 而非 NaN", () => {
  const r = pinkDiamondLevel.toChangeOtherDatas({ pinkDiamond: true });
  assert.equal(r.fishing.allvipcnt, 0);
  assert.equal(r.fishing.canusecnt, 0);
  assert.ok(Number.isFinite(r.fishing.allvipcnt), "不能是 NaN");
  assert.ok(Number.isFinite(r.fishing.canusecnt), "不能是 NaN");
});

test("toChangeOtherDatas 无粉钻时可用次数恒为 0", () => {
  const r = pinkDiamondLevel.toChangeOtherDatas({ pinkDiamond: false, pinkDiamondLevel: 5 });
  assert.equal(r.fishing.allvipcnt, 10);
  assert.equal(r.fishing.canusecnt, 0);
});

test("toChangeOtherDatas 有粉钻时可用次数为等级 x2", () => {
  const r = pinkDiamondLevel.toChangeOtherDatas({ pinkDiamond: true, pinkDiamondLevel: 7 });
  assert.equal(r.fishing.allvipcnt, 14);
  assert.equal(r.fishing.canusecnt, 14);
});

test("toChangeOtherDatas 非法等级不产生负数次数", () => {
  const r = pinkDiamondLevel.toChangeOtherDatas({ pinkDiamond: true, pinkDiamondLevel: -3 });
  assert.equal(r.fishing.allvipcnt, 0);
  assert.equal(r.fishing.canusecnt, 0);
});
