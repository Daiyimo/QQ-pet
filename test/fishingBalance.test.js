// 钓鱼渲染层回归测试：饲料余额校验、关窗前落盘、鱼苗展示价与实付价同源。
//
// indexOnLine.js 是渲染层普通脚本（无导出），这里用内置 vm 在一个带 window/document.cookie
// 桩的沙箱里加载它，不依赖任何三方包。定时器是可控假实现，用来证明「不等 500ms 防抖也能落盘」。
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const FILE = path.join(
  __dirname,
  "..",
  "src",
  "windows",
  "popups",
  "fishing",
  "indexOnLine.js"
);
const CODE = fs.readFileSync(FILE, "utf8");

// 每个用例一个全新沙箱
function makeSandbox() {
  const jar = new Map();
  const saved = []; // saveInfoData 收到的载荷
  const timers = []; // 未触发的定时器
  let saveShouldThrow = false;
  const logs = { error: [] };

  const documentStub = {
    getElementById: () => ({ PETEventOnReceived: () => {} }),
    get cookie() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(str) {
      const [pair] = String(str).split(";");
      const idx = pair.indexOf("=");
      jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    },
  };

  // window 故意与沙箱全局分离：真实渲染层里 `close_game` 是另一个脚本的
  // 脚本作用域绑定，不等于 window.close_game，分离能避免自递归。
  const windowStub = { addEventListener: () => {} };

  const ctx = {
    window: windowStub,
    document: documentStub,
    player: { PETEventOnReceived: () => {} },
    console: {
      log: () => {},
      error: (...a) => logs.error.push(a.join(" ")),
      warn: () => {},
    },
    JSON,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    isNaN,
    setTimeout: (fn, ms) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    close_game: () => {}, // 非递归桩
    getPetInfoFromMain: () => {},
    saveInfoData: (payload) => {
      if (saveShouldThrow) throw new Error("模拟 IPC 落盘失败");
      saved.push(payload);
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: FILE });

  return {
    ctx,
    jar,
    saved,
    timers,
    logs,
    windowStub,
    setSaveThrows: (v) => {
      saveShouldThrow = v;
    },
    // 直接种 cookie（绕过 setCookie 的 save 逻辑）
    seed: (k, v) => jar.set(encodeURIComponent(k), encodeURIComponent(String(v))),
    read: (k) => decodeURIComponent(jar.get(encodeURIComponent(k))),
    send: (cmd, data = {}) =>
      windowStub.PETSendData(JSON.stringify({ head: { cmd, game: 6 }, data })),
  };
}

const MATURE_FISH = (id) => ({
  id,
  fryid: 1,
  name: "鱼",
  stage: 1,
  time: 0,
  interval: 3600,
  costyb: 4,
  YB: 10,
  quantity: 1,
  born: Math.floor(Date.now() / 1000),
  siLiao: 0,
});

// ------------------------------------------------ 饲料余额校验

test("使用饲料元宝不足时不扣款也不改动鱼", () => {
  const s = makeSandbox();
  s.seed("yb", 4); // 不足一次饲料的 5 元宝
  s.seed("fishes", JSON.stringify([MATURE_FISH(1)]));
  const before = s.read("fishes");
  s.send(2, { id: 1 });
  assert.equal(s.read("yb"), "4", "余额不足不得扣款（旧实现会扣成 -1）");
  assert.equal(s.read("fishes"), before, "余额不足不该推进鱼的成长");
});

test("使用饲料元宝为 0 时不会扣成负数", () => {
  const s = makeSandbox();
  s.seed("yb", 0);
  s.seed("fishes", JSON.stringify([MATURE_FISH(1)]));
  s.send(2, { id: 1 });
  assert.equal(s.read("yb"), "0");
  assert.ok(Number(s.read("yb")) >= 0, "元宝不能为负");
});

