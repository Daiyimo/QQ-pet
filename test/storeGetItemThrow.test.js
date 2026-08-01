// src/ini/store.js（压缩产物）getItem 异常上抛回归测试 + src/ini/doMain.js 启动读失败保护测试。
//
// 修复的缺陷 A：原实现 `getItem(e){let t={};try{t=...get(e)}catch(o){...}return t}` ——
// 读键抛错时静默返回初始值 {}。doMain.js 用 `n?.info` 判新宠物，瞬时读错误会把老存档
// 当新宠物并覆盖落盘，不可逆。现改为记日志后向上抛，启动路径由 doMain.js 捕获后走
// handleStartupReadError（备份存档 + 弹窗 + 退出），与 createStore 的损坏隔离同一套语义。
//
// 修复的缺陷 B：doMain.js 只包住了 pet/sys/cache 三个键，新宠物分支的
// `$Store.getItem("toSex")` 是漏网的裸调用。它在 root.createMain 的回调里同步 throw，
// main.js 只有 unhandledRejection 处理器管不到；uncaughtException 处理器又刻意不退进程
// → 无窗口却占着 requestSingleInstanceLock 的僵尸进程。
//
// 修复的缺陷 C：handleStartupReadError 原先调用会破坏原文件的 isolateBrokenConfig
// （rename 失败时 writeFileSync(原路径,"{}")），而弹窗文案却承诺"以免用空存档覆盖你的数据"。
// 现改为 isolateBrokenConfig({backupOnly:true})：只复制副本，不改名不覆盖。
//
// 注入模式同 storeCorrupt.test.js：Module.prototype.require 拦截 electron-store / electron / fs。
// doMain.js 是 webpack 压缩 IIFE 且靠 `eval("require")` 取 require，因此用 node:vm 建沙箱、
// 把 require 与所有启动期全局（$Store / setSys / tool / ...）注入沙箱，真实执行 createMain 回调，
// 不做源码文本断言。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

/* 被测源码路径。可用 QQ_INI_STORE_SRC / QQ_DOMAIN_SRC 覆盖，专为"变异测试/回滚验证"准备：
   把修复回滚后的版本写进临时文件，再
   `QQ_INI_STORE_SRC=<临时文件> node --test test/storeGetItemThrow.test.js`，
   即可验证这些用例真的会红——无需改动仓库里的 src/。
   与 test/storeBagCache.test.js 的 QQ_STORE_SRC 同一套约定。 */
const STORE_PATH = process.env.QQ_INI_STORE_SRC
  ? path.resolve(process.env.QQ_INI_STORE_SRC)
  : require.resolve("../src/ini/store.js");
const DOMAIN_PATH = process.env.QQ_DOMAIN_SRC
  ? path.resolve(process.env.QQ_DOMAIN_SRC)
  : path.join(__dirname, "../src/ini/doMain.js");

const CONFIG_NAME = "config-qq-local.json";

function withTempUserData(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqstore-getitem-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

function corruptFiles(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith("config-qq-local.corrupt-"));
}

/** 构造成功、但 get 永远抛错的 electron-store 替身（模拟瞬时读错误） */
function makeThrowingGetStore() {
  return class FakeStore {
    constructor(option) {
      this.option = option;
      this.data = {};
    }
    get() {
      throw new Error("read boom");
    }
    set(key, value) {
      this.data[key] = value;
    }
    delete(key) {
      delete this.data[key];
    }
    clear() {
      this.data = {};
    }
  };
}

/**
 * 加载 store.js，返回 { $Store, dialogs, exitCodes, restore }。
 * app.exit 被桩为只记录，不会真的退出进程。
 * 注意：拦截器需一直挂到被测调用结束（handleStartupReadError 内部会再 _require("electron")、
 * isolateBrokenConfig 会再 _require("fs")），用完必须调 restore() 还原 Module.prototype.require。
 * @param {object} [opts.fs] 覆盖真实 fs 的部分方法（模拟 renameSync EPERM / 统计调用次数）
 */
