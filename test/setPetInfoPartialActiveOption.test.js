// src/ini/pet.js 的 setPetInfo：activeOption / activeValue 分支「部分写入」回归测试。
//
// 修复的缺陷（P0 数据丢失）：
//   setPetInfo 的 activeOption / activeValue 两个分支遍历的是**内存**的键集合，
//   却只判 `r[t]!=e.activeOption[t]`，缺少兄弟分支都有的「键缺失」守卫
//   （info 用 `!l[t]&&0!==l[t]`、maxInfo 用 `!s[t]&&0!==s[t]&&!1!==s[t]`、
//     otherOptions / fishing 用 `null!=c[t]`）。
//   调用方只传子集时未传的键取到 undefined，而 `undefined != {对象}` 恒为真，
//   于是该键被写成 undefined 并广播 + 落盘（JSON.stringify 直接丢键）。
//
//   真实触发路径：src/ini/dataWatcher.js 的 60 秒心跳写盘 → watch 事件 → reload()
//   → pickChangedKeys 把深度相等的引用类型键（打工中的 activeOption.work）过滤掉
//   → payload 只剩 {study:null,trip:null,ill:null,die:null,background:null}
//   → 进行中的打工/上学/旅行会话被静默取消。
//
// 注意：test/dataWatcher.test.js 里的同类用例用的是**桩** setPetInfo，从未与真实
//       pet.js 对接过，正是它让这个 bug 假绿。本文件加载真实的 src/ini/pet.js。
//
// 被测源码路径可用 QQ_PET_SRC 覆盖，专为「变异测试/回滚验证」准备（与
// test/dataWatcher.test.js 的 QQ_DATA_WATCHER_SRC 同一套约定）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PET_PATH = process.env.QQ_PET_SRC
  ? path.resolve(process.env.QQ_PET_SRC)
  : require.resolve("../src/ini/pet.js");

// pet.js 是纯全局函数模块，加载期不碰 electron；按 test/petGlobals.test.js 的既有模式
// 补 $Store 持久化桩、windowsMain 桩与 JSONto（tool.js 在 init.js 里先于 pet.js 加载）。
const storeWrites = [];
global.$Store = {
  setItem: (k, v) => storeWrites.push([k, v]),
  getItem: () => ({}),
};
global.windowsMain = { setOpacity: () => {} };
global.JSONto = (e) => JSON.parse(JSON.stringify(e));

delete require.cache[PET_PATH];
require(PET_PATH);

// 广播监听：setPetInfo 有变更时会推给 listenMain.pet 的每个订阅者
const broadcasts = [];
listenInfo({ event: "pet", name: "partialActiveOptionTest", fn: (v) => broadcasts.push(v) });

/** 一份「正在打工」的会话对象，形状对齐 activeOption.work 的真实用法 */
function makeWorkSession() {
  return { name: "coder", beginTime: 1754000000000, overTime: 1754003600000, yb: 120 };
}

/** dataWatcher.pickChangedKeys 的产物：深度相等的引用类型键（work）已被丢弃 */
function heartbeatPayloadWithoutWork() {
  return { study: null, trip: null, ill: null, die: null, background: null };
}

test("activeOption：只传子集时，未传的 work 会话必须原样保留（不得被写成 undefined）", () => {
  const work = makeWorkSession();
  setPetInfo({
    activeOption: { work, study: null, trip: null, ill: null, die: null, background: null },
  });
  assert.deepEqual(getPetInfo().activeOption.work, work, "前置条件：work 会话应已写入内存");

  const writesBefore = storeWrites.length;
  const broadcastsBefore = broadcasts.length;

  // 心跳 reload 的真实 payload：work 因深度相等被 pickChangedKeys 丢掉
  setPetInfo({ activeOption: heartbeatPayloadWithoutWork() });

  const after = getPetInfo().activeOption;
  assert.equal("work" in after, true, "work 键不得消失（undefined 会被 JSON.stringify 丢键）");
  assert.deepEqual(after.work, work, "进行中的打工会话不得被子集写入抹掉");
  // 这一轮所有传入的键都与内存相等 → 不应产生任何变更、落盘与广播
  assert.equal(storeWrites.length, writesBefore, "无实际变更时不得落盘");
  assert.equal(broadcasts.length, broadcastsBefore, "无实际变更时不得广播");
});

test("activeValue：只传子集时，未传的 work 明细必须原样保留", () => {
  const work = { total: 7, todayYb: 30 };
  setPetInfo({ activeValue: { work, study: { chinese: 1 } } });
  assert.deepEqual(getPetInfo().activeValue.work, work, "前置条件：activeValue.work 应已写入");

  // 只传 study，不传 work
  setPetInfo({ activeValue: { study: { chinese: 2 } } });

  const after = getPetInfo().activeValue;
  assert.equal("work" in after, true, "activeValue.work 键不得消失");
  assert.deepEqual(after.work, work, "未传的 activeValue.work 不得被抹掉");
  assert.deepEqual(after.study, { chinese: 2 }, "显式传入的 study 仍应正常更新");
});

test("清空语义不得误伤：显式传 null 必须能把 activeOption.work 置空", () => {
  setPetInfo({ activeOption: { work: makeWorkSession() } });
  assert.notEqual(getPetInfo().activeOption.work, null, "前置条件：work 应为会话对象");

  const writesBefore = storeWrites.length;
  setPetInfo({ activeOption: { work: null } });

  assert.equal(getPetInfo().activeOption.work, null, "null 是「已清空」的合法真值，必须写得进去");
  assert.equal(storeWrites.length, writesBefore + 1, "清空是真实变更，必须落盘");

  // activeValue 分支同理
  setPetInfo({ activeValue: { work: { total: 1 } } });
  setPetInfo({ activeValue: { work: null } });
  assert.equal(getPetInfo().activeValue.work, null, "activeValue 的清空语义同样不得被守卫挡掉");
});

test("正常路径：传完整对象且值有变时，变更被应用且广播 / 落盘照常", () => {
  setPetInfo({
    activeOption: { work: null, study: null, trip: null, ill: null, die: null, background: null },
  });

  const writesBefore = storeWrites.length;
  const broadcastsBefore = broadcasts.length;

  const work = makeWorkSession();
  const ill = { health: 0, overTime: 1754007200000 };
  setPetInfo({
    activeOption: { work, study: null, trip: null, ill, die: null, background: null },
  });

  const after = getPetInfo().activeOption;
  assert.deepEqual(after.work, work, "变更的 work 必须写入");
  assert.deepEqual(after.ill, ill, "变更的 ill 必须写入");
  assert.equal(after.study, null, "未变更的 null 键保持 null");

  assert.equal(storeWrites.length, writesBefore + 1, "有变更必须落盘一次");
  const [key, saved] = storeWrites[storeWrites.length - 1];
  assert.equal(key, "pet");
  assert.deepEqual(saved.activeOption.work, work, "落盘内容必须包含新的 work 会话");

  assert.equal(broadcasts.length, broadcastsBefore + 1, "有变更必须广播一次");
  assert.deepEqual(
    broadcasts[broadcasts.length - 1].activeOption.work,
    work,
    "广播内容必须包含新的 work 会话"
  );
});
