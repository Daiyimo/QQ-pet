// 拖动实验：验证 -webkit-app-region 在透明/不透明窗口下是否生效
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const WIN_DIR = path.join(__dirname, "../src/windows");
const LOG = path.join(__dirname, "pos.log");
fs.writeFileSync(LOG, "start " + new Date().toISOString() + "\n");
const log = (m) => fs.appendFileSync(LOG, m + "\n");

const base = {
  width: 190,
  height: 290,
  frame: false,
  resizable: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  hasShadow: false,
  backgroundColor: "#00000000",
  roundedCorners: false,
  webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false },
};

function logPos(tag, win) {
  try {
    log(tag + " pos=" + JSON.stringify(win.getPosition()) + " size=" + JSON.stringify(win.getSize()));
  } catch (e) {}
}

app.whenReady().then(() => {
  // A: 完全复刻 stateInfo 弹窗（透明 + app.html + 注入 index.html/index.css）
  const a = new BrowserWindow({ ...base, transparent: true, x: 600, y: 300 });
  a.loadFile(path.join(WIN_DIR, "app.html"));
  a.webContents.on("did-finish-load", () => {
    const html = fs.readFileSync(path.join(WIN_DIR, "popups/stateInfo/index.html")).toString();
    a.webContents.executeJavaScript(`
      const app = document.getElementById('app');
      app.innerHTML = ${JSON.stringify(html)};
      app.style.display = 'flex'; app.style.opacity = 1;
    `);
    const cssFiles = [
      "lib/ant-design/antd.css",
      "css/index.css",
      "css/util.css",
      "css/keyframes.css",
      "popups/stateInfo/index.css",
    ];
    for (const f of cssFiles) {
      try { a.webContents.insertCSS(fs.readFileSync(path.join(WIN_DIR, f)).toString()); }
      catch (e) { log("A css miss " + f); }
    }
    setTimeout(() => {
      a.webContents.executeJavaScript(`
        (() => {
          const q = (s) => { const el = document.querySelector(s); if (!el) return s + ':MISSING';
            const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
            return s + ' appRegion=' + cs.getPropertyValue('-webkit-app-region')
              + ' rect=' + [r.x|0, r.y|0, r.width|0, r.height|0].join(','); };
          return [q('#app'), q('.head'), q('.close'), q('.petFile'), q('.content_main'), q('#appMain')].join('\\n');
        })()
      `).then((r) => log("A computed:\n" + r));
    }, 800);
  });

  // B: 不透明窗口 + 极简 drag div（对照组1：非透明）
  const b = new BrowserWindow({ ...base, transparent: false, x: 1000, y: 300 });
  b.loadURL("data:text/html,<body style='margin:0;background:#fff'><div id='h' style='-webkit-app-region:drag;height:40px;background:#cde'>HEAD</div><div>body</div></body>");

  // C: 透明窗口 + 极简 drag div（对照组2：透明但无项目 CSS）
  const c = new BrowserWindow({ ...base, transparent: true, x: 1400, y: 300 });
  c.loadURL("data:text/html,<body style='margin:0'><div id='h' style='-webkit-app-region:drag;height:40px;background:rgba(200,220,238,0.9)'>HEAD</div><div style='background:rgba(255,255,255,0.5)'>body</div></body>");

  logPos("A", a); logPos("B", b); logPos("C", c);
  const timer = setInterval(() => { logPos("A", a); logPos("B", b); logPos("C", c); }, 1000);
  setTimeout(() => { clearInterval(timer); log("end"); app.exit(0); }, 30000);
});