function loadStore(userData, FakeStore, opts = {}) {
  delete require.cache[STORE_PATH];
  delete global.$Store;
  const orig = Module.prototype.require;
  const fsProxy = opts.fs ? { ...fs, ...opts.fs } : null;
  const dialogs = [];
  const exitCodes = [];
  const fakeElectron = {
    app: {
      getPath: () => userData,
      exit: (code) => exitCodes.push(code),
    },
    dialog: {
      showErrorBox: (title, content) => dialogs.push(String(content)),
    },
  };
  Module.prototype.require = function (id) {
    if (id === "electron-store") return FakeStore;
    if (id === "electron") return fakeElectron;
    if (id === "fs" && fsProxy) return fsProxy;
    return orig.apply(this, arguments);
  };
  try {
    require(STORE_PATH);
  } catch (e) {
    Module.prototype.require = orig;
    throw e;
  }
  return {
    $Store: global.$Store,
    dialogs,
    exitCodes,
    restore: () => {
      Module.prototype.require = orig;
      delete require.cache[STORE_PATH];
    },
  };
}

test("getItem: 读键异常记日志后向上抛，不再静默返回 {}", () => {
  withTempUserData((userData) => {
    const { $Store, restore } = loadStore(userData, makeThrowingGetStore());
    try {
      const logs = captureConsole(() => {
        assert.throws(() => $Store.getItem("pet"), /read boom/);
      });
      assert.equal(
        logs.error.some((l) => l.includes("[ini/store]") && l.includes("key=pet")),
        true,
        "抛错前必须留 [ini/store] 日志"
      );
    } finally {
      restore();
    }
  });
});

test("handleStartupReadError: 只复制备份 + 弹窗告知 + app.exit(1)，原存档一字不动", () => {
  withTempUserData((userData) => {
    // 放一份真实存档，验证启动路径只复制副本、绝不改名/覆盖原文件
    const configFile = path.join(userData, CONFIG_NAME);
    const original = JSON.stringify({ pet: { info: { name: "老存档" } } });
    fs.writeFileSync(configFile, original);

    const { $Store, dialogs, exitCodes, restore } = loadStore(userData, makeThrowingGetStore());
    try {
      captureConsole(() => {
        $Store.handleStartupReadError(new Error("read boom"));
      });
    } finally {
      restore();
    }

    // 原文件必须还在、内容必须一字未改（读失败可能只是杀软瞬时占用，存档其实完好）
    assert.equal(fs.existsSync(configFile), true, "启动读失败不得改名/删除原存档");
    assert.equal(fs.readFileSync(configFile, "utf8"), original, "原存档内容必须一字未改");

    // 同时留下一份可供人工排查的副本，内容与原文件相同
    const backups = corruptFiles(userData);
    assert.equal(backups.length, 1, `应有且只有 1 个备份副本，实际 ${JSON.stringify(backups)}`);
    assert.equal(fs.readFileSync(path.join(userData, backups[0]), "utf8"), original);

    // 弹窗告知 + 退出，绝不以空存档继续启动
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].includes("读取失败"), true);
    assert.equal(
      dialogs[0].includes("未被改名、未被覆盖"),
      true,
      "文案必须与实际行为一致：原文件没被动过"
    );
    assert.equal(dialogs[0].includes(backups[0]), true, "文案要给出备份副本路径");
    assert.deepEqual(exitCodes, [1]);
  });
});

test("handleStartupReadError: 一次 copyFileSync，零次 renameSync/writeFileSync", () => {
  withTempUserData((userData) => {
    const configFile = path.join(userData, CONFIG_NAME);
    fs.writeFileSync(configFile, JSON.stringify({ pet: { info: { name: "老存档" } } }));

    const calls = { rename: 0, write: 0, copy: 0 };
    const { $Store, restore } = loadStore(userData, makeThrowingGetStore(), {
      fs: {
        renameSync: (...a) => {
          calls.rename += 1;
          return fs.renameSync(...a);
        },
        writeFileSync: (...a) => {
          calls.write += 1;
          return fs.writeFileSync(...a);
        },
        copyFileSync: (...a) => {
          calls.copy += 1;
          return fs.copyFileSync(...a);
        },
      },
    });
    try {
      captureConsole(() => {
        $Store.handleStartupReadError(new Error("read boom"));
      });
    } finally {
      restore();
    }

    assert.deepEqual(
      calls,
      { rename: 0, write: 0, copy: 1 },
      "启动路径必须走 backupOnly：只 copyFileSync，绝不 rename、绝不把原文件写成 {}"
    );
  });
});

