// src/service/electronPaths.js 的单元测试。
//
// 这个模块把 memory/store.js、courses/repo.js、courses/manager.js 里各写一遍的
// "取 Electron 路径 + 回退" 收敛成一处。三处内联实现都漏了同一个坑：
// 非 Electron 运行时下 require("electron") **不一定抛错**——本仓库 electron 是
// devDependency，其 index.js 导出的是可执行文件路径**字符串**，于是 app 为 undefined，
// `if (app && app.getPath)` 直接为假 → 静默掉进 fallback。本测试把两条降级分支都钉住。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const { getElectronPath } = require("../src/service/electronPaths.js");

function captureConsole(fn) {
  const logs = { warn: [], error: [] };
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => logs.warn.push(args.map((a) => String(a)).join(" "));
  console.error = (...args) => logs.error.push(args.map((a) => String(a)).join(" "));
  try {
    fn();
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
  return logs;
}

const FALLBACK = path.join("C:", "fallback-dir");

test("Electron 可用：直接返回 app.getPath 的结果，不产生日志", () => {
  const logs = captureConsole(() => {
    const got = getElectronPath("userData", FALLBACK, "unit", {
      electron: { app: { getPath: (k) => path.join("C:", "real", k) } },
    });
    assert.equal(got, path.join("C:", "real", "userData"));
  });
  assert.deepEqual(logs.warn, [], "正常路径不该有降级日志");
});

test("分支②：require 成功但 app 为 undefined（electron 导出字符串）→ 回退并留日志", () => {
  const logs = captureConsole(() => {
    // 真实的 devDependency 行为：require("electron") === "…/electron.exe"
    const got = getElectronPath("userData", FALLBACK, "unit", {
      electron: "E:\\project\\QQ-pet\\node_modules\\electron\\dist\\electron.exe",
    });
    assert.equal(got, FALLBACK);
  });
  assert.equal(logs.warn.length, 1, "这条正是三处内联实现共同漏掉的静默降级");
  assert.ok(logs.warn[0].includes("electron.app 不可用"), logs.warn[0]);
  assert.ok(logs.warn[0].includes("[unit]") && logs.warn[0].includes(FALLBACK));
});

test("分支②变体：electron 为 null / app 缺 getPath → 同样回退并留日志", () => {
  for (const electron of [null, undefined, {}, { app: {} }, { app: { getPath: 1 } }]) {
    const logs = captureConsole(() => {
      assert.equal(getElectronPath("desktop", FALLBACK, "unit", { electron }), FALLBACK);
    });
    assert.equal(logs.warn.length, 1, `electron=${JSON.stringify(electron)} 应留日志`);
    assert.ok(logs.warn[0].includes("electron.app 不可用"));
  }
});

test("分支①：require('electron') 抛错 → 回退并留日志", () => {
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "electron") throw Object.assign(new Error("Cannot find module 'electron'"), {
      code: "MODULE_NOT_FOUND",
    });
    return orig.apply(this, arguments);
  };
  let logs;
  try {
    logs = captureConsole(() => {
      assert.equal(getElectronPath("userData", FALLBACK, "unit"), FALLBACK);
    });
  } finally {
    Module.prototype.require = orig;
  }
  assert.equal(logs.warn.length, 1);
  assert.ok(logs.warn[0].includes("未能加载 electron"), logs.warn[0]);
  assert.ok(logs.warn[0].includes("Cannot find module"));
});

test("分支③：app.getPath 抛错 → 回退并记完整堆栈", () => {
  const logs = captureConsole(() => {
    const got = getElectronPath("nope", FALLBACK, "unit", {
      electron: {
        app: {
          getPath: () => {
            throw new Error("Failed to get 'nope' path");
          },
        },
      },
    });
    assert.equal(got, FALLBACK);
  });
  assert.equal(logs.warn.length, 1);
  assert.ok(logs.warn[0].includes('app.getPath("nope") 失败'));
  assert.ok(logs.warn[0].includes("at "), "意外异常必须打完整堆栈");
});

test("app.getPath 返回空值 → 回退并留日志（不返回空串把路径拼歪）", () => {
  const logs = captureConsole(() => {
    assert.equal(
      getElectronPath("userData", FALLBACK, "unit", { electron: { app: { getPath: () => "" } } }),
      FALLBACK
    );
  });
  assert.ok(logs.warn[0].includes("返回空值"));
});

test("三处调用点回归：纯 node 下回退路径与改造前逐字节一致，且不再静默", () => {
  const { defaultMemoryRoot } = require("../src/service/memory/store.js");
  const logs = captureConsole(() => {
    // 改造前：path.join(process.cwd(), "memory")
    assert.equal(defaultMemoryRoot(), path.join(process.cwd(), "memory"));
  });
  assert.ok(
    logs.warn.some((m) => m.includes("[memory/store]") && m.includes("electron.app 不可用")),
    "memory/store 的降级必须可见（改造前这里一行日志都没有）"
  );

  // courses/repo 的 defaultRoot 未导出，用 getElectronPath 直接复核同一套拼装规则
  const logs2 = captureConsole(() => {
    const base = getElectronPath("userData", process.cwd(), "courses/repo");
    assert.equal(path.join(base, "courses", "sessions"), path.join(process.cwd(), "courses", "sessions"));
  });
  assert.ok(logs2.warn.some((m) => m.includes("[courses/repo]")));
});
