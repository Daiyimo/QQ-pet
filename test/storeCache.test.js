// src/ini/storeCache.js 的行为测试：内存镜像 + 写防抖 + 退出前 flush + 体积告警。
//
// 修复的缺陷：$Store 直通 electron-store(conf)，而 conf 的 `get store` 每次都
// readFileSync + JSON.parse，`set` = 读 + 合并 + 原子写，全在主进程同步执行。
// 稳态每小时数百次全文件读 / 上百次全文件写 → 桌宠掉帧。
//
// 本文件直接测 StoreCache（注入假 owner / 假 fs / 假定时器 / 假 app），不需要 Electron，
// 也不需要 node_modules；store.js 侧的接入由 test/storeCorrupt.test.js 覆盖。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  StoreCache,
  createStoreCache,
  DEBOUNCE_MS,
  DEBOUNCED_KEYS,
  SAVE_SIZE_WARN_BYTES,
  /* 被测源码路径可用 QQ_STORE_CACHE_SRC 覆盖，专为"变异测试/回滚验证"准备：
     把修复回滚后的版本写进临时文件，再
     `QQ_STORE_CACHE_SRC=<临时文件> node --test test/storeCache.test.js`，
     即可验证这些用例真的会红 —— 无需改动仓库里的 src/。
     与 test/storeCorrupt.test.js 的 QQ_INI_STORE_SRC 同一套约定。 */
} = require(
  process.env.QQ_STORE_CACHE_SRC
    ? path.resolve(process.env.QQ_STORE_CACHE_SRC)
    : "../src/ini/storeCache.js"
);

/* 生产里 reconcile 的比较器是 dataWatcher 传进来的那一个，测试必须用同一份，
   否则就是在测一个现实中不存在的组合。 */
const { deepEqual: deepEqualForTest } = require("../src/ini/dataWatcher.js");

const CONFIG_PATH = path.join("C:", "fake-userdata", "config-qq-local.json");

function captureConsole(fn) {
  const logs = { error: [], warn: [] };
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args) => logs.error.push(args.map((a) => String(a)).join(" "));
  console.warn = (...args) => logs.warn.push(args.map((a) => String(a)).join(" "));
  try {
    fn(logs);
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
  return logs;
}

/**
 * 假 owner（模拟 src/ini/store.js 的 St 实例 + conf 的 get/set 语义）。
 * @param {object} [initial] 磁盘初始内容
 * @param {object} [opt]
 * @param {Function} [opt.onSet] 返回 Error 则本次 set 抛错（模拟落盘失败）
 */
function makeOwner(initial = {}, opt = {}) {
  const disk = { ...initial };
  const calls = { get: [], set: [] };
  const owner = {
    configFilePath: () => CONFIG_PATH,
    ElectronStore: {
      get(key) {
        calls.get.push(key);
        return disk[key];
      },
      // conf 的 set 支持 (key,value) 与 (object) 两种形态，后者一次读+一次写
      set(key, value) {
        const failure = opt.onSet && opt.onSet(key, value);
        if (failure) throw failure;
        if (typeof key === "object" && key !== null) {
          calls.set.push({ batch: { ...key } });
          Object.assign(disk, key);
          return;
        }
        calls.set.push({ key, value });
        disk[key] = value;
      },
      delete(key) {
        delete disk[key];
      },
      clear() {
        for (const k of Object.keys(disk)) delete disk[k];
      },
    },
  };
  return { owner, disk, calls };
}

/** 定时器替身：不真等，手动 run */
function makeTimers() {
  const scheduled = [];
  return {
    setTimeout: (fn, delay) => {
      const item = { fn, delay, cleared: false };
      scheduled.push(item);
      return item;
    },
    clearTimeout: (item) => {
      if (item) item.cleared = true;
    },
    scheduled,
    runLast() {
      const item = scheduled[scheduled.length - 1];
      assert.ok(item, "没有待执行的落盘定时器");
      item.fn();
      return item;
    },
  };
}

