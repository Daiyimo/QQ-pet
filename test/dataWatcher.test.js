// src/ini/dataWatcher.js 的可观测性与自愈测试（本模块此前零测试，却被 README 列为"放心改"）。
//
// 修复的缺陷（原实现四处静默吞异常）：
//   readFile 的 catch 返空串、JSON.parse 的 catch 直接 return、
//   fs.watch 创建失败 catch 后 return、watcher.on("error", () => {}) 空实现。
//   后两处会让"存档外部改动同步"永久死掉且没有任何日志。
//
// fs / electron app / 定时器全部注入，纯 node 可跑（本机无 node_modules）。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/* 被测源码路径可用 QQ_DATA_WATCHER_SRC 覆盖，专为"变异测试/回滚验证"准备：
   把修复回滚后的版本写进临时文件，再
   `QQ_DATA_WATCHER_SRC=<临时文件> node --test test/dataWatcher.test.js`，
   即可验证这些用例真的会红 —— 无需改动仓库里的 src/。
   与 test/storeCorrupt.test.js 的 QQ_INI_STORE_SRC 同一套约定。 */
const { startDataWatcher, REBUILD_DELAYS_MS, FILE_NAME, deepEqual } = require(
  process.env.QQ_DATA_WATCHER_SRC
    ? path.resolve(process.env.QQ_DATA_WATCHER_SRC)
    : "../src/ini/dataWatcher.js"
);

const USER_DATA = path.join("C:", "fake-userdata");
const CONFIG_PATH = path.join(USER_DATA, FILE_NAME);

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
 * fs 替身。
 * @param {object} opt
 * @param {Function} [opt.read] (filePath) => string，可抛错
 * @param {Error[]} [opt.watchErrors] 第 n 次调用 fs.watch 时抛出的错误（undefined 表示成功）
 */
function makeFs(opt = {}) {
  const state = { watchCalls: [], watchers: [], reads: [] };
  const fs = {
    watch(dir, options, cb) {
      state.watchCalls.push({ dir, options });
      const err = (opt.watchErrors || [])[state.watchCalls.length - 1];
      if (err) throw err;
      const watcher = {
        closed: false,
        handlers: {},
        on(event, handler) {
          this.handlers[event] = handler;
          return this;
        },
        close() {
          this.closed = true;
        },
        /** 测试侧触发一次文件变更 */
        emitChange(name = FILE_NAME) {
          cb("change", name);
        },
        /** 测试侧触发一次 watcher 运行期错误 */
        emitError(error) {
          this.handlers.error(error);
        },
      };
      state.watchers.push(watcher);
      return watcher;
    },
    readFileSync(filePath, encoding) {
      state.reads.push({ filePath, encoding });
      if (opt.read) return opt.read(filePath);
      return "";
    },
  };
  return { fs, state };
}

function makeApp() {
  const handlers = {};
  return {
    getPath: () => USER_DATA,
    on: (event, handler) => {
      handlers[event] = handler;
    },
    handlers,
  };
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
    /** 执行最近一个未清理的定时任务 */
    runLast() {
      const item = scheduled[scheduled.length - 1];
      assert.ok(item, "没有待执行的重建定时器");
      item.fn();
      return item;
    },
  };
}

function stubSetPetInfo(fn) {
  const original = global.setPetInfo;
  global.setPetInfo = fn;
  return () => {
    if (original === undefined) delete global.setPetInfo;
    else global.setPetInfo = original;
  };
}

