/**
 * pathGuard.js —— 资源路径越权校验（纯 node，无 electron / 无第三方依赖）
 *
 * 背景：preload 桥（src/windows/main/preload.js）把「皮肤名」与「Config.xml 里的
 * 相对文件名」直接拼进 fs 读取路径。这两个值最终来源于用户配置（getSys("petSkin")）
 * 与皮肤包内的 XML，属于**不可信输入**：传 `../../../..` 即可越出资源目录读任意文件，
 * 并被 GB2312 解码后回传渲染层。
 *
 * 本模块只做一件事：把「root + 若干路径片段」解析成绝对路径，并保证结果**仍在 root 之内**，
 * 否则返回 null（调用方必须按拒绝处理并记日志）。
 *
 * 设计要点：
 * - 用 path.resolve 而非字符串拼接：绝对路径片段会覆盖 root（Windows 盘符、UNC、POSIX /），
 *   `..` 会被真正折叠，因此必须在 resolve **之后**再做前缀校验，不能在之前做黑名单。
 * - 前缀校验带 path.sep 边界，避免 `assets/ActionNew` 与 `assets/ActionNewEvil` 混淆。
 * - Windows 文件系统大小写不敏感（本项目仅打包 win），默认按不敏感比较，
 *   否则 `.../actionnew/x` 这类合法路径会被误拒；可用 caseInsensitive 显式覆盖（便于测试）。
 * - NUL 字节直接拒绝：fs.* 遇到会抛 ERR_INVALID_ARG_VALUE，且常见于路径截断绕过。
 */
const path = require("path");

/** 皮肤资源根目录（相对 src/windows/main/ 即 preload 所在目录） */
const SKIN_ASSETS_ROOT_REL = "../../assets/ActionNew";

const isBadString = (s) => typeof s !== "string" || s === "" || s.indexOf("\0") !== -1;

/** 去掉尾部分隔符（C:\ 这类根目录保留），便于做前缀边界比较 */
function stripTrailingSep(p) {
  while (p.length > 1 && (p.endsWith(path.sep) || p.endsWith("/"))) {
    const next = p.slice(0, -1);
    // 形如 "C:\" / "/" 的根目录不再截断
    if (path.dirname(next) === next) break;
    p = next;
  }
  return p;
}

/**
 * 判断 targetPath 是否位于 rootDir 之内（含等于 rootDir 本身）。
 * @param {string} rootDir 白名单根目录
 * @param {string} targetPath 待校验路径
 * @param {{caseInsensitive?:boolean}} [options]
 * @returns {boolean}
 */
function isInsideDir(rootDir, targetPath, options = {}) {
  if (isBadString(rootDir) || isBadString(targetPath)) return false;
  const caseInsensitive =
    typeof options.caseInsensitive === "boolean" ? options.caseInsensitive : process.platform === "win32";
  const fold = (s) => (caseInsensitive ? s.toLowerCase() : s);
  const root = fold(stripTrailingSep(path.resolve(rootDir)));
  const target = fold(stripTrailingSep(path.resolve(targetPath)));
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * 把 segments 解析为 rootDir 下的绝对路径；越界或非法输入返回 null。
 * @param {string} rootDir 白名单根目录
 * @param {string[]} segments 不可信路径片段（皮肤名 / Config.xml 中的相对文件名等）
 * @param {{caseInsensitive?:boolean}} [options]
 * @returns {string|null} 绝对路径，或 null 表示拒绝
 */
function resolveInsideDir(rootDir, segments, options = {}) {
  if (isBadString(rootDir)) return null;
  const parts = Array.isArray(segments) ? segments : [segments];
  if (parts.length === 0) return null;
  for (const s of parts) {
    if (isBadString(s)) return null;
  }
  const target = path.resolve(rootDir, ...parts);
  return isInsideDir(rootDir, target, options) ? target : null;
}

module.exports = { SKIN_ASSETS_ROOT_REL, isInsideDir, resolveInsideDir };
