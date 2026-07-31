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

const STORE_PATH = require.resolve("../src/ini/store.js");
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

/** 注入 electron-store / electron 后加载 store.js，返回 global.$Store */
function loadStore(userData, FakeStore) {
  delete require.cache[STORE_PATH];
  delete global.$Store;
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "electron-store") return FakeStore;
    if (id === "electron") return { app: { getPath: () => userData } };
    return orig.apply(this, arguments);
  };
  try {
    require(STORE_PATH);
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

    const logs = captureConsole(() => {
      const store = loadStore(dir, FakeStore);
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
    assert.ok(
      logs.error.some((m) => m.includes("已用空配置重建存储") && m.includes("corrupt-")),
      "必须告知用户损坏文件被隔离到哪里"
    );
    // 构造被调用两次：第一次抛错，隔离后第二次成功
    assert.equal(FakeStore.calls.length, 2);
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

test("隔离后仍然构造失败时：抛出并留下两条带堆栈的错误日志，不静默吞", () => {
  withTempUserData((dir) => {
    fs.writeFileSync(path.join(dir, CONFIG_NAME), "{bad");
    const FakeStore = makeFakeStoreClass({ userData: dir, alwaysThrow: true });
    const logs = captureConsole(() => {
      assert.throws(() => loadStore(dir, FakeStore), /Unexpected token/);
      // 断言在 captureConsole 之外统一做
    });
    assert.ok(logs.error.some((m) => m.includes("配置存储初始化失败")));
    assert.ok(
      logs.error.some((m) => m.includes("重建配置存储仍失败") && m.includes("SyntaxError")),
      "二次失败必须单独记一条带堆栈的日志"
    );
  });
});

test("getItem 读取异常：记录完整堆栈并按空值降级（原来是裸 catch(e){}）", () => {
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
      assert.deepEqual(store.getItem("pet"), {}, "读失败应返回空对象而不是崩溃");
      // 断言在 captureConsole 之外统一做
    });
    const hit = logs.error.find((m) => m.includes("读取配置项失败"));
    assert.ok(hit, "读取失败必须留日志");
    assert.ok(hit.includes("key=pet"), "日志要能定位到具体配置键");
    assert.ok(hit.includes("boom-get") && hit.includes("at "), "必须打完整堆栈");
  });
});