function makeCache(ownerBundle, deps = {}) {
  const timers = makeTimers();
  const cache = new StoreCache(ownerBundle.owner, { app: null, ...timers, ...deps });
  return { cache, timers };
}

/* ------------------------------------------------------------------ *
 * 内存镜像：把 getItem 的全文件读降到每个键一次
 * ------------------------------------------------------------------ */

test("内存镜像：同一个键连读 5 次，只穿到底层读 1 次", () => {
  const bundle = makeOwner({ pet: { info: { yb: 7 } } });
  const { cache } = makeCache(bundle);
  const readThrough = () => bundle.owner.ElectronStore.get("pet");

  const results = [];
  for (let i = 0; i < 5; i++) results.push(cache.get("pet", readThrough));

  assert.equal(bundle.calls.get.length, 1, "5 次 getItem 只允许 1 次全文件读");
  assert.deepEqual(bundle.calls.get, ["pet"]);
  for (const r of results) assert.deepEqual(r, { info: { yb: 7 } }, "每次都必须拿到正确值");
});

test("内存镜像：undefined 也要缓存（toSex 这类常为空的键不该每次都读盘）", () => {
  const bundle = makeOwner({});
  const { cache } = makeCache(bundle);
  const readThrough = () => bundle.owner.ElectronStore.get("toSex");

  assert.equal(cache.get("toSex", readThrough), undefined);
  assert.equal(cache.get("toSex", readThrough), undefined);
  assert.equal(bundle.calls.get.length, 1, "值为 undefined 时仍必须命中镜像");
});

test("内存镜像：setItem 之后 getItem 零次读盘，且读到的是刚写的值", () => {
  const bundle = makeOwner({ pet: { info: { yb: 1 } } });
  const { cache } = makeCache(bundle);

  cache.set("pet", { info: { yb: 2 } });
  const value = cache.get("pet", () => bundle.owner.ElectronStore.get("pet"));

  assert.deepEqual(value, { info: { yb: 2 } });
  assert.equal(bundle.calls.get.length, 0, "写过的键再读必须零次读盘");
});

test("内存镜像：读穿之前先把待落盘写入落盘（conf 点号路径下前缀键会读到旧值）", () => {
  const bundle = makeOwner({ tool: { floatStyle: { op: 0.3 } } });
  const { cache } = makeCache(bundle);

  cache.set("pet", { info: { yb: 9 } }); // pet 走防抖，此刻还没落盘
  assert.equal(bundle.calls.set.length, 0, "防抖窗口内不该落盘");

  cache.get("tool", () => bundle.owner.ElectronStore.get("tool"));

  assert.equal(bundle.calls.set.length, 1, "读穿前必须先 flush，保证磁盘不比内存旧");
  assert.deepEqual(bundle.calls.set[0], { key: "pet", value: { info: { yb: 9 } } });
});

/* ------------------------------------------------------------------ *
 * 写防抖
 * ------------------------------------------------------------------ */

test("写防抖：窗口内 4 次 setItem(pet) 只落盘 1 次，落的是最后一次的值", () => {
  const bundle = makeOwner();
  const { cache, timers } = makeCache(bundle);

  for (const yb of [1, 2, 3, 4]) cache.set("pet", { info: { yb } });
  assert.equal(bundle.calls.set.length, 0, "窗口未到不许落盘");
  assert.equal(cache.status().coalesced, 3, "4 次写应合并掉 3 次");

  timers.runLast();

  assert.equal(bundle.calls.set.length, 1, "整个窗口只允许 1 次落盘");
  assert.deepEqual(bundle.calls.set[0], { key: "pet", value: { info: { yb: 4 } } });
  assert.deepEqual(bundle.disk.pet, { info: { yb: 4 } }, "磁盘上必须是最后一次的值");
});

