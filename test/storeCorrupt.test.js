// src/ini/store.js（压缩产物）的损坏存档恢复测试。
//
// 修复的缺陷：原实现 `clearInvalidConfig:!0` —— electron-store(conf) 的该选项语义是
// "读配置抛 SyntaxError 就把整个配置文件清空"，而这个 store 承载全部本地状态
// （pet / sys / cache，含加密后的 API Key）。存档被截断一次，玩家数据就整体清零，
// 且 getItem 的 `catch(e){}` 连一行日志都不留。
//
// 本机没有 node_modules，因此 electron-store 与 electron 全部通过 Module.prototype.require
// 拦截注入（store.js 内部是 `eval("require")`，走的正是模块级 require）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

/* 被测源码路径。可用 QQ_INI_STORE_SRC 覆盖，专为"变异测试/回滚验证"准备：
   把修复回滚后的版本写进临时文件，再
   `QQ_INI_STORE_SRC=<临时文件> node --test test/storeCorrupt.test.js`，
   即可验证这些用例真的会红——无需改动仓库里的 src/。
   与 test/storeBagCache.test.js 的 QQ_STORE_SRC 同一套约定。 */
const STORE_PATH = process.env.QQ_INI_STORE_SRC
  ? path.resolve(process.env.QQ_INI_STORE_SRC)
  : require.resolve("../src/ini/store.js");
const CONFIG_NAME = "config-qq-local.json";