test("handleStartupReadError: 弹窗文案带上底层错误原因（参数 e 不得被丢弃）", () => {
  withTempUserData((userData) => {
    fs.writeFileSync(path.join(userData, CONFIG_NAME), "{}");
    const { $Store, dialogs, restore } = loadStore(userData, makeThrowingGetStore());
    try {
      captureConsole(() => {
        $Store.handleStartupReadError(new Error("EBUSY: resource busy or locked"));
      });
    } finally {
      restore();
    }
    assert.equal(dialogs.length, 1);
    assert.equal(
      dialogs[0].includes("EBUSY: resource busy or locked"),
      true,
      "用户要能把错误原因截图反馈，e.message 必须进文案"
    );
  });
});

test("handleStartupReadError: 连备份都失败时仍弹窗 + exit(1)，且原文件保持原样", () => {
  withTempUserData((userData) => {
    const configFile = path.join(userData, CONFIG_NAME);
    const original = '{"pet":{"info":{"name":"老存档"}}}';
    fs.writeFileSync(configFile, original);

    const { $Store, dialogs, exitCodes, restore } = loadStore(userData, makeThrowingGetStore(), {
      fs: {
        copyFileSync: () => {
          throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        },
      },
    });
    let logs;
    try {
      logs = captureConsole(() => {
        $Store.handleStartupReadError(new Error("read boom"));
      });
    } finally {
      restore();
    }

    assert.equal(fs.readFileSync(configFile, "utf8"), original, "备份失败也绝不动原文件");
    assert.deepEqual(corruptFiles(userData), [], "备份失败不应留下半个副本");
    assert.ok(
      logs.error.some((m) => m.includes("备份存档副本失败") && m.includes("EBUSY")),
      "备份失败必须留带堆栈的日志"
    );
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].includes("原文件仍在原处"), true, dialogs[0]);
    assert.deepEqual(exitCodes, [1]);
  });
});

/* ------------------------------------------------------------------ *
 * doMain.js：启动期四个 $Store.getItem 都必须受保护
 * ------------------------------------------------------------------ */

/**
 * 在 vm 沙箱里加载 doMain.js，返回 { runCallback, spy }。
 * doMain.js 顶层就调用 root.createMain(cb, ...)，这里把 root.js 桩成"只捕获 cb"，
 * 由测试显式驱动，于是能真实执行启动回调而不需要 Electron。
 * @param {(key:string)=>any} getItem $Store.getItem 的行为（可对指定 key 抛错）
 */
function loadDoMain(getItem) {
  const spy = {
    reads: [],
    startupReadErrors: [],
    cleateCalls: [],
    petInfos: [],
    sysReadyAt: [],
  };
  const requireStub = (id) => {
    if (id.endsWith("root.js")) {
      return {
        createMain: (cb) => {
          spy.callback = cb;
        },
      };
    }
    if (id.endsWith("main/main.js")) {
      return { cleate: (arg) => spy.cleateCalls.push(arg) };
    }
    if (id.includes("pet/level")) {
      return {
        pinkDiamondLevel: {
          isExpirationDate: () => ({}),
          toChangeOtherDatas: () => ({}),
        },
      };
    }
    if (id.includes("starterKit")) return { buildStarterStore: () => ({ bag: [] }) };
    if (id.includes("travel")) return { init: () => {} };
    return {};
  };
  const sandbox = {
    console,
    module: { exports: {} },
    require: requireStub,
    $Store: {
      getItem: (key) => {
        spy.reads.push(key);
        return getItem(key);
      },
      handleStartupReadError: (e) => spy.startupReadErrors.push(e),
    },
    setSys: () => {},
    setCache: () => {},
    setPetInfo: (info) => spy.petInfos.push(info),
    getScreenSize: () => {},
    tool: {
      getTime: () => "26-08-01 12",
      getDayHourTime: () => 1,
    },
    upDownArr: (a) => a,
    shuffleArr: (a) => a,
    // 必须显式声明：doMain.js 里 `if($test)` 遇未声明标识符会 ReferenceError，
    // 被它自己的 catch 吞成 return，测试就再也走不到 main.cleate。
    $test: undefined,
  };
  sandbox.global = sandbox;
  vm.runInNewContext(fs.readFileSync(DOMAIN_PATH, "utf8"), sandbox, { filename: DOMAIN_PATH });
  assert.ok(typeof spy.callback === "function", "root.createMain 应被顶层调用并传入启动回调");
  // 回调签名 (post, host, fileName)
  spy.run = () => spy.callback(33385, "127.0.0.1", "ABC");
  return spy;
}