test("正常路径：外部改档同步 info/maxInfo/activeOption，且回写内容不重复触发", () => {
  let disk = JSON.stringify({
    pet: {
      info: { yb: 1 },
      maxInfo: { mood: 1000 },
      activeOption: { ill: null },
      fishing: { power: 30 },
    },
  });
  const { fs, state } = makeFs({ read: () => disk });
  const timers = makeTimers();
  const calls = [];
  const restore = stubSetPetInfo((payload) => calls.push(payload));
  try {
    const handle = startDataWatcher({ fs, app: makeApp(), ...timers });
    assert.ok(handle, "正常路径必须返回句柄");
    assert.equal(handle.status().watching, true);

    // 启动时 lastRaw 已是磁盘内容 → 同内容变更事件不应触发同步
    state.watchers[0].emitChange();
    assert.equal(calls.length, 0, "内容未变时不应回源触发 setPetInfo");

    disk = JSON.stringify({ pet: { info: { yb: 2 }, maxInfo: { mood: 900 }, activeOption: {} } });
    state.watchers[0].emitChange();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { info: { yb: 2 }, maxInfo: { mood: 900 }, activeOption: {} });
    assert.equal("fishing" in calls[0], false, "fishing 不得进入 payload（会造成无限回写循环）");
    assert.equal("activeValue" in calls[0], false, "activeValue 不得进入 payload（同上）");

    // 同一份内容再来一次事件 → 去重
    state.watchers[0].emitChange();
    assert.equal(calls.length, 1, "同内容重复事件必须被 lastRaw 去重");

    // 非目标文件名的事件直接忽略
    const readsBefore = state.reads.length;
    state.watchers[0].emitChange("Cookies");
    assert.equal(state.reads.length, readsBefore, "其他文件的变更不应触发读盘");
  } finally {
    restore();
  }
});

test("JSON 损坏：必须留带堆栈的日志，且不把坏数据写进内存", () => {
  // 启动时磁盘是好的（否则 lastRaw 去重会让变更事件直接返回），随后被写坏
  let disk = JSON.stringify({ pet: { info: { yb: 1 } } });
  const { fs, state } = makeFs({ read: () => disk });
  const timers = makeTimers();
  const calls = [];
  const restore = stubSetPetInfo((p) => calls.push(p));
  const logs = captureConsole(() => {
    const handle = startDataWatcher({ fs, app: makeApp(), ...timers });
    disk = '{"pet":{"info":{"yb":2}}'; // 半截写入 / 真损坏
    state.watchers[0].emitChange();
    handle.stop();
  });
  restore();
  assert.equal(calls.length, 0, "解析失败不能把半截数据写进内存");
  const hit = logs.error.find((m) => m.includes("JSON 解析失败"));
  assert.ok(hit, "JSON 解析失败必须记日志（原实现是 catch(_){return}）");
  assert.ok(hit.includes("at "), "必须打完整堆栈");
});

test("读盘失败：ENOENT 不刷屏，其他错误必须记完整堆栈", () => {
  // ENOENT：首次启动存档还没写出，属正常态
  const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
  const a = makeFs({
    read: () => {
      throw enoent;
    },
  });
  const logsA = captureConsole(() => {
    startDataWatcher({ fs: a.fs, app: makeApp(), ...makeTimers() }).stop();
  });
  assert.deepEqual(logsA.error, [], "ENOENT 不应产生错误日志（每次 watch 事件都会读，会刷屏）");

  // EACCES：真正的异常，必须可见
  const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const b = makeFs({
    read: () => {
      throw eacces;
    },
  });
  const logsB = captureConsole(() => {
    startDataWatcher({ fs: b.fs, app: makeApp(), ...makeTimers() }).stop();
  });
  const hit = logsB.error.find((m) => m.includes("读取存档文件失败"));
  assert.ok(hit, "非 ENOENT 的读盘失败必须记日志");
  assert.ok(hit.includes(CONFIG_PATH), "日志要带出问题的文件路径");
  assert.ok(hit.includes("at "), "必须打完整堆栈");
});