test("写防抖用固定窗口：后续写入不得重排定时器（否则高频写会无限推迟落盘）", () => {
  const bundle = makeOwner();
  const { cache, timers } = makeCache(bundle);

  cache.set("pet", { a: 1 });
  cache.set("pet", { a: 2 });
  cache.set("pet", { a: 3 });

  assert.equal(timers.scheduled.length, 1, "只允许存在一个落盘定时器（首写开窗，不重排）");
  assert.equal(timers.scheduled[0].delay, DEBOUNCE_MS, `窗口必须是 ${DEBOUNCE_MS}ms`);
  assert.equal(timers.scheduled[0].cleared, false);
});

test("只有 pet 走防抖：其余键写穿，并顺带把 pending 的 pet 一起批量落盘", () => {
  assert.deepEqual([...DEBOUNCED_KEYS], ["pet"], "防抖白名单只该有高频键 pet");
  const bundle = makeOwner();
  const { cache, timers } = makeCache(bundle);

  cache.set("pet", { info: { yb: 5 } });
  assert.equal(bundle.calls.set.length, 0);

  cache.set("toSex", "MM"); // 性别重置后紧跟 app.exit(0)，绝不能延迟落盘

  assert.equal(bundle.calls.set.length, 1, "写穿键必须立即落盘，且与 pending 合并成一次写");
  assert.deepEqual(bundle.calls.set[0], { batch: { pet: { info: { yb: 5 } }, toSex: "MM" } });
  assert.equal(timers.scheduled[0].cleared, true, "落盘后必须清掉防抖定时器");
  assert.equal(cache.status().pending, 0);
});

test("落盘失败：待落盘写入必须保留并在下次 flush 重试成功，绝不静默丢数据", () => {
  let fail = true;
  const bundle = makeOwner({}, { onSet: () => (fail ? new Error("EBUSY: locked") : null) });
  const { cache } = makeCache(bundle);

  const logs = captureConsole(() => {
    cache.set("pet", { info: { yb: 42 } });
    assert.equal(cache.flush("test"), false, "落盘失败必须返回 false");
  });

  assert.equal(cache.status().pending, 1, "失败的写入必须留在内存等重试");
  const hit = logs.error.find((m) => m.includes("存档落盘失败"));
  assert.ok(hit, "落盘失败必须留日志（禁止静默吞）");
  assert.ok(hit.includes("EBUSY") && hit.includes("at "), "必须打完整堆栈");

  fail = false;
  captureConsole(() => assert.equal(cache.flush("retry"), true));
  assert.deepEqual(bundle.disk.pet, { info: { yb: 42 } }, "重试必须把数据真的写下去");
  assert.equal(cache.status().pending, 0);
});

test("flush 在无待落盘写入时是空操作（不能凭空多写一次全文件）", () => {
  const bundle = makeOwner();
  const { cache } = makeCache(bundle);
  assert.equal(cache.flush("noop"), false);
  assert.equal(bundle.calls.set.length, 0);
});

/* ------------------------------------------------------------------ *
 * 退出前 flush —— 硬要求：丢存档比慢严重得多
 * ------------------------------------------------------------------ */

function makeApp() {
  const handlers = {};
  const exits = [];
  return {
    handlers,
    exits,
    getPath: () => path.dirname(CONFIG_PATH),
    on: (event, handler) => {
      (handlers[event] = handlers[event] || []).push(handler);
    },
    exit: (code) => exits.push(code),
    emit: (event) => (handlers[event] || []).forEach((h) => h()),
  };
}

test("before-quit：把防抖窗口内未落盘的进度写下去", () => {
  const bundle = makeOwner();
  const app = makeApp();
  const { cache } = makeCache(bundle, { app: null });
  cache.hookQuit(app);

  cache.set("pet", { info: { yb: 100 } });
  assert.equal(bundle.calls.set.length, 0, "退出前本来还没落盘");

  app.emit("before-quit");

  assert.equal(bundle.calls.set.length, 1, "before-quit 必须落盘恰好一次");
  assert.deepEqual(bundle.disk.pet, { info: { yb: 100 } });
});