function withTempUserData(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqstore-corrupt-"));
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

/** 模拟 conf@10 的行为：读到非法 JSON 时，clearInvalidConfig 为假就把 SyntaxError 抛出构造器 */
function makeFakeStoreClass(behaviour = {}) {
  const calls = [];
  class FakeStore {
    constructor(option) {
      calls.push({ ...option });
      if (behaviour.alwaysThrow) {
        const e = new SyntaxError("Unexpected token } in JSON at position 3");
        throw e;
      }
      this.file = path.join(behaviour.userData, `${option.name}.${option.fileExtension}`);
      let raw = null;
      try {
        raw = fs.readFileSync(this.file, "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (raw === null) {
        this.data = {};
        return;
      }
      try {
        this.data = JSON.parse(raw);
      } catch (e) {
        if (option.clearInvalidConfig) {
          // 这正是我们要避免的分支：整份配置被清空
          this.data = {};
          fs.writeFileSync(this.file, "{}");
          return;
        }
        throw e; // SyntaxError 上抛，交给 store.js 的恢复逻辑
      }
    }
    get(key) {
      return this.data[key];
    }
    set(key, value) {
      this.data[key] = value;
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    }
    delete(key) {
      delete this.data[key];
    }
    clear() {
      this.data = {};
    }
  }
  FakeStore.calls = calls;
  return FakeStore;
}

/**
 * 注入 electron-store / electron（含 dialog）/ fs 后加载 store.js，返回 global.$Store。
 * @param {string} userData 假的 userData 目录
 * @param {Function} FakeStore electron-store 替身
 * @param {object} [opts]
 * @param {object} [opts.fs] 覆盖真实 fs 的部分方法（模拟 renameSync EPERM 等）
 * @param {string[]} [opts.dialogs] 收集 dialog.showErrorBox 的正文
 * @param {(store:any)=>void} [opts.while] 在注入仍生效期间执行的回调
 */
function loadStore(userData, FakeStore, opts = {}) {
  delete require.cache[STORE_PATH];
  delete global.$Store;
  const orig = Module.prototype.require;
  const fsProxy = opts.fs ? { ...fs, ...opts.fs } : null;
  const fakeElectron = {
    app: { getPath: () => userData },
    dialog: {
      showErrorBox: (title, content) => {
        if (opts.dialogs) opts.dialogs.push(String(content));
      },
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
    // opts.while 里的代码在注入仍生效时运行：store.js 的 _require 是加载时捕获的
    // 模块级 require，还原后再调 _require("electron") 会 MODULE_NOT_FOUND。
    if (opts.while) opts.while(global.$Store);
    return global.$Store;
  } finally {
    Module.prototype.require = orig;
    delete require.cache[STORE_PATH];
  }
}

function corruptFiles(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith("config-qq-local.corrupt-"));
}

test("clearInvalidConfig 必须为 false —— 否则 electron-store 会自行清空整份存档", () => {
  withTempUserData((dir) => {
    const FakeStore = makeFakeStoreClass({ userData: dir });
    captureConsole(() => loadStore(dir, FakeStore));
    assert.equal(FakeStore.calls.length, 1);
    assert.equal(
      FakeStore.calls[0].clearInvalidConfig,
      false,
      "clearInvalidConfig 一旦为 true，损坏存档会被 conf 静默清零"
    );
    assert.equal(FakeStore.calls[0].name, "config-qq-local");
  });
});

test("存档 JSON 损坏时：隔离为 corrupt-<时间戳>.json 并保留原内容，再以空配置重建", () => {
  withTempUserData((dir) => {
    const broken = '{"pet":{"info":{"name":"我","yb":123}}';
    fs.writeFileSync(path.join(dir, CONFIG_NAME), broken);
    const FakeStore = makeFakeStoreClass({ userData: dir });
    const dialogs = [];

    const logs = captureConsole(() => {
      const store = loadStore(dir, FakeStore, { dialogs });
      assert.ok(store, "损坏存档不得让启动链路崩溃");
      // 重建后的存储可正常读写
      store.setItem("pet", { info: { name: "新" } });
      assert.deepEqual(store.getItem("pet"), { info: { name: "新" } });
      // 断言在 captureConsole 之外统一做
    });

    const backups = corruptFiles(dir);
    assert.equal(backups.length, 1, `应有且只有 1 个隔离文件，实际 ${JSON.stringify(backups)}`);
    assert.match(backups[0], /^config-qq-local\.corrupt-\d+\.json$/);
    assert.equal(
      fs.readFileSync(path.join(dir, backups[0]), "utf8"),
      broken,
      "隔离文件必须原样保留损坏内容，供人工修复"
    );
    assert.ok(
      logs.error.some((m) => m.includes("配置存储初始化失败") && m.includes("SyntaxError")),
      "必须记录带堆栈的初始化失败日志（不能静默）"
    );
    // 用户必须被明确告知（只打日志等于毫不知情）
    assert.equal(dialogs.length, 1, "必须弹一次 showErrorBox 告知用户");
    assert.ok(dialogs[0].includes("存档疑似损坏"), dialogs[0]);
    assert.ok(dialogs[0].includes(backups[0]), "告知文案里要给出隔离文件的路径");
    assert.ok(dialogs[0].includes("空存档启动"), "要说明本次以空存档启动");
    // 构造被调用两次：第一次抛错，隔离后第二次成功
    assert.equal(FakeStore.calls.length, 2);
  });
});

test("[Critical 回归] rename 被占用（EPERM）：改用复制备份+覆盖，仍以原文件名成功启动", () => {
  withTempUserData((dir) => {
    const broken = '{"pet":{"info":{"yb":5}}';
    fs.writeFileSync(path.join(dir, CONFIG_NAME), broken);
    const FakeStore = makeFakeStoreClass({ userData: dir });
    const dialogs = [];
    let store;
    const logs = captureConsole(() => {
      // 杀软/备份程序持有句柄的典型表现
      store = loadStore(dir, FakeStore, {
        dialogs,
        fs: {
          renameSync: () => {
            throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
              code: "EPERM",
            });
          },
        },
      });
    });

    assert.ok(store, "renameSync 失败绝不能抛到模块顶层（会变成无窗口僵尸进程）");
    store.setItem("pet", { info: { yb: 1 } });
    assert.deepEqual(store.getItem("pet"), { info: { yb: 1 } }, "返回的 store 必须真的可用");

    const backups = corruptFiles(dir);
    assert.equal(backups.length, 1, "应通过 copyFileSync 留下备份");
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), broken, "备份内容须完整");
    assert.equal(
      fs.readFileSync(path.join(dir, CONFIG_NAME), "utf8").trim().startsWith("{"),
      true,
      "原文件应被覆盖成合法 JSON，使重建可以成功"
    );
    assert.ok(
      logs.error.some((m) => m.includes("重命名隔离失败") && m.includes("EPERM")),
      "rename 失败必须留带堆栈的日志"
    );
    assert.equal(dialogs.length, 1, "必须告知用户");
    assert.ok(dialogs[0].includes(backups[0]));
  });
});