test("fs.watch 创建失败：记完整堆栈 + 调度重建，不再静默 return", () => {
  const bad = Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
  const { fs, state } = makeFs({ watchErrors: [bad] });
  const timers = makeTimers();
  let handle;
  const logs = captureConsole(() => {
    handle = startDataWatcher({ fs, app: makeApp(), ...timers });
  });

  assert.ok(handle, "创建失败也应返回句柄（后续会重建），原实现直接 return undefined");
  assert.equal(handle.status().watching, false);
  assert.equal(handle.status().rebuildPending, true, "必须已调度重建");
  const hit = logs.error.find((m) => m.includes("创建存档监听失败"));
  assert.ok(hit, "创建失败必须记日志（原实现是 catch(_){return}）");
  assert.ok(hit.includes("EMFILE") && hit.includes("at "), "必须打完整堆栈");
  assert.ok(
    logs.error.some((m) => m.includes(`将在 ${REBUILD_DELAYS_MS[0]}ms 后第 1 次重建`)),
    "必须说明何时重建"
  );

  // 定时器到点后重建成功
  timers.runLast();
  assert.equal(state.watchCalls.length, 2, "应再次调用 fs.watch");
  assert.equal(handle.status().watching, true, "重建后必须重新处于监听状态");
  handle.stop();
});

test("watcher 运行期报错：记日志 + 关闭旧 watcher + 退避重建，且重建后同步真的恢复", () => {
  let disk = JSON.stringify({ pet: { info: { yb: 1 } } });
  const { fs, state } = makeFs({ read: () => disk });
  const timers = makeTimers();
  const calls = [];
  const restore = stubSetPetInfo((p) => calls.push(p));
  let handle;
  const logs = captureConsole(() => {
    handle = startDataWatcher({ fs, app: makeApp(), ...timers });
    state.watchers[0].emitError(new Error("watch handle died"));
  });

  assert.equal(state.watchers[0].closed, true, "出错的 watcher 必须被关闭，避免句柄泄漏");
  assert.equal(handle.status().watching, false);
  const hit = logs.error.find((m) => m.includes("存档监听运行期报错"));
  assert.ok(hit, 'watcher error 必须记日志（原实现是 on("error", () => {})）');
  assert.ok(hit.includes("watch handle died") && hit.includes("at "), "必须打完整堆栈");

  timers.runLast();
  assert.equal(state.watchCalls.length, 2);
  assert.equal(handle.status().watching, true, "报错后必须自动重建监听");

  // 自愈必须是真的：新 watcher 上的变更事件依然能同步进内存
  disk = JSON.stringify({ pet: { info: { yb: 99 } } });
  state.watchers[1].emitChange();
  restore();
  assert.deepEqual(calls, [{ info: { yb: 99 } }], "重建后的监听必须继续同步外部改动");
  handle.stop();
});

test("[回归] 旧 watcher 在重建后补发 error：不得关掉新 watcher、不得再排一次重建", () => {
  const { fs, state } = makeFs({ read: () => "" });
  const timers = makeTimers();
  let handle;
  captureConsole(() => {
    handle = startDataWatcher({ fs, app: makeApp(), ...timers });
    state.watchers[0].emitError(new Error("first failure"));
    timers.runLast(); // 重建 → state.watchers[1]
  });
  assert.equal(state.watchCalls.length, 2);
  assert.equal(handle.status().watching, true);
  const scheduledBefore = timers.scheduled.length;

  // 旧实例迟到的 error（FSWatcher 句柄失效时可能多次触发）
  const logs = captureConsole(() => {
    state.watchers[0].emitError(new Error("late duplicate failure"));
  });

  assert.equal(state.watchers[1].closed, false, "新 watcher 绝不能被旧实例的 error 关掉");
  assert.equal(handle.status().watching, true, "监听状态不应被旧实例影响");
  assert.equal(timers.scheduled.length, scheduledBefore, "不应再排一次多余的重建（会造成抖动）");
  assert.ok(
    logs.error.every((m) => !m.includes("存档监听运行期报错")),
    "旧实例的迟到错误不应再走一遍重建日志"
  );
  assert.ok(
    logs.warn.some((m) => m.includes("忽略已被替换的旧监听器")),
    "忽略也要留一行 warn，便于排查句柄反复失效"
  );

  // 新 watcher 自己报错时仍然正常自愈
  captureConsole(() => {
    state.watchers[1].emitError(new Error("new watcher failure"));
  });
  assert.equal(state.watchers[1].closed, true, "当前 watcher 自己报错时必须被关闭");
  assert.equal(timers.scheduled.length, scheduledBefore + 1, "当前 watcher 报错应排新的重建");
  handle.stop();
});