test("使用饲料余额刚好够时正常扣 5 元宝并推进成长", () => {
  const s = makeSandbox();
  s.seed("yb", 5);
  s.seed("fishes", JSON.stringify([MATURE_FISH(1)]));
  s.send(2, { id: 1 });
  assert.equal(s.read("yb"), "0");
  assert.equal(JSON.parse(s.read("fishes"))[0].siLiao, 1, "应记一次饲料");
});

test("连续使用饲料到余额耗尽后停止扣款", () => {
  const s = makeSandbox();
  s.seed("yb", 12);
  s.seed("fishes", JSON.stringify([MATURE_FISH(1)]));
  for (let i = 0; i < 5; i++) s.send(2, { id: 1 });
  assert.ok(Number(s.read("yb")) >= 0, "任何时刻元宝都不能为负");
  assert.equal(s.read("yb"), "2", "12 元宝只够买 2 次饲料");
});

// ------------------------------------------------ 关窗前落盘

test("flushSaveOpt 不等 500ms 防抖即可把改动落盘", () => {
  const s = makeSandbox();
  s.seed("yb", 100);
  s.seed("fishes", JSON.stringify([MATURE_FISH(1)]));
  s.send(2, { id: 1 }); // 产生 fishes/yb 两处待存改动
  assert.equal(s.saved.length, 0, "前置：防抖定时器未触发时不该已落盘");
  assert.ok(s.timers.length > 0, "前置：应挂了防抖定时器");
  const ok = s.ctx.flushSaveOpt();
  assert.equal(ok, true);
  assert.equal(s.saved.length, 1, "关窗前必须能同步落盘");
  assert.ok("yb" in s.saved[0] && "fishes" in s.saved[0], "两处改动都要带上");
  assert.equal(s.saved[0].yb, "95");
});

test("flushSaveOpt 无待存改动时不产生空回写", () => {
  const s = makeSandbox();
  assert.equal(s.ctx.flushSaveOpt(), false);
  assert.equal(s.saved.length, 0);
});

test("flushSaveOpt 幂等：连续两次不重复回写", () => {
  const s = makeSandbox();
  s.seed("yb", 100);
  s.seed("fishes", JSON.stringify([MATURE_FISH(1)]));
  s.send(2, { id: 1 });
  s.ctx.flushSaveOpt();
  assert.equal(s.ctx.flushSaveOpt(), false, "第二次没有新改动");
  assert.equal(s.saved.length, 1);
});

test("flushSaveOpt 落盘失败时保留待存数据并留痕", () => {
  const s = makeSandbox();
  s.seed("yb", 100);
  s.seed("fishes", JSON.stringify([MATURE_FISH(1)]));
  s.send(2, { id: 1 });
  s.setSaveThrows(true);
  assert.equal(s.ctx.flushSaveOpt(), false);
  assert.ok(
    s.logs.error.some((l) => /落盘失败/.test(l)),
    "异常必须留痕，不能裸吞"
  );
  // 恢复后重试仍能落盘，数据没丢
  s.setSaveThrows(false);
  assert.equal(s.ctx.flushSaveOpt(), true);
  assert.equal(s.saved.length, 1);
  assert.equal(s.saved[0].yb, "95");
});

test("close_game 会在关闭前落盘", () => {
  const s = makeSandbox();
  s.seed("yb", 100);
  s.seed("fishes", JSON.stringify([MATURE_FISH(1)]));
  s.send(2, { id: 1 });
  assert.equal(s.saved.length, 0);
  s.windowStub.close_game();
  assert.equal(s.saved.length, 1, "关窗前不落盘会导致收获可重复刷（重开窗口用旧数据重种 cookie）");
});

// ------------------------------------------------ 鱼苗价格口径

test("fryFinalPrice 非粉钻返回原价", () => {
  const s = makeSandbox();
  s.seed("isvip", 0);
  assert.equal(s.ctx.fryFinalPrice({ price_yb: 40 }), 40);
});