const OLD_PET = { info: { name: "老宠物", lastLoginTime: 0, health: 5 }, activeValue: { study: {} }, activeOption: {}, otherOptions: {} };

test("[Critical 回归] doMain 新宠物分支：toSex 读失败走 handleStartupReadError，不同步抛出", () => {
  const spy = loadDoMain((key) => {
    if (key === "toSex") throw new Error("toSex boom");
    return undefined; // pet/sys/cache 均为空 → 全新存档
  });
  // 同步 throw 会逃出 createMain 回调 → main.js 的 uncaughtException 处理器不退进程 → 僵尸进程
  assert.doesNotThrow(() => spy.run(), "toSex 读失败绝不能同步抛出启动回调");
  assert.equal(spy.startupReadErrors.length, 1, "必须走 handleStartupReadError 隔离退出");
  assert.match(String(spy.startupReadErrors[0]?.message), /toSex boom/, "要把原始异常传下去");
  assert.deepEqual(spy.cleateCalls, [], "读失败后绝不能继续建窗口");
  assert.deepEqual(spy.petInfos, [], "读失败后绝不能 setPetInfo（那会把空存档写回去）");
});

test("doMain 老存档启动：不读 toSex，故 toSex 故障也不影响启动", () => {
  const spy = loadDoMain((key) => {
    if (key === "toSex") throw new Error("toSex boom");
    if (key === "pet") return JSON.parse(JSON.stringify(OLD_PET));
    return {};
  });
  spy.run();
  assert.deepEqual(spy.reads, ["pet", "sys", "cache"], "老存档路径只该读这三个键，不得新增读点");
  assert.deepEqual(spy.startupReadErrors, [], "老存档启动不该触发隔离退出");
  assert.equal(spy.cleateCalls.length, 1, "老存档必须正常建窗口");
  assert.equal(spy.petInfos.length, 1);
  assert.equal(spy.petInfos[0].info.name, "老宠物");
});

test("doMain 新宠物分支：toSex 读取成功时性别仍按其值决定", () => {
  for (const [toSex, expected] of [["MM", "MM"], ["GG", "GG"], [undefined, "GG"]]) {
    const spy = loadDoMain((key) => (key === "toSex" ? toSex : undefined));
    spy.run();
    assert.deepEqual(spy.startupReadErrors, [], "正常读取不该触发隔离退出");
    assert.equal(spy.reads.includes("toSex"), true, "新宠物分支必须真的读 toSex");
    assert.equal(spy.petInfos.length, 1);
    assert.equal(
      spy.petInfos[0].info.sex,
      expected,
      `toSex=${String(toSex)} 时性别应为 ${expected}`
    );
  }
});

test("[反假绿] doMain.js 里不得再有未被 try 保护的 $Store.getItem", () => {
  const src = fs.readFileSync(DOMAIN_PATH, "utf8");
  // 结构护栏：上面的行为测试只覆盖已知的四个键；这条防止后续改动又加裸调用。
  const total = (src.match(/\$Store\.getItem\(/g) || []).length;
  assert.equal(total, 4, `doMain.js 目前应恰有 4 处 $Store.getItem，实际 ${total} 处`);
  assert.equal(
    /try\{n=\$Store\.getItem\("pet"\),o=\$Store\.getItem\("sys"\),a=\$Store\.getItem\("cache"\)\}catch/.test(src),
    true,
    "pet/sys/cache 三键必须在同一个 try 里"
  );
  assert.equal(
    /try\{_toSex=\$Store\.getItem\("toSex"\)\}catch/.test(src),
    true,
    "toSex 必须被单独的 try 包住"
  );
});
