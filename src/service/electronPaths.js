// Electron 路径获取的统一入口（含完整降级日志）。
//
// ## 为什么需要这个模块
// memory/store.js、courses/repo.js、courses/manager.js 原本各自内联同一段：
//   try { const { app } = require("electron"); if (app && app.getPath) return app.getPath(k); }
//   catch (e) { console.warn(...) }
//   return fallback;
// 三处都漏了同一个坑：**非 Electron 运行时下 require("electron") 不一定抛错**。
// 本仓库 electron 是 devDependency，`node_modules/electron/index.js` 的导出是
// **可执行文件路径字符串**（实测 `typeof require("electron") === "string"`），
// 于是 `electron.app` 为 undefined、`if (app && app.getPath)` 直接为假 ——
// 掉进 fallback 却一行日志都没有，正是"降级路径必须可观测"要消灭的情况。
//
// 因此可用性判定必须是两条独立分支：① require 本身抛错；② require 成功但 app 不可用。
//
// ## 与 src/ini/dataWatcher.js 的关系
// 同款判定在 `src/ini/dataWatcher.js` 内联实现（那里刻意不引用本模块，避免
// src/ini → src/service 的反向依赖），**两处修改需同步**。
const _require = eval("require");

/**
 * 取 Electron 的标准路径；任何一种取不到的情形都回退 fallbackPath 并留日志。
 *
 * @param {string} kind         app.getPath 的路径名（"userData" / "desktop" …）
 * @param {string} fallbackPath 取不到时的回退绝对路径（调用方给出，通常基于 cwd / homedir）
 * @param {string} tag          日志前缀，形如 "memory/store"
 * @param {object} [deps]       仅供单测注入：{ electron }（传 null 模拟 require 抛错）
 * @returns {string} 可用的绝对路径（Electron 路径或 fallbackPath）
 */
function getElectronPath(kind, fallbackPath, tag, deps = {}) {
  let electron;
  if ("electron" in deps) {
    electron = deps.electron;
  } else {
    try {
      electron = _require("electron");
    } catch (e) {
      // 分支①：完全没有 electron 包（纯 node 环境）。属预期降级，但必须可见。
      console.warn(
        `[${tag}] 未能加载 electron，${kind} 路径退回 ${fallbackPath}:`,
        e && e.message ? e.message : e
      );
      return fallbackPath;
    }
  }

  const app = electron && electron.app;
  if (!app || typeof app.getPath !== "function") {
    // 分支②：require 成功但拿不到 app（非 Electron 运行时 / electron 导出的是路径字符串）。
    // 这一条正是三处内联实现共同漏掉的静默降级。
    console.warn(
      `[${tag}] electron.app 不可用（不在 Electron 运行时？），${kind} 路径退回 ${fallbackPath}`
    );
    return fallbackPath;
  }

  try {
    const resolved = app.getPath(kind);
    if (!resolved) {
      console.warn(`[${tag}] app.getPath("${kind}") 返回空值，路径退回 ${fallbackPath}`);
      return fallbackPath;
    }
    return resolved;
  } catch (e) {
    // 分支③：路径名不被支持 / 系统目录不可用等意外错误，记完整堆栈
    console.warn(
      `[${tag}] app.getPath("${kind}") 失败，路径退回 ${fallbackPath}:`,
      e && e.stack ? e.stack : e
    );
    return fallbackPath;
  }
}

module.exports = { getElectronPath };