test("before-quit：main/main.js 在本模块之后写的 lastX/lastY 也必须被补落盘", async () => {
  const bundle = makeOwner();
  const app = makeApp();
  const { cache } = makeCache(bundle, { app: null });
  cache.hookQuit(app); // 本模块的监听器先注册（真实顺序：store.js 由 init.js 最早加载）
  // main/main.js 的 before-quit 监听器注册得更晚，写入发生在本模块 flush 之后
  app.on("before-quit", () => cache.set("pet", { info: { lastX: 70, lastY: 400 } }));

  app.emit("before-quit");
  assert.deepEqual(bundle.disk.pet, undefined, "同步阶段本模块先 flush（此时 pending 为空）");
  assert.equal(cache.status().pending, 1, "坐标写入此刻还在 pending 里");

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    bundle.disk.pet,
    { info: { lastX: 70, lastY: 400 } },
    "派发结束后的补充 flush 必须把退出坐标写下去，否则每次退出都丢坐标"
  );
});

test("app.exit 被包装：先落盘再真的退出（app.exit 不触发任何 quit 事件）", () => {
  const bundle = makeOwner();
  const app = makeApp();
  const order = [];
  const rawExit = app.exit;
  app.exit = (code) => {
    order.push("exit");
    return rawExit(code);
  };
  const { cache } = makeCache(bundle, { app: null });
  const bundleSet = bundle.owner.ElectronStore.set.bind(bundle.owner.ElectronStore);
  bundle.owner.ElectronStore.set = (k, v) => {
    order.push("flush");
    return bundleSet(k, v);
  };
  cache.hookQuit(app);

  cache.set("pet", { info: { yb: 3 } });
  app.exit(0);

  assert.deepEqual(order, ["flush", "exit"], "必须先落盘后退出");
  assert.deepEqual(app.exits, [0], "退出码必须原样传递");
  assert.deepEqual(bundle.disk.pet, { info: { yb: 3 } });
});

test("app.exit 包装是幂等的：重复 hookQuit 不叠加（否则会重复 flush）", () => {
  const bundle = makeOwner();
  const app = makeApp();
  const { cache } = makeCache(bundle, { app: null });
  cache.hookQuit(app);
  const wrappedOnce = app.exit;
  cache.hookQuit(app);
  assert.equal(app.exit, wrappedOnce, "第二次 hookQuit 不得再包一层");
});

test("will-quit / quit 也各自 flush（app.quit 路径与 before-quit 被 preventDefault 的路径）", () => {
  for (const event of ["will-quit", "quit"]) {
    const bundle = makeOwner();
    const app = makeApp();
    const { cache } = makeCache(bundle, { app: null });
    cache.hookQuit(app);
    cache.set("pet", { info: { yb: 1 } });
    app.emit(event);
    assert.equal(bundle.calls.set.length, 1, `${event} 必须落盘`);
  }
});

test("app 没有 on / exit（非 Electron 运行时）：hookQuit 不抛错", () => {
  const bundle = makeOwner();
  const { cache } = makeCache(bundle, { app: null });
  assert.doesNotThrow(() => cache.hookQuit({ getPath: () => "x" }));
});

/* ------------------------------------------------------------------ *
 * 镜像失效
 * ------------------------------------------------------------------ */

test("reconcile：与磁盘一致的键保留镜像，不一致的键才丢弃（回声不该清空整表）", () => {
  const bundle = makeOwner({ pet: { info: { yb: 1 } }, sys: { bgm: true } });
  const { cache } = makeCache(bundle);
  const readPet = () => bundle.owner.ElectronStore.get("pet");
  const readSys = () => bundle.owner.ElectronStore.get("sys");
  cache.get("pet", readPet);
  cache.get("sys", readSys);
  assert.equal(bundle.calls.get.length, 2);

  // 外部只改了 pet：sys 的镜像必须留着（这正是心跳回声的形状——绝大多数键没变）
  const dropped = cache.reconcile({ pet: { info: { yb: 99 } }, sys: { bgm: true } }, deepEqualForTest);

  assert.deepEqual(dropped, ["pet"], "只有真的不一致的键才该被丢弃");
  bundle.disk.pet = { info: { yb: 99 } };
  assert.deepEqual(cache.get("pet", readPet), { info: { yb: 99 } });
  assert.equal(bundle.calls.get.length, 3, "pet 重读一次");
  cache.get("sys", readSys);
  assert.equal(bundle.calls.get.length, 3, "sys 未变，绝不该再读盘");
});