test("退避序列递增并在用尽后维持最后一档（避免 flapping 时每秒重建）", () => {
  const bad = Object.assign(new Error("EPERM"), { code: "EPERM" });
  // 连续 6 次创建失败
  const { fs } = makeFs({ watchErrors: [bad, bad, bad, bad, bad, bad] });
  const timers = makeTimers();
  let handle;
  captureConsole(() => {
    handle = startDataWatcher({ fs, app: makeApp(), ...timers });
    for (let i = 0; i < 5; i++) timers.runLast();
  });
  const delays = timers.scheduled.map((s) => s.delay);
  assert.deepEqual(
    delays.slice(0, REBUILD_DELAYS_MS.length),
    REBUILD_DELAYS_MS,
    `退避序列应为 ${REBUILD_DELAYS_MS}，实际 ${delays}`
  );
  for (const d of delays.slice(REBUILD_DELAYS_MS.length)) {
    assert.equal(d, REBUILD_DELAYS_MS[REBUILD_DELAYS_MS.length - 1], "用尽后维持最后一档");
  }
  handle.stop();
});

test("stop / before-quit：关闭 watcher 并清掉待执行的重建定时器", () => {
  const bad = Object.assign(new Error("EPERM"), { code: "EPERM" });
  const { fs, state } = makeFs({ watchErrors: [bad] });
  const timers = makeTimers();
  const app = makeApp();
  let handle;
  captureConsole(() => {
    handle = startDataWatcher({ fs, app, ...timers });
  });
  assert.equal(typeof app.handlers["before-quit"], "function", "必须注册 before-quit 清理");
  app.handlers["before-quit"]();
  assert.equal(timers.scheduled[0].cleared, true, "退出时必须清掉重建定时器");
  assert.equal(handle.status().rebuildPending, false);
  // 退出后不再重建
  const before = state.watchCalls.length;
  handle.reload();
  assert.equal(state.watchCalls.length, before);
});

test("拿不到 electron.app 且未注入时：记日志并返回 null，不静默", () => {
  const { fs } = makeFs();
  const logs = captureConsole(() => {
    const handle = startDataWatcher({ fs });
    assert.equal(handle, null);
  });
  assert.ok(
    logs.error.some((m) => m.includes("无法获取 electron.app") && m.includes("at ")),
    "拿不到 app 是致命降级，必须带堆栈记录"
  );
});

/* ------------------------------------------------------------------ *
 * 写放大回归（本文件头注释此前断言"info 基本都是原始类型"，是错的）
 *
 * pet.js 的默认 info 表里 travel_china:[] / achievements:{} 是数组和对象，
 * activeOption 的 work/study/trip/ill 非 null 时也是对象；而 setPetInfo 的变更判定是
 * `!=`（对对象即引用比较），JSON.parse 每次产生新引用 → 恒被判为"变更" → 每次心跳回声
 * 都再写一次全量存档。下面的桩把 pet.js 的判定逐字复刻，用精确写盘次数把这条链钉住。
 * ------------------------------------------------------------------ */

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * pet.js 的 setPetInfo / getPetInfo 桩。
 * 判定逻辑复刻 src/ini/pet.js：只遍历默认表已有的键，用 `!=` 比较（对象即引用比较），
 * 任一节有变更就调一次 $Store.setItem("pet", ...) —— 即 writes 里记一笔。
 */
