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

const { startDataWatcher, REBUILD_DELAYS_MS, FILE_NAME } = require("../src/ini/dataWatcher.js");

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
