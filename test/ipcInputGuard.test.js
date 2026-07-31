// ipcInputGuard.js 单元测试：主进程 IPC 入参归一化 / 协议白名单 / 下标越界防护
// 运行：node --test test/ipcInputGuard.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_FISHES,
  isAllowedNavUrl,
  normalizePositiveNumber,
  normalizeFishes,
  normalizeFishingSave,
  wantsPetInfo,
  pickActiveOptionKey,
  resolveGiftIndex,
} = require("../src/windows/util/ipcInputGuard.js");

test("isAllowedNavUrl 只放行 http/https", () => {
  assert.equal(isAllowedNavUrl("http://example.com/a?b=1"), true);
  assert.equal(isAllowedNavUrl("https://www.bilibili.com/video/BV1/"), true);
  // 越权协议：file 可读本地文件、javascript/data 可执行脚本
  assert.equal(isAllowedNavUrl("file:///C:/Windows/win.ini"), false);
  assert.equal(isAllowedNavUrl("FILE:///C:/x"), false);
  assert.equal(isAllowedNavUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedNavUrl("data:text/html,<script>1</script>"), false);
  assert.equal(isAllowedNavUrl("about:blank"), false);
});

test("isAllowedNavUrl 对非字符串/非法 URL 返回 false 且不抛", () => {
  for (const bad of [undefined, null, "", 123, {}, [], "not a url", "://x"]) {
    assert.equal(isAllowedNavUrl(bad), false);
  }
});

test("normalizePositiveNumber 拒非有限数、拒负数、按 allowZero 决定 0 是否写入", () => {
  assert.deepEqual(normalizePositiveNumber(100), { apply: true, value: 100, clamped: false });
  assert.equal(normalizePositiveNumber("250").value, 250);
  assert.equal(normalizePositiveNumber(3.9).value, 3); // 截断为整数

  // 显式 0：默认不写入，allowZero 时必须写入（钓鱼 canusecnt 用完归零依赖这条）
  assert.deepEqual(normalizePositiveNumber(0), { apply: false, value: 0, reason: "zero" });
  assert.deepEqual(normalizePositiveNumber(0, { allowZero: true }), {
    apply: true,
    value: 0,
    reason: undefined,
  });
  assert.equal(normalizePositiveNumber("0", { allowZero: true }).apply, true);
  assert.equal(normalizePositiveNumber("0", { allowZero: true }).value, 0);

  // 空字符串 / 纯空白 ≠ 0：cookie 读不到时不能当成归零（Number("")===0 的坑）
  for (const empty of ["", "   ", "\t", null, undefined]) {
    const r = normalizePositiveNumber(empty, { allowZero: true });
    assert.equal(r.apply, false, "should reject empty " + JSON.stringify(empty));
    assert.equal(r.reason, "empty");
  }

  // 负数：钳到 0 但不写入（写 0 会直接清空玩家数值）
  const neg = normalizePositiveNumber(-500, { allowZero: true });
  assert.equal(neg.apply, false);
  assert.equal(neg.value, 0);
  assert.equal(neg.clamped, true);
  assert.equal(neg.reason, "negative");

  // 非有限数一律拒绝，即使 allowZero
  for (const bad of [NaN, Infinity, -Infinity, "abc"]) {
    const r = normalizePositiveNumber(bad, { allowZero: true });
    assert.equal(r.apply, false, "should reject " + String(bad));
    assert.equal(r.reason, "not-finite");
  }
  // 类型防护：Number([])===0 / Number([5])===5，不判类型会被当成合法数值
  for (const bad of [{}, [], [5], true, false, () => 1]) {
    const r = normalizePositiveNumber(bad, { allowZero: true });
    assert.equal(r.apply, false, "should reject " + JSON.stringify(bad));
    assert.equal(r.reason, "bad-type");
  }

  // 上限钳制
  const big = normalizePositiveNumber(Number.MAX_SAFE_INTEGER + 1000);
  assert.equal(big.apply, true);
  assert.equal(big.value, Number.MAX_SAFE_INTEGER);
  assert.equal(big.clamped, true);
});

