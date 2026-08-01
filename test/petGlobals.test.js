// src/ini/pet.js（压缩产物）全局函数回归测试：
//   1. getSys(key) 不再把存储的 false / 0 / "" 吞成 undefined（原来是 `e.system[t]||void 0`）。
//   2. getPetInfo() 返回深拷贝，调用方改返回值的嵌套字段不会污染内部状态
//      （原来是 `{...e}` 浅拷贝，info/activeOption/fishing 等与内部状态共享引用）。
//   3. addPetInfo 加下限 0 钳制（原来只钳上限 `a>M?M:a`，属性可被扣成负数）。
//
// pet.js 是纯全局函数模块，加载期不碰 electron；只需补 JSONto（tool.js 在 init.js 里
// 先于 pet.js 加载，测试里手工补同名桩）、$Store 持久化桩与 windowsMain 桩。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const PET_PATH = require.resolve("../src/ini/pet.js");

// setPetInfo 落盘走 $Store.setItem，这里只记录不持久化
const storeWrites = [];
global.$Store = {
  setItem: (k, v) => storeWrites.push([k, v]),
  getItem: () => ({}),
};
// setSys 非 init 分支会调 windowsMain.setOpacity，本测试只用 init 分支，桩住即可
global.windowsMain = { setOpacity: () => {} };
global.JSONto = (e) => JSON.parse(JSON.stringify(e));

delete require.cache[PET_PATH];
require(PET_PATH);

test("getSys: false / 0 / 空串原样返回，不再吞成 undefined", () => {
  setSys({ init: { flagOff: false, zero: 0, empty: "", on: true, obj: { x: 1 } } });
  assert.equal(getSys("flagOff"), false);
  assert.equal(getSys("zero"), 0);
  assert.equal(getSys("empty"), "");
  assert.equal(getSys("on"), true);
  assert.deepEqual(getSys("obj"), { x: 1 });
  // 未设置的键仍是 undefined
  assert.equal(getSys("neverSet"), undefined);
  // 无参仍返回整个 sys 对象（aiWiring / perception loop 的原始值判定依赖这个）
  const whole = getSys();
  assert.equal(whole.flagOff, false);
  assert.equal(whole.zero, 0);
});

test("getPetInfo: 返回深拷贝，改返回值嵌套字段不影响内部状态", () => {
  const before = getPetInfo();
  // 篡改返回值的各个嵌套分支
  before.info.yb = -999;
  before.info.achievements.fake = true;
  before.activeOption.ill = { name: "x" };
  before.otherOptions.pinkDiamond = true;
  before.maxInfo.mood = 1;
  before.fishing.fishes.push("ghost");
  before.activeValue.study.chinese = 999;

  const after = getPetInfo();
  assert.notEqual(after.info.yb, -999);
  assert.deepEqual(after.info.achievements, {});
  assert.equal(after.activeOption.ill, null);
  assert.equal(after.otherOptions.pinkDiamond, false);
  assert.notEqual(after.maxInfo.mood, 1);
  assert.equal(after.fishing.fishes.length, 0);
  assert.equal(after.activeValue.study.chinese, 0);

  // 两次调用返回的对象（含嵌套）不是同一引用
  const p1 = getPetInfo();
  const p2 = getPetInfo();
  assert.notEqual(p1, p2);
  assert.notEqual(p1.info, p2.info);
  assert.notEqual(p1.activeOption, p2.activeOption);

  // system / cache / listenMain 仍被剔除
  assert.equal("system" in p1, false);
  assert.equal("cache" in p1, false);
  assert.equal("listenMain" in p1, false);
});

test("getSys: 存档 sys 为类型损坏的真值原始值时降级返回 undefined，不抛 TypeError", () => {
  // `t in e.system` 对原始值会抛 "Cannot use 'in' operator"，
  // pet.js 已加 typeof 守卫：损坏的 sys 视为无此键（与旧 `||` 实现的降级行为对齐）
  setSys({ init: 5 });
  assert.doesNotThrow(() => getSys("doNotDisturb"));
  assert.equal(getSys("doNotDisturb"), undefined);
  // 恢复正常对象后行为如常
  setSys({ init: { flagOff: false } });
  assert.equal(getSys("flagOff"), false);
});

test("addPetInfo: 下限钳到 0、上限钳到 maxInfo、正常增减不受影响", () => {
  setPetInfo({ info: { mood: 100, hunger: 50 }, maxInfo: { mood: 1000, hunger: 3300 } });

  // 扣穿下限：-500 应钳到 0（setPetInfo 会把数值 0 回写成字符串 "0"，历史配套语义）
  addPetInfo({ mood: -500 });
  assert.equal(+getPetInfo().info.mood, 0);

  // 普通扣减不触发钳制
  addPetInfo({ hunger: -20 });
  assert.equal(+getPetInfo().info.hunger, 30);

  // 上限钳制保持原行为
  addPetInfo({ mood: 99999 });
  assert.equal(+getPetInfo().info.mood, 1000);

  // 恰好扣到 0 也是合法的
  addPetInfo({ hunger: -30 });
  assert.equal(+getPetInfo().info.hunger, 0);
});