test("[Critical 回归] rename 与 copy 都失败：改用 -recovered-<ts> 新文件名启动，绝不抛异常", () => {
  withTempUserData((dir) => {
    fs.writeFileSync(path.join(dir, CONFIG_NAME), "{bad");
    // 只有原文件名会抛（内容非法）；新文件名不存在 → 构造成功
    const FakeStore = makeFakeStoreClass({ userData: dir });
    const dialogs = [];
    let store;
    const logs = captureConsole(() => {
      store = loadStore(dir, FakeStore, {
        dialogs,
        fs: {
          renameSync: () => {
            throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
          },
          copyFileSync: () => {
            throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
          },
        },
      });
    });

    assert.ok(store, "原文件完全动不了时也必须让程序起来（这条是本次 Critical 的核心）");
    store.setItem("pet", { info: { yb: 2 } });
    assert.deepEqual(store.getItem("pet"), { info: { yb: 2 } });

    // 用的是新文件名
    const usedName = FakeStore.calls[FakeStore.calls.length - 1].name;
    assert.match(usedName, /^config-qq-local-recovered-\d+$/, `实际用了 ${usedName}`);
    assert.equal(store.recoveredName, usedName, "应记录本次使用的降级文件名");
    // 旧文件一字未动
    assert.equal(fs.readFileSync(path.join(dir, CONFIG_NAME), "utf8"), "{bad", "旧文件必须原样保留");
    assert.deepEqual(corruptFiles(dir), [], "备份失败时不应留下半个 corrupt 文件");

    assert.ok(logs.error.some((m) => m.includes("复制备份损坏文件也失败") && m.includes("EBUSY")));
    assert.ok(logs.error.some((m) => m.includes("改用新文件名启动")));
    assert.equal(dialogs.length, 1, "必须告知用户改用了新存档文件");
    assert.ok(dialogs[0].includes(usedName), "告知文案要写出新存档文件名");
    assert.ok(dialogs[0].includes("旧文件完整保留"));
  });
});

test("[Critical 回归] 连新文件名都建不起来：先 showErrorBox 再抛，不做无声僵尸", () => {
  withTempUserData((dir) => {
    fs.writeFileSync(path.join(dir, CONFIG_NAME), "{bad");
    // userData 整体不可写：任何 name 都失败
    const FakeStore = makeFakeStoreClass({ userData: dir, alwaysThrow: true });
    const dialogs = [];
    const logs = captureConsole(() => {
      assert.throws(() => loadStore(dir, FakeStore, { dialogs }), /Unexpected token/);
    });
    assert.ok(logs.error.some((m) => m.includes("配置存储初始化失败")));
    assert.ok(
      logs.error.some((m) => m.includes("改用新文件名重建配置存储也失败") && m.includes("SyntaxError")),
      "最终失败必须单独记一条带堆栈的日志"
    );
    assert.equal(dialogs.length, 1, "抛之前必须先让用户看到原因");
    assert.ok(dialogs[0].includes("无法创建宠物存档文件"), dialogs[0]);
    assert.ok(dialogs[0].includes("权限"), "要给出可操作的排查方向");
    // 尝试过 3 次构造：原名、原名重试、新名
    assert.equal(FakeStore.calls.length, 3);
  });
});

test("dialog 不可用（无 electron / 无 showErrorBox）时：降级为日志且不抛", () => {
  withTempUserData((dir) => {
    fs.writeFileSync(path.join(dir, CONFIG_NAME), "{bad");
    const FakeStore = makeFakeStoreClass({ userData: dir });
    delete require.cache[STORE_PATH];
    delete global.$Store;
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === "electron-store") return FakeStore;
      // app 有、dialog 没有：模拟 dialog 不可用
      if (id === "electron") return { app: { getPath: () => dir } };
      return orig.apply(this, arguments);
    };
    let store;
    const logs = captureConsole(() => {
      try {
        require(STORE_PATH);
        store = global.$Store;
      } finally {
        Module.prototype.require = orig;
        delete require.cache[STORE_PATH];
      }
    });
    assert.ok(store, "dialog 缺失不能影响启动");
    assert.ok(
      logs.error.some((m) => m.includes("存档异常告知用户") && m.includes("存档疑似损坏")),
      "弹不出窗时至少要把完整文案写进日志"
    );
  });
});