test("normalizeFishes 接受数组/JSON 字符串，拒非数组与超长", () => {
  assert.deepEqual(normalizeFishes([{ id: 1 }]).value, [{ id: 1 }]);
  assert.deepEqual(normalizeFishes('[{"id":2}]').value, [{ id: 2 }]);
  assert.equal(normalizeFishes("{oops").apply, false);
  assert.equal(normalizeFishes("{oops").reason, "bad-json");
  assert.equal(normalizeFishes('{"a":1}').reason, "not-array");
  assert.equal(normalizeFishes(new Array(MAX_FISHES + 1).fill(0)).reason, "too-long");
  assert.equal(normalizeFishes(new Array(MAX_FISHES).fill(0)).apply, true);
});

test("normalizeFishingSave 正常入参产出可用 patch", () => {
  const r = normalizeFishingSave({
    fishes: '[{"id":1}]',
    harvestfish: 3,
    canusecnt: 2,
    yb: 1000,
    getPetInfo: true,
  });
  assert.deepEqual(r.patch, {
    fishing: { fishes: [{ id: 1 }], harvestfish: 3, canusecnt: 2 },
    info: { yb: 1000 },
  });
  assert.deepEqual(r.fishes, [{ id: 1 }]);
  assert.equal(r.hasChange, true);
  assert.deepEqual(r.rejected, []);
});

test("normalizeFishingSave 拦掉负元宝/NaN/超长数组，且逐项记录原因", () => {
  const r = normalizeFishingSave({
    yb: -999999,
    harvestfish: "abc",
    fishes: new Array(MAX_FISHES + 5).fill(0),
  });
  // 负元宝不会写进存档（钳到 0 也不写，否则等于清空余额）
  assert.equal(r.patch.info, undefined);
  assert.equal(r.hasChange, false);
  assert.deepEqual(r.rejected.sort(), ["fishes:too-long", "harvestfish:not-finite", "yb:negative"].sort());
});

test("经济漏洞回归：canusecnt/harvestfish 归零必须落盘", () => {
  // indexOnLine.js 用完次数后 setCookie("canusecnt",0,true)，
  // 旧实现把 0 丢弃 → 存档留着旧的 1 → 关窗重开白送一次粉钻钓鱼次数
  const r = normalizeFishingSave({ canusecnt: 0, harvestfish: 0 });
  assert.deepEqual(r.patch, { fishing: { harvestfish: 0, canusecnt: 0 } });
  assert.equal(r.hasChange, true);
  assert.deepEqual(r.rejected, []);

  // 渲染层是 getCookie 原样透传，字符串 "0" 同样要落盘
  const s = normalizeFishingSave({ canusecnt: "0" });
  assert.deepEqual(s.patch, { fishing: { canusecnt: 0 } });
  assert.equal(s.hasChange, true);
});

test("cookie 读不到时（空字符串）不得把 canusecnt/harvestfish 当成归零", () => {
  const r = normalizeFishingSave({ canusecnt: "", harvestfish: "  " });
  assert.deepEqual(r.patch, {});
  assert.equal(r.hasChange, false);
  assert.deepEqual(r.rejected.sort(), ["canusecnt:empty", "harvestfish:empty"].sort());
});

test("经济漏洞回归：元宝正好花到 0 也必须落盘（IPC 路径拿到的是字符串 \"0\"）", () => {
  // 曾按「渲染层 +getCookie('yb') 把空 cookie 变成 0，不可区分」保守丢弃 0，
  // 但那个 + 属于送给 Flash 的 ResultData，不在 IPC 路径上；落盘走
  // setCookie → saveOpt[k] = v + ""，恒为字符串，故 "0" 与空值可区分。
  const r = normalizeFishingSave({ yb: "0" });
  assert.deepEqual(r.patch, { info: { yb: 0 } });
  assert.equal(r.hasChange, true);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.skipped, []);

  // 数字 0 同样落盘
  assert.deepEqual(normalizeFishingSave({ yb: 0 }).patch, { info: { yb: 0 } });

  // cookie 缺失时 yb 的失败态是 "NaN"（算术结果），必须被拒而不是当成 0
  const bad = normalizeFishingSave({ yb: "NaN" });
  assert.deepEqual(bad.patch, {});
  assert.equal(bad.hasChange, false);
  assert.deepEqual(bad.rejected, ["yb:not-finite"]);

  // 空字符串同样拒绝，不得被 Number("") === 0 蒙进来
  assert.deepEqual(normalizeFishingSave({ yb: "" }).rejected, ["yb:empty"]);

  // 正常正数照写
  assert.deepEqual(normalizeFishingSave({ yb: 500 }).patch, { info: { yb: 500 } });
});