function stubPetJs(memory) {
  const writes = [];
  const origSet = global.setPetInfo;
  const origGet = global.getPetInfo;
  global.getPetInfo = () => clone(memory);
  global.setPetInfo = (payload) => {
    let changed = false;
    for (const section of ["info", "maxInfo", "activeOption"]) {
      const incoming = payload[section];
      if (!incoming) continue;
      for (const key of Object.keys(memory[section])) {
        if (!(key in incoming)) continue;
        const value = incoming[key];
        // pet.js 的 info 分支会跳过 falsy（0 除外）；这里一并复刻，避免桩比真实实现更严
        if (section === "info" && !value && value !== 0) continue;
        // eslint-disable-next-line eqeqeq
        if (value != memory[section][key]) {
          changed = true;
          memory[section][key] = value;
        }
      }
    }
    if (changed) writes.push(clone(payload)); // = 一次 $Store.setItem("pet", ...) 全量写盘
  };
  return {
    writes,
    restore: () => {
      if (origSet === undefined) delete global.setPetInfo;
      else global.setPetInfo = origSet;
      if (origGet === undefined) delete global.getPetInfo;
      else global.getPetInfo = origGet;
    },
  };
}

/** 一份同时含原始类型、数组、对象的宠物内存表（贴近 pet.js 的默认 info 表形状） */
function makeMemoryPet() {
  return {
    info: { yb: 1, hunger: 3100, travel_china: ["beijing"], achievements: { first_meet: 1 } },
    maxInfo: { mood: 1000, level: 3 },
    activeOption: { work: null, study: null, ill: { health: 0, overTime: 10 } },
  };
}

test("[写放大回归] 心跳回声：引用类型键值未变时，必须零次回写（原来每次都多写一次全量存档）", () => {
  const memory = makeMemoryPet();
  let disk = JSON.stringify({ pet: clone(memory) });
  const { fs, state } = makeFs({ read: () => disk });
  const pet = stubPetJs(memory);
  let handle;
  try {
    handle = startDataWatcher({ fs, app: makeApp(), ...makeTimers() });

    // 模拟一次 60s 心跳：pet.js 改了 yb 并把整份 pet 写盘 → 触发一次 watch 回声事件
    memory.info.yb = 2;
    disk = JSON.stringify({ pet: clone(memory) });
    const readsBefore = state.reads.length;
    state.watchers[0].emitChange();

    assert.equal(
      pet.writes.length,
      0,
      "回声里 yb 已与内存一致、travel_china/achievements/ill 值也未变，一次都不该回写"
    );
    // 回声本身的读盘：reload 一次 + setPetInfo 后刷新 lastRaw 一次
    assert.equal(state.reads.length - readsBefore, 2, "回声只允许 2 次读盘（reload + 刷新 lastRaw）");
  } finally {
    pet.restore();
    if (handle) handle.stop();
  }
});

test("[写放大回归] 连续 3 次心跳回声累计写盘次数必须为 0（放大是每次都发生的）", () => {
  const memory = makeMemoryPet();
  let disk = JSON.stringify({ pet: clone(memory) });
  const { fs, state } = makeFs({ read: () => disk });
  const pet = stubPetJs(memory);
  let handle;
  try {
    handle = startDataWatcher({ fs, app: makeApp(), ...makeTimers() });
    for (const yb of [2, 3, 4]) {
      memory.info.yb = yb;
      disk = JSON.stringify({ pet: clone(memory) });
      state.watchers[0].emitChange();
    }
    assert.equal(pet.writes.length, 0, "3 次心跳原本会放大出 3 次额外全量写");
  } finally {
    pet.restore();
    if (handle) handle.stop();
  }
});

test("[反假绿] 外部真的改了 travel_china / achievements：必须同步进内存并回写一次", () => {
  const memory = makeMemoryPet();
  let disk = JSON.stringify({ pet: clone(memory) });
  const { fs, state } = makeFs({ read: () => disk });
  const pet = stubPetJs(memory);
  let handle;
  try {
    handle = startDataWatcher({ fs, app: makeApp(), ...makeTimers() });

    const external = clone(memory);
    external.info.travel_china = ["beijing", "shanghai"];
    external.info.achievements = { first_meet: 1, level_10: 1 };
    disk = JSON.stringify({ pet: external });
    state.watchers[0].emitChange();

    assert.equal(pet.writes.length, 1, "真的变了就必须同步（值比较不能退化成一律不传）");
    assert.deepEqual(pet.writes[0].info.travel_china, ["beijing", "shanghai"]);
    assert.deepEqual(pet.writes[0].info.achievements, { first_meet: 1, level_10: 1 });
    assert.deepEqual(memory.info.travel_china, ["beijing", "shanghai"], "内存必须被真的更新");
  } finally {
    pet.restore();
    if (handle) handle.stop();
  }
});

