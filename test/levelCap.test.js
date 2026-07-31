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

test("粉钻顶级返回的区间与 level 自洽（[2800,2800] 表示已满级）", () => {
  // 顶级没有上界阈值。upGrowth 必须是 7 级自己的下界 2800——若返回 6 级的
  // [1800,2800) 就与 level:7 自相矛盾，按 (growth-up)/(next-up) 算进度会 >100%。
  for (const g of [2800, 2801, 5000, 1e9]) {
    const r = pinkDiamondLevel.getNowLevel(g);
    assert.equal(r.level, 7, `growth=${g} 应为 7 级`);
    assert.equal(r.upGrowth, 2800, `growth=${g} 的 upGrowth 应是 7 级下界 2800`);
    assert.equal(r.nextGrowth, 2800, `growth=${g} 无下一档，nextGrowth 同为 2800`);
  }
});

test("粉钻 6 级区间不受顶级改动影响", () => {
  const r = pinkDiamondLevel.getNowLevel(1800);
  assert.deepEqual([r.upGrowth, r.nextGrowth, r.level], [1800, 2800, 6]);
  const r2 = pinkDiamondLevel.getNowLevel(2799);
  assert.deepEqual([r2.upGrowth, r2.nextGrowth, r2.level], [1800, 2800, 6]);
});

test("粉钻顶级时 isExpirationDate 的 growthValue_next 不会被 ||100 兜底吃掉", () => {
  // nextGrowth 若返回 0/undefined，isExpirationDate 里的 `nextGrowth || 100`
  // 会把下一档阈值错显成 100
  const now = Date.now();
  const DAY = 1000 * 60 * 60 * 24;
  const opt = pinkDiamondLevel.isExpirationDate({
    growth: 3000,
    growthValue: 20,
    pinkDiamond: true,
    pinkDiamondLevel: 7,
    pinkDiamondBeginDate: now - 2 * DAY,
    pinkDiamondExpirationDate: now + 2 * DAY,
  });
  assert.equal(opt.pinkDiamondLevel, 7);
  assert.equal(opt.growthValue_next, 2800, "应为 2800，不能是 100");
});

test("主表 LevelFn 的封顶区间未被粉钻改动波及", () => {
  // 主表有 402 项，400 级的区间 [levels[399], levels[400]) 本来就是自洽的，不该改成零宽
  const r = Level.getNowLevel(999999999);
  assert.equal(r.level, CAP);
  assert.equal(r.upGrowth, LEVELS[CAP - 1]);
  assert.equal(r.nextGrowth, LEVELS[CAP]);
  assert.notEqual(r.upGrowth, r.nextGrowth, "主表封顶区间不是零宽");
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