test("normalizeFishingSave 对缺失/非对象 data 不抛异常", () => {
  for (const bad of [undefined, null, "str", 42, []]) {
    const r = normalizeFishingSave(bad);
    assert.deepEqual(r.patch, {});
    assert.equal(r.hasChange, false);
    assert.equal(r.fishes, null);
  }
});

test("wantsPetInfo 只在显式要求时为真", () => {
  assert.equal(wantsPetInfo({ getPetInfo: true }), true);
  assert.equal(wantsPetInfo({ getPetInfo: 1 }), true);
  assert.equal(wantsPetInfo({}), false);
  assert.equal(wantsPetInfo(undefined), false);
  assert.equal(wantsPetInfo(null), false);
});

test("pickActiveOptionKey 无进行中活动时返回 null 而非空串", () => {
  assert.equal(pickActiveOptionKey({ work: { id: 1 }, study: null }), "work");
  assert.equal(pickActiveOptionKey({ work: null, study: { id: 2 } }), "study");
  assert.equal(pickActiveOptionKey({ work: null, study: null, trip: { id: 3 } }), "trip");
  // 这三种以前都会算出 key ""，随后 obj[""].stopNow 抛 TypeError
  assert.equal(pickActiveOptionKey({ work: null, study: null, trip: null }), null);
  assert.equal(pickActiveOptionKey({}), null);
  assert.equal(pickActiveOptionKey(undefined), null);
  assert.equal(pickActiveOptionKey(""), null);
});

test("resolveGiftIndex 计算分页下标并拦越界/非法 useType", () => {
  const list = [{ isTake: 0 }, { isTake: 0 }, { isTake: 0 }, { isTake: 0 }, { isTake: 0 }, { isTake: 0 }, { isTake: 0 }];
  assert.deepEqual(resolveGiftIndex({ useType: "sign", inIndex: 0, current: 1, pageSize: 6 }, list), {
    ok: true,
    index: 0,
  });
  assert.deepEqual(resolveGiftIndex({ useType: "online", inIndex: 0, current: 2, pageSize: 6 }, list), {
    ok: true,
    index: 6,
  });

  // 越界：以前直接 list[999].isTake = 2 抛 TypeError（而道具已发放）
  assert.deepEqual(resolveGiftIndex({ useType: "sign", inIndex: 999, current: 1, pageSize: 6 }, list), {
    ok: false,
    reason: "out-of-range",
  });
  assert.equal(resolveGiftIndex({ useType: "sign", inIndex: 1, current: 2, pageSize: 6 }, list).reason, "out-of-range");

  // useType 白名单
  assert.equal(resolveGiftIndex({ useType: "food", inIndex: 0, current: 1, pageSize: 6 }, list).reason, "bad-useType");
  assert.equal(resolveGiftIndex({ useType: "__proto__", inIndex: 0, current: 1, pageSize: 6 }, list).reason, "bad-useType");

  // 非法数值
  assert.equal(resolveGiftIndex({ useType: "sign", inIndex: -1, current: 1, pageSize: 6 }, list).reason, "bad-inIndex");
  assert.equal(resolveGiftIndex({ useType: "sign", inIndex: 1.5, current: 1, pageSize: 6 }, list).reason, "bad-inIndex");
  assert.equal(resolveGiftIndex({ useType: "sign", inIndex: 0, current: 0, pageSize: 6 }, list).reason, "bad-current");
  assert.equal(resolveGiftIndex({ useType: "sign", inIndex: 0, current: 1, pageSize: 0 }, list).reason, "bad-pageSize");
  assert.equal(resolveGiftIndex({ useType: "sign", inIndex: 0, current: 1, pageSize: 6 }, null).reason, "no-list");
  assert.equal(resolveGiftIndex(undefined, list).reason, "bad-useType");
  assert.equal(resolveGiftIndex({ useType: "sign", inIndex: 0, current: 1, pageSize: 6 }, [null]).reason, "empty-item");
});