test("存档正常时：不产生隔离文件，数据原样可读", () => {
  withTempUserData((dir) => {
    fs.writeFileSync(path.join(dir, CONFIG_NAME), JSON.stringify({ pet: { info: { yb: 7 } } }));
    const FakeStore = makeFakeStoreClass({ userData: dir });
    const logs = captureConsole(() => {
      const store = loadStore(dir, FakeStore);
      assert.deepEqual(store.getItem("pet"), { info: { yb: 7 } });
      // 断言在 captureConsole 之外统一做
    });
    assert.deepEqual(corruptFiles(dir), [], "正常存档绝不能被隔离/改名");
    assert.deepEqual(logs.error, [], "正常路径不应有错误日志");
  });
});

test("getItem 读取异常：记录完整堆栈后向上抛（原来是记日志后按空值降级 {}）", () => {
  withTempUserData((dir) => {
    const FakeStore = makeFakeStoreClass({ userData: dir });
    const logs = captureConsole(() => {
      const store = loadStore(dir, FakeStore);
      // 模拟底层读取抛错（配置被外部占用 / schema 校验失败等）
      store.ElectronStore = {
        get() {
          throw new Error("boom-get");
        },
      };
      // 静默返回 {} 会让 doMain 把老存档误判成新宠物并覆盖落盘，异常必须上抛
      assert.throws(() => store.getItem("pet"), /boom-get/);
      // 断言在 captureConsole 之外统一做
    });
    const hit = logs.error.find((m) => m.includes("读取配置项失败"));
    assert.ok(hit, "读取失败必须留日志");
    assert.ok(hit.includes("key=pet"), "日志要能定位到具体配置键");
    assert.ok(hit.includes("boom-get") && hit.includes("at "), "必须打完整堆栈");
  });
});

// isolateBrokenConfig 的两种模式必须泾渭分明：
//   默认（真损坏的隔离，createStore 用）—— 允许破坏原路径，因为要让下一次 new Store 成功；
//   backupOnly（启动读失败，handleStartupReadError 用）—— 读失败可能只是杀软瞬时占用，
//   存档本身或许完好，而且这条路径反正要 app.exit(1)，破坏原文件纯属净损失。
test("isolateBrokenConfig 默认模式：rename 隔离原文件（真损坏路径保持破坏性行为）", () => {
  withTempUserData((dir) => {
    const original = '{"pet":{"info":{"yb":7}}}';
    fs.writeFileSync(path.join(dir, CONFIG_NAME), original);
    const FakeStore = makeFakeStoreClass({ userData: dir });
    let ret;
    captureConsole(() => {
      loadStore(dir, FakeStore, { while: (store) => (ret = store.isolateBrokenConfig()) });
    });
    assert.equal(ret.method, "rename");
    assert.equal(fs.existsSync(path.join(dir, CONFIG_NAME)), false, "默认模式应把原文件改名走");
    const backups = corruptFiles(dir);
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), original);
  });
});

test("isolateBrokenConfig({backupOnly:true})：只复制副本，原文件既不改名也不覆盖", () => {
  withTempUserData((dir) => {
    const original = '{"pet":{"info":{"yb":7}}}';
    fs.writeFileSync(path.join(dir, CONFIG_NAME), original);
    const FakeStore = makeFakeStoreClass({ userData: dir });
    let ret;
    captureConsole(() => {
      loadStore(dir, FakeStore, {
        while: (store) => (ret = store.isolateBrokenConfig({ backupOnly: true })),
      });
    });
    assert.equal(ret.method, "backup-only", "backupOnly 模式要有独立的 method 标识");
    assert.equal(
      fs.readFileSync(path.join(dir, CONFIG_NAME), "utf8"),
      original,
      "backupOnly 绝不能改名或把原文件覆盖成 {}"
    );
    const backups = corruptFiles(dir);
    assert.equal(backups.length, 1, "但仍须留一份可人工排查的副本");
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), original);
  });
});