test("reconcile：本进程自己的落盘回声不得丢弃任何镜像（否则镜像收益等于白干）", () => {
  const bundle = makeOwner();
  const { cache } = makeCache(bundle);
  cache.set("pet", { info: { yb: 5 } });
  cache.set("sys", { bgm: false }); // 写穿，顺带把 pet 一起落盘
  assert.equal(cache.status().pending, 0);

  // 回声：磁盘内容就是我们刚写下去的那份
  const dropped = cache.reconcile({ pet: { info: { yb: 5 } }, sys: { bgm: false } }, deepEqualForTest);

  assert.deepEqual(dropped, [], "自己写的内容必须被识别为一致");
  assert.equal(cache.status().mirrored, 2, "镜像必须完整保留");
});

test("reconcile：先把待落盘写入落盘再比较（外部改档时不能丢本进程的新数据）", () => {
  const bundle = makeOwner();
  const { cache } = makeCache(bundle);
  cache.set("pet", { info: { yb: 7 } });
  assert.equal(bundle.calls.set.length, 0);

  cache.reconcile({ pet: { info: { yb: 1 } } }, deepEqualForTest);

  assert.equal(bundle.calls.set.length, 1, "校准前必须先落盘，否则本进程的新数据会被外部值顶掉");
  assert.deepEqual(bundle.disk.pet, { info: { yb: 7 } });
});

test("reconcile：认得 conf 的点号路径键（tool.floatStyle）", () => {
  const bundle = makeOwner({ tool: { floatStyle: { op: 0.3 } } });
  const { cache } = makeCache(bundle);
  cache.get("tool.floatStyle", () => ({ op: 0.3 }));

  assert.deepEqual(
    cache.reconcile({ tool: { floatStyle: { op: 0.3 } } }, deepEqualForTest),
    [],
    "点号路径必须逐层下探比较，不能当成字面 key 而误判成不一致"
  );
  assert.deepEqual(
    cache.reconcile({ tool: { floatStyle: { op: 0.9 } } }, deepEqualForTest),
    ["tool.floatStyle"],
    "点号路径下的真实变化必须被发现"
  );
});

test("reconcile：拿不到可比较的磁盘内容时退回整表清空（保守侧）", () => {
  const bundle = makeOwner({ pet: { info: { yb: 1 } } });
  const { cache } = makeCache(bundle);
  cache.get("pet", () => bundle.owner.ElectronStore.get("pet"));
  assert.deepEqual(cache.reconcile(null, deepEqualForTest), ["pet"]);
  assert.equal(cache.status().mirrored, 0, "无法比较时必须宁可全部重读");
});

test("invalidate（兜底钝刀）：先落盘再整表清空", () => {
  const bundle = makeOwner({ pet: { info: { yb: 1 } } });
  const { cache } = makeCache(bundle);
  cache.get("pet", () => bundle.owner.ElectronStore.get("pet"));
  cache.set("pet", { info: { yb: 2 } });

  cache.invalidate("external");

  assert.equal(bundle.calls.set.length, 1, "失效前必须先把本进程的 pending 落盘，不能丢");
  assert.deepEqual(bundle.disk.pet, { info: { yb: 2 } });
  assert.equal(cache.status().mirrored, 0);
});

test("clear()：镜像与待落盘写入一起丢弃（存档被整体抹掉，保留 pending 是错的）", () => {
  const bundle = makeOwner({ pet: { info: { yb: 1 } } });
  const { cache, timers } = makeCache(bundle);
  cache.set("pet", { info: { yb: 2 } });

  cache.reset();

  assert.equal(cache.status().pending, 0, "clear 后不许把旧数据再写回去");
  assert.equal(cache.status().mirrored, 0);
  assert.equal(timers.scheduled[0].cleared, true, "clear 必须清掉防抖定时器");
  assert.equal(bundle.calls.set.length, 0, "clear 路径不该触发落盘");
});