test("[反假绿] 值未变的引用类型键不进 payload，值变的才进（同一次同步里两者并存）", () => {
  const memory = makeMemoryPet();
  let disk = JSON.stringify({ pet: clone(memory) });
  const { fs, state } = makeFs({ read: () => disk });
  const pet = stubPetJs(memory);
  let handle;
  try {
    handle = startDataWatcher({ fs, app: makeApp(), ...makeTimers() });

    const external = clone(memory);
    external.info.achievements = { first_meet: 1, night_owl: 1 }; // 变了
    external.info.travel_china = ["beijing"]; // 值相同，只是新引用
    external.activeOption.ill = { health: 0, overTime: 10 }; // 值相同，只是新引用
    disk = JSON.stringify({ pet: external });
    state.watchers[0].emitChange();

    assert.equal(pet.writes.length, 1);
    const payload = pet.writes[0];
    assert.equal("achievements" in payload.info, true, "真变了的键必须传");
    assert.equal("travel_china" in payload.info, false, "值相同的数组不得进 payload");
    assert.equal("ill" in payload.activeOption, false, "值相同的 activeOption 对象不得进 payload");
    assert.equal(payload.info.yb, memory.info.yb, "原始类型键仍照常交给 setPetInfo 自己判断");
  } finally {
    pet.restore();
    if (handle) handle.stop();
  }
});

test("拿不到 getPetInfo（无法值比较）：引用类型键宁可不传，并留 warn 不静默", () => {
  const memory = makeMemoryPet();
  let disk = JSON.stringify({ pet: clone(memory) });
  const { fs, state } = makeFs({ read: () => disk });
  const calls = [];
  const restore = stubSetPetInfo((p) => calls.push(p));
  const origGet = global.getPetInfo;
  delete global.getPetInfo;
  let handle;
  let logs;
  try {
    logs = captureConsole(() => {
      handle = startDataWatcher({ fs, app: makeApp(), ...makeTimers() });
      // 必须造一次真实的内容变化，否则被 lastRaw 去重、根本走不到过滤逻辑
      const external = clone(memory);
      external.info.yb = 6;
      disk = JSON.stringify({ pet: external });
      state.watchers[0].emitChange();
    });
  } finally {
    restore();
    if (origGet !== undefined) global.getPetInfo = origGet;
    if (handle) handle.stop();
  }

  assert.equal(calls.length, 1, "原始类型键仍应正常同步");
  assert.equal(calls[0].info.yb, 6);
  assert.equal("travel_china" in calls[0].info, false, "拿不到内存现值时数组键不得传");
  assert.equal("achievements" in calls[0].info, false, "拿不到内存现值时对象键不得传");
  assert.equal("ill" in calls[0].activeOption, false, "activeOption 的对象值同理");
  assert.ok(
    logs.warn.some((m) => m.includes("拿不到内存宠物数据") && m.includes("travel_china")),
    "降级必须可见，且点名是哪些键没同步"
  );
  assert.deepEqual(logs.error, [], "这条降级路径不该产生 error");
});