test("fryFinalPrice 粉钻按 8 折并与商城同一取整口径", () => {
  const s = makeSandbox();
  s.seed("isvip", 1);
  assert.equal(s.ctx.fryFinalPrice({ price_yb: 40 }), 32);
  // Math.round(price*0.8)，与 pinkDiamondShop.applyPinkDiamondPrice 一致
  assert.equal(s.ctx.fryFinalPrice({ price_yb: 13 }), Math.round(13 * 0.8));
  assert.equal(s.ctx.fryFinalPrice({ price_yb: 18 }), Math.round(18 * 0.8));
});

test("fryFinalPrice 非法价格原样返回，不产生 NaN", () => {
  const s = makeSandbox();
  s.seed("isvip", 1);
  assert.equal(s.ctx.fryFinalPrice({}), 0);
  assert.equal(s.ctx.fryFinalPrice({ price_yb: 0 }), 0);
  assert.equal(s.ctx.fryFinalPrice(null), 0);
});

test("鱼苗商店展示价与实际扣费一致（非粉钻）", () => {
  const s = makeSandbox();
  s.seed("isvip", 0);
  s.seed("yb", 1000);
  s.seed("fishes", "[]");
  const fry = s.ctx.shop.find((x) => x && +x.price_yb > 0);
  const shown = s.ctx.fryFinalPrice(fry);
  s.send(4, { paytype: 1, fryid: fry.fryid });
  assert.equal(1000 - Number(s.read("yb")), shown, "旧实现展示价放大 1.25 倍，与实付价对不上账");
});

test("鱼苗商店展示价与实际扣费一致（粉钻 8 折）", () => {
  const s = makeSandbox();
  s.seed("isvip", 1);
  s.seed("yb", 1000);
  s.seed("fishes", "[]");
  const fry = s.ctx.shop.find((x) => x && +x.price_yb > 0);
  const shown = s.ctx.fryFinalPrice(fry);
  assert.equal(shown, Math.round(+fry.price_yb * 0.8), "前置：粉钻应享 8 折");
  s.send(4, { paytype: 1, fryid: fry.fryid });
  assert.equal(1000 - Number(s.read("yb")), shown);
});

test("粉钻用户余额只够 8 折价时可以买入", () => {
  const s = makeSandbox();
  s.seed("isvip", 1);
  s.seed("fishes", "[]");
  // 需要一条折后价真的低于原价的鱼苗（price_yb=2 时 round(1.6)=2，折不动）
  const fry = s.ctx.shop.find(
    (x) => x && +x.price_yb > 0 && Math.round(+x.price_yb * 0.8) < +x.price_yb
  );
  assert.ok(fry, "前置：应存在折后价低于原价的鱼苗");
  const price = s.ctx.fryFinalPrice(fry);
  assert.ok(price < +fry.price_yb, "前置：折后价应低于原价");
  s.seed("yb", price);
  s.send(4, { paytype: 1, fryid: fry.fryid });
  assert.equal(JSON.parse(s.read("fishes")).length, 1, "旧实现按原价校验会误判元宝不足");
  assert.equal(s.read("yb"), "0");
});

test("买鱼苗元宝不足时不扣款不入池", () => {
  const s = makeSandbox();
  s.seed("isvip", 0);
  s.seed("fishes", "[]");
  const fry = s.ctx.shop.find((x) => x && +x.price_yb > 0);
  s.seed("yb", 0);
  s.send(4, { paytype: 1, fryid: fry.fryid });
  assert.equal(s.read("yb"), "0");
  assert.equal(JSON.parse(s.read("fishes")).length, 0);
});

test("入池鱼记录的 costyb 为实付价（决定未成熟回收返还额）", () => {
  const s = makeSandbox();
  s.seed("isvip", 1);
  s.seed("yb", 1000);
  s.seed("fishes", "[]");
  const fry = s.ctx.shop.find((x) => x && +x.price_yb > 0);
  const price = s.ctx.fryFinalPrice(fry);
  s.send(4, { paytype: 1, fryid: fry.fryid });
  assert.equal(JSON.parse(s.read("fishes"))[0].costyb, price, "记原价会让回收返还高于实付的一半");
});
