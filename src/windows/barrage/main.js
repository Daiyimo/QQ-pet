// 弹幕覆盖层窗口（移植自 jarvis desktop/src/main.js createBarrageWindow + barrage-overlay.js）。
// 不走 windowsMain 工厂：需要 screen-saver 置顶层级，直接 BrowserWindow。
// 渲染层无 preload：通过 executeJavaScript 调 window.qqBarrage.show(text) 传弹幕。
const _require = eval("require");
const path = _require("path");

let win = null;
let ready = false;
const pending = [];

function ensure() {
  if (win && !win.isDestroyed()) return win;
  const { BrowserWindow, screen } = _require("electron");
  const bounds = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  win.on("closed", () => {
    win = null;
    ready = false;
    pending.length = 0;
  });
  win.webContents.on("did-finish-load", () => {
    ready = true;
    for (const text of pending.splice(0)) sendText(text);
  });
  win.loadFile(path.join(__dirname, "index.html"));
  return win;
}

// 移植 jarvis presentBarrageWindow：重设 bounds + 置顶 + 穿透 + 无焦点显示
function present() {
  if (!win || win.isDestroyed()) return false;
  const { screen } = _require("electron");
  win.setBounds(screen.getPrimaryDisplay().bounds, false);
  win.setAlwaysOnTop(true, "screen-saver", 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  win.showInactive();
  win.moveTop();
  return true;
}

function sendText(text) {
  if (!win || win.isDestroyed()) return;
  const js = `window.qqBarrage&&window.qqBarrage.show(${JSON.stringify(text)});void 0`;
  win.webContents.executeJavaScript(js).catch(() => {});
}

function show(text = "") {
  ensure();
  if (!present()) return;
  if (!text) return;
  if (ready) sendText(text);
  else pending.push(text);
}

function hide() {
  if (win && !win.isDestroyed()) win.hide();
}

function destroy() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  ready = false;
  pending.length = 0;
}

global.barrageWindow = { ensure, show, hide, destroy };
module.exports = global.barrageWindow;
