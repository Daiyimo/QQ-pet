// 实验2：定位 app-region 失效原因
// A: stateInfo 复刻（含 #app no-drag !important）
// F: stateInfo 复刻但去掉 #app no-drag 规则（#app 保持 .drag 类 → 全窗 drag）
// B: 不透明 + 极简 drag div
// C: 透明 + 极简 drag div
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const WIN_DIR = path.join(__dirname, "../src/windows");
const LOG = path.join(__dirname, "pos2.log");
fs.writeFileSync(LOG, "start " + new Date().toISOString() + "\n");
const log = (m) => fs.appendFileSync(LOG, m + "\n");

const base = {
  width: 190, height: 290, frame: false, resizable: false,
  skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
  backgroundColor: "#00000000", roundedCorners: false,
  webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false },
};

function logPos(tag, win) {
  try { log(tag + " pos=" + JSON.stringify(win.getPosition())); } catch (e) {}
}

function makeStateInfo(tag, x, stripNoDrag) {
  const w = new BrowserWindow({ ...base, transparent: true, x, y: 100 });
  w.loadFile(path.join(WIN_DIR, "app.html"));
  w.webContents.on("did-finish-load", () => {
    const html = fs.readFileSync(path.join(WIN_DIR, "popups/stateInfo/index.html")).toString();
    w.webContents.executeJavaScript(`
      const app = document.getElementById('app');
      app.innerHTML = ${JSON.stringify(html)};
      app.style.display = 'flex'; app.style.opacity = 1;
    `);
    const cssFiles = ["lib/ant-design/antd.css", "css/index.css", "css/util.css", "css/keyframes.css"];
    for (const f of cssFiles) {
      try { w.webContents.insertCSS(fs.readFileSync(path.join(WIN_DIR, f)).toString()); } catch (e) {}
    }
    let siCss = fs.readFileSync(path.join(WIN_DIR, "popups/stateInfo/index.css")).toString();
    if (stripNoDrag) {
      siCss = siCss.replace(/#app\s*\{[^}]*\}/, "#app { background-color: transparent !important; }");
    }
    w.webContents.insertCSS(siCss);
    setTimeout(() => {
      w.webContents.executeJavaScript(`
        (() => {
          const el = document.elementFromPoint(90, 10);
          const chain = el ? (el.className + ' < ' + (el.parentElement ? el.parentElement.className : '')) : 'null';
          const h = document.querySelector('.head');
          const cs = h ? getComputedStyle(h).getPropertyValue('-webkit-app-region') : 'MISSING';
          const appcs = getComputedStyle(document.getElementById('app')).getPropertyValue('-webkit-app-region');
          return 'hit@90,10=' + chain + ' | .head=' + cs + ' | #app=' + appcs;
        })()
      `).then((r) => log(tag + " " + r));
    }, 800);
  });
  return w;
}

app.whenReady().then(() => {
  const a = makeStateInfo("A", 600, false);
  const f = makeStateInfo("F", 900, true);

  const b = new BrowserWindow({ ...base, transparent: false, x: 1200, y: 100 });
  b.loadURL("data:text/html,<body style='margin:0;background:#fff'><div style='-webkit-app-region:drag;height:40px;background:#cde'>HEAD</div><div>body</div></body>");

  const c = new BrowserWindow({ ...base, transparent: true, x: 1500, y: 100 });
  c.loadURL("data:text/html,<body style='margin:0'><div style='-webkit-app-region:drag;height:40px;background:rgba(200,220,238,0.9)'>HEAD</div><div style='background:rgba(255,255,255,0.5)'>body</div></body>");

  logPos("A", a); logPos("F", f); logPos("B", b); logPos("C", c);
  const timer = setInterval(() => { logPos("A", a); logPos("F", f); logPos("B", b); logPos("C", c); }, 250);
  setTimeout(() => { clearInterval(timer); log("end"); app.exit(0); }, 60000);
});
