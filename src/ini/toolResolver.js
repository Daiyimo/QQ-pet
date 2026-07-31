// 工具窗模式的名称解析（纯函数，无副作用，便于测试）
//
// 背景：main.js 支持两条进入「工具窗模式」的路径 —— 命令行参数与环境变量 NODE_TOOL，
// 解析结果会被直接拼进 require("./src/windows/tool/" + name + "/main.js")。
// 环境变量那条路径此前完全没过白名单，任何值都会被拼进 require：
//   - 值不存在时（如已删除的 viewSwf）→ MODULE_NOT_FOUND，桌宠在启动阶段直接崩溃
//   - 值可控时 → 路径穿越地加载任意本地 js
// 因此两条路径统一收敛到同一个白名单。

/** 允许进入工具窗模式的工具名白名单。新增工具窗时必须同步登记，否则不会被加载。 */
const TOOL_WHITELIST = ["floatStyle"];

/**
 * 从命令行参数与环境变量解析工具窗名称。
 *
 * 命令行沿用历史语义：只要任一 argv 项**包含**白名单里的工具名子串即命中
 * （历史上靠 `electron . floatStyle` 这种传法启动，不是严格相等匹配）。
 * 环境变量则要求**严格等于**白名单某一项。命令行优先于环境变量。
 *
 * @param {string[]} argv 命令行参数列表（通常是 process.argv）。
 * @param {string|undefined} envValue 环境变量 NODE_TOOL 的值。
 * @param {string[]} [whitelist] 允许的工具名，默认 TOOL_WHITELIST。
 * @returns {string|null} 命中的工具名；均未命中或入参非法时返回 null（= 普通桌宠模式）。
 */
function resolveToolName(argv, envValue, whitelist = TOOL_WHITELIST) {
  const allowed = Array.isArray(whitelist) ? whitelist : [];

  if (Array.isArray(argv)) {
    for (const tool of allowed) {
      const hit = argv.some(
        (item) => typeof item === "string" && item.indexOf(tool) !== -1
      );
      if (hit) return tool;
    }
  }

  if (typeof envValue === "string" && allowed.includes(envValue)) {
    return envValue;
  }

  return null;
}

module.exports = { resolveToolName, TOOL_WHITELIST };