test("drop()（removeItem）：只清该键，其他键的镜像与 pending 不受影响", () => {
  const bundle = makeOwner();
  const { cache } = makeCache(bundle);
  cache.set("pet", { info: { yb: 1 } });
  cache.set("toSex", "GG"); // 写穿：会把 pet 一起落盘
  cache.set("pet", { info: { yb: 2 } });

  cache.drop("toSex");

  assert.equal(cache.status().mirrored, 1, "只该剩 pet 的镜像");
  assert.deepEqual(
    cache.get("pet", () => {
      throw new Error("不该读盘");
    }),
    { info: { yb: 2 } },
    "drop 别的键不能影响 pet 的镜像"
  );
});

/* ------------------------------------------------------------------ *
 * 启动体积告警
 * ------------------------------------------------------------------ */

test("启动体积检查：超过阈值必须 warn 出体积、阈值、路径与常见成因", () => {
  const bundle = makeOwner();
  const size = SAVE_SIZE_WARN_BYTES + 1;
  const { cache } = makeCache(bundle, { fs: { statSync: () => ({ size }) } });

  const logs = captureConsole(() => assert.equal(cache.warnIfSaveTooLarge(), size));

  assert.equal(logs.warn.length, 1, "超阈值必须恰好告警一次");
  assert.equal(logs.error.length, 0, "体积偏大是可预期业务状况，不该记 error");
  assert.ok(logs.warn[0].includes("存档体积"), logs.warn[0]);
  assert.ok(logs.warn[0].includes(CONFIG_PATH), "要给出存档路径");
  assert.ok(logs.warn[0].includes("2.00MB"), "要写出阈值，便于判断超了多少");
  assert.ok(logs.warn[0].includes("fishing.fishes"), "要指出无上界的成因，否则用户无从下手");
});

test("启动体积检查：正常体积零日志；首次启动 ENOENT 不刷屏；其他读失败记堆栈", () => {
  const bundle = makeOwner();

  const ok = makeCache(bundle, { fs: { statSync: () => ({ size: 40 * 1024 }) } });
  const logsOk = captureConsole(() => ok.cache.warnIfSaveTooLarge());
  assert.deepEqual(logsOk.warn, [], "正常体积不许有任何告警");
  assert.deepEqual(logsOk.error, []);

  const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
  const missing = makeCache(bundle, {
    fs: {
      statSync: () => {
        throw enoent;
      },
    },
  });
  const logsMissing = captureConsole(() => assert.equal(missing.cache.warnIfSaveTooLarge(), null));
  assert.deepEqual(logsMissing.error, [], "首次启动存档还没写出，ENOENT 是正常态");
  assert.deepEqual(logsMissing.warn, []);

  const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const denied = makeCache(bundle, {
    fs: {
      statSync: () => {
        throw eacces;
      },
    },
  });
  const logsDenied = captureConsole(() => assert.equal(denied.cache.warnIfSaveTooLarge(), null));
  const hit = logsDenied.error.find((m) => m.includes("读取存档体积失败"));
  assert.ok(hit, "非 ENOENT 的读失败必须可见");
  assert.ok(hit.includes(CONFIG_PATH) && hit.includes("at "), "必须带路径与完整堆栈");
});

test("createStoreCache：启动即做一次体积检查，并把 flush 钩子挂到 app 上", () => {
  const bundle = makeOwner();
  const app = makeApp();
  const cache = createStoreCache(bundle.owner, {
    app,
    fs: { statSync: () => ({ size: 1024 }) },
    ...makeTimers(),
  });
  assert.equal(typeof cache.flush, "function");
  assert.equal(app.handlers["before-quit"].length, 1, "必须注册 before-quit flush");
  assert.equal(app.handlers["will-quit"].length, 1);
  assert.equal(app.handlers["quit"].length, 1);
  assert.notEqual(app.exit, undefined);
});