test("文件内容变化时必须校准 $Store 的内存镜像（镜像前提是本进程唯一写者）", () => {
  const memory = makeMemoryPet();
  let disk = JSON.stringify({ pet: clone(memory) });
  const { fs, state } = makeFs({ read: () => disk });
  const pet = stubPetJs(memory);
  const reconciles = [];
  const origStore = global.$Store;
  global.$Store = {
    _cache: {
      reconcile: (data, isEqual, reason) => reconciles.push({ data, isEqual, reason }),
    },
  };
  let handle;
  try {
    handle = startDataWatcher({ fs, app: makeApp(), ...makeTimers() });
    assert.deepEqual(reconciles, [], "启动阶段不该动镜像");

    const external = clone(memory);
    external.info.yb = 777;
    disk = JSON.stringify({ pet: external });
    state.watchers[0].emitChange();

    assert.equal(reconciles.length, 1, "确认磁盘内容变化后必须校准镜像恰好一次");
    assert.equal(reconciles[0].data.pet.info.yb, 777, "必须把磁盘实际内容交给 reconcile");
    assert.equal(typeof reconciles[0].isEqual, "function", "必须把深比较函数传下去");

    // 同内容的重复事件被 lastRaw 去重，不该再校准（会白白多一次全文件读）
    state.watchers[0].emitChange();
    assert.equal(reconciles.length, 1, "被去重的事件不得触发镜像校准");
  } finally {
    if (origStore === undefined) delete global.$Store;
    else global.$Store = origStore;
    pet.restore();
    if (handle) handle.stop();
  }
});

test("旧版 storeCache（只有 invalidate）：退回整表失效，不因缺 reconcile 而静默跳过", () => {
  const memory = makeMemoryPet();
  let disk = JSON.stringify({ pet: clone(memory) });
  const { fs, state } = makeFs({ read: () => disk });
  const pet = stubPetJs(memory);
  const invalidations = [];
  const origStore = global.$Store;
  global.$Store = { _cache: { invalidate: (reason) => invalidations.push(reason) } };
  let handle;
  try {
    handle = startDataWatcher({ fs, app: makeApp(), ...makeTimers() });
    const external = clone(memory);
    external.info.yb = 888;
    disk = JSON.stringify({ pet: external });
    state.watchers[0].emitChange();
    assert.equal(invalidations.length, 1, "没有 reconcile 时必须退回 invalidate");
  } finally {
    if (origStore === undefined) delete global.$Store;
    else global.$Store = origStore;
    pet.restore();
    if (handle) handle.stop();
  }
});

test("$Store 镜像校准抛错时：记完整堆栈且不打断本轮同步", () => {
  const memory = makeMemoryPet();
  let disk = JSON.stringify({ pet: clone(memory) });
  const { fs, state } = makeFs({ read: () => disk });
  const pet = stubPetJs(memory);
  const origStore = global.$Store;
  global.$Store = {
    _cache: {
      reconcile: () => {
        throw new Error("flush boom");
      },
    },
  };
  let handle;
  let logs;
  try {
    logs = captureConsole(() => {
      handle = startDataWatcher({ fs, app: makeApp(), ...makeTimers() });
      const external = clone(memory);
      external.info.travel_china = ["beijing", "xizang"];
      disk = JSON.stringify({ pet: external });
      state.watchers[0].emitChange();
    });
  } finally {
    if (origStore === undefined) delete global.$Store;
    else global.$Store = origStore;
    pet.restore();
    if (handle) handle.stop();
  }
  const hit = logs.error.find((m) => m.includes("校准 $Store 内存镜像失败"));
  assert.ok(hit, "校准失败必须留日志");
  assert.ok(hit.includes("flush boom") && hit.includes("at "), "必须打完整堆栈");
  assert.equal(pet.writes.length, 1, "镜像失效失败不得吃掉本轮的外部改动同步");
});

test("deepEqual：键顺序无关，类型/长度/嵌套差异必须判为不等", () => {
  assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(deepEqual(["a", "b"], ["a", "b"]), true);
  assert.equal(deepEqual(["a", "b"], ["b", "a"]), false, "数组是有序的");
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false, "键数量不同即不等");
  assert.equal(deepEqual([], {}), false, "数组与对象不等");
  assert.equal(deepEqual(null, {}), false);
  assert.equal(deepEqual({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } }), true);
  assert.equal(deepEqual({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } }), false);
  assert.equal(deepEqual(0, "0"), false, "必须是严格值比较，不能退化成 ==");
});
