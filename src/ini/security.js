/**
 * security.js —— 会话级权限门禁（纯 node，不 require electron，便于真实行为测试）
 *
 * 背景：全仓此前从未调用 setPermissionRequestHandler / setPermissionCheckHandler，
 * Electron 未设 handler 时走默认策略，放行绝大多数权限请求（media / geolocation /
 * notifications 等），而 Electron **没有 Chrome 那样的权限气泡 UI**。
 * 同时 src/windows/tool/urlWindow/main.js 的设计用途就是 loadURL(用户输入的任意网址)
 * （仅过 http/https 白名单），且未设 partition —— 远程页面与本地窗共用 defaultSession。
 * 结果：用户在 urlWindow 里打开一个恶意页面，该页面可以无任何提示取用摄像头 / 麦克风 /
 * 定位。触发门槛只是「用户访问了坏网站」，而这个窗口就是为访问任意网站而存在的。
 *
 * === 权限需求实地核查结论（2026-08，改功能前请先读这段） ===
 * 逐项 grep 渲染层（排除 node_modules / lib/ant-design / js/ruffle/ruffle.js 自带实现）：
 *   - getUserMedia / navigator.mediaDevices        零命中 → 不需要 media
 *   - geolocation                                  零命中 → 不需要 geolocation
 *   - navigator.permissions.query                  零命中（本门禁不会打断现有代码）
 *   - IdleDetector / requestPointerLock / MIDI / usb / bluetooth / serial / hid  零命中
 *   - requestFullscreen                            仅 js/ruffle/ruffle.js 自带（见下）
 *   - navigator.clipboard.writeText                仅 js/ruffle/ruffle.js 自带（见下）
 * 三个易误判的点：
 *   1. 屏幕感知走**主进程** desktopCapturer（src/service/perception/capture.js），
 *      不经渲染层权限，所以 display-capture 全 deny 不影响感知。
 *   2. 通知用的是**主进程** electron Notification（src/windows/main/Notification.js），
 *      不是 Web Notification API，所以 notifications 全 deny 不影响 windowSay。
 *   3. BGM 是 `new Audio(...)`（src/windows/main/index.js），播放不需要任何权限；
 *      主进程 clipboard 模块（剪贴板上云）同理不经权限层。
 * 因此白名单为空 —— 这个应用自身一个渲染层权限都不需要。
 * 两处**已知会被拒**（有意为之，拒绝时有 warn 日志，不是静默故障）：
 *   - ruffle 右键菜单的「全屏」（fullscreen）：本体无任何代码调用 enterFullscreen，
 *     桌宠窗是透明无边框固定尺寸，全屏本无意义；而 urlWindow 里放行 fullscreen
 *     等于给恶意站点一个无提示的全屏 UI 伪造能力。
 *   - Flash 的 System.setClipboard（clipboard-sanitized-write）：属 swf 内容能力，
 *     不是本应用功能；本应用的剪贴板功能走主进程模块，不受影响。
 * 将来若真要加功能（如语音输入 → media），把权限名加进 PERMISSION_ALLOW_LIST，
 * 并更新本注释与 test/permissionHandler.test.js 的精确断言。
 */

/**
 * 允许的权限白名单（当前为空 = 全部拒绝）。
 * 取值必须是 Electron 的权限名，来源见 KNOWN_* 两个常量。
 */
const PERMISSION_ALLOW_LIST = Object.freeze([]);

/** 日志前缀：相对 src/ 的模块路径 */
const LOG_TAG = "[ini/security]";

/**
 * 单一判定函数 —— request / check 两个 handler 都只调它，
 * 从结构上保证「navigator.permissions.query 说 granted 但实际 request 被拒」不可能发生。
 * @param {unknown} permission Electron 传入的权限名
 * @param {readonly string[]} [allowList] 仅测试用于验证放行路径；生产恒为 PERMISSION_ALLOW_LIST
 * @returns {boolean}
 */
function isPermissionAllowed(permission, allowList = PERMISSION_ALLOW_LIST) {
  if (typeof permission !== "string" || permission === "") return false;
  return allowList.indexOf(permission) !== -1;
}

/** 取请求方来源，仅用于日志（details 在部分 Electron 路径下可能缺字段） */
function describeOrigin(requestingOrigin, details) {
  return requestingOrigin || details?.requestingUrl || details?.securityOrigin || "unknown";
}

/**
 * 给指定 session 装上两个权限门禁。必须在 app.whenReady() 之后、任何窗口创建之前调用。
 * @param {{setPermissionRequestHandler:Function, setPermissionCheckHandler:Function}} targetSession
 *        通常是 electron 的 session.defaultSession（本模块刻意不 require electron）
 * @returns {boolean} 是否安装成功
 */
function installPermissionHandlers(targetSession) {
  if (
    !targetSession ||
    typeof targetSession.setPermissionRequestHandler !== "function" ||
    typeof targetSession.setPermissionCheckHandler !== "function"
  ) {
    // 安全控制装不上必须可见：否则回到「默认放行且无 UI 提示」的状态却无人知晓
    console.warn(LOG_TAG, "session 不支持权限 handler，权限门禁未生效:", typeof targetSession);
    return false;
  }

  // 异步请求路径：getUserMedia / geolocation.getCurrentPosition / requestFullscreen 等
  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = isPermissionAllowed(permission);
    if (!allowed) {
      console.warn(
        LOG_TAG,
        "已拒绝权限请求:",
        permission,
        "origin:",
        describeOrigin(undefined, details),
        "url:",
        webContents?.getURL?.() || "unknown"
      );
    }
    if (typeof callback === "function") callback(allowed);
  });

  // 同步查询路径：navigator.permissions.query 由它回答，策略必须与上面一致
  targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const allowed = isPermissionAllowed(permission);
    if (!allowed) {
      console.warn(
        LOG_TAG,
        "已拒绝权限查询:",
        permission,
        "origin:",
        describeOrigin(requestingOrigin, details)
      );
    }
    return allowed;
  });

  return true;
}

module.exports = {
  PERMISSION_ALLOW_LIST,
  isPermissionAllowed,
  installPermissionHandlers,
};
