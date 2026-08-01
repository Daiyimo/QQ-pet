/**
 * CSP / 导航守卫 / webSecurity opt-out 冒烟测试（一次性验证脚本，不被 npm test 收录）
 * 运行方式: npx electron test/ruffleSmoke/runCspGuard.js
 *
 * 验证本轮安全收紧没有掐死正常功能：
 * A. app.html 新加的 CSP meta 下，Ruffle 仍能加载并播放真实 SWF（像素判定）；
 * B. 窗口工厂（src/windows/window.js 真实代码）默认 webSecurity:true、opt-out 生效、
 *    顶层导航离开 app.html 被拦、window.open 被 deny；
 * C. CSP 的 frame-src 下，http://127.0.0.1 子框架（钓鱼/密室 iframe 同款形态）仍能加载，
 *    且子框架导航不触发 will-navigate 拦截。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

app.setName("csp-guard-smoke");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "csp-guard-smoke-")));
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
// 各阶段之间窗口会短暂清零，禁止默认的 window-all-closed 退出（退出统一走 app.exit）
app.on("window-all-closed", () => {});

const SRC_WINDOWS = path.join(__dirname, "..", "..", "src", "windows");
const SWF = path.join(__dirname, "..", "..", "src", "assets", "Action", "GG", "Adult", "happy", "Stand.swf");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${id}${detail ? " -- " + detail : ""}`);
}

function toFileUrl(p) {
  return "file:///" + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

/* 像素统计（与 run.js 同口径） */
function luminanceStats(bitmap) {
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const lum = 0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2];
    sum += lum; sum2 += lum * lum; n++;
  }
  const mean = sum / n;
  return { stddev: Math.sqrt(Math.max(sum2 / n - mean * mean, 0)), mean };
}
function diffStats(b1, b2) {
  let changed = 0;
  const len = Math.min(b1.length, b2.length);
  for (let i = 0; i + 3 < len; i += 4) {
    const d = Math.abs(b1[i] - b2[i]) + Math.abs(b1[i + 1] - b2[i + 1]) + Math.abs(b1[i + 2] - b2[i + 2]) + Math.abs(b1[i + 3] - b2[i + 3]);
    if (d > 24) changed++;
  }
  return changed / (len / 4);
}

async function phaseA() {
  console.log("\n=== A. CSP 下 SWF 播放（webSecurity:false opt-out 窗口同款配置）===");
  const win = new BrowserWindow({
    width: 480, height: 480, show: false, frame: false,
    backgroundColor: "#FF00FF",
    webPreferences: { webSecurity: false, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  // 注意：不要挂 console-message 监听器——Ruffle 的日志对象无法结构化克隆，
  // Electron 转发 console-message 时会抛 "An object could not be cloned"。
  await win.loadFile(path.join(SRC_WINDOWS, "app.html"));
  await sleep(2000); // ruffle wasm 初始化

  // CSP meta 必须真的在文档里
  const hasCsp = await win.webContents.executeJavaScript(
    `!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`
  );
  check("A1 app.html 含 CSP meta", hasCsp);

  // 与主宠窗一致：embed + Ruffle polyfill
  await win.webContents.executeJavaScript(`
    const em = document.createElement("embed");
    em.id = "pet"; em.width = 400; em.height = 400;
    em.src = ${JSON.stringify(toFileUrl(SWF))};
    document.body.appendChild(em);
    true; // executeJavaScript 的返回值要跨进程克隆，最后一条语句不能是 appendChild（返回 DOM 节点会抛克隆错误）
  `);
  await sleep(3000);
  const playerInfo = await win.webContents.executeJavaScript(`
    (() => { const p = document.querySelector("ruffle-embed, ruffle-player"); return { exists: !!p, tag: p ? p.tagName : null }; })()
  `);
  check("A2 embed 被 Ruffle polyfill 接管", playerInfo.exists, playerInfo.tag || "无 ruffle 元素");

  const imgA = await win.webContents.capturePage();
  await sleep(1500); // 采样窗口放宽：隐藏窗 rAF 有抖动，600ms 偶发低于阈值
  const imgB = await win.webContents.capturePage();
  const st = luminanceStats(imgA.getBitmap());
  const changed = diffStats(imgA.getBitmap(), imgB.getBitmap());
  check("A3 SWF 渲染出画面（stddev>8）", st.stddev > 8, `stddev=${st.stddev.toFixed(2)} mean=${st.mean.toFixed(2)}`);
  check("A4 SWF 画面在动（changed>0.5%）", changed > 0.005, `changed=${(changed * 100).toFixed(2)}%`);
  win.destroy();
  return st.stddev > 8;
}

async function phaseB() {
  console.log("\n=== B. 窗口工厂真实代码：webSecurity 默认/ opt-out、导航与新窗防护 ===");
  global.$test = false;
  global.getSys = () => 1;
  const AddWindow = require(path.join(SRC_WINDOWS, "window.js"));
  const wm = new AddWindow();

  await wm.open({ name: "cspGuardTip", loadFile: "popups/tip", default: { width: 320, height: 220, x: 60, y: 60, show: false } });
  const win = wm.wins.cspGuardTip.win;
  await new Promise((r) => win.webContents.once("did-finish-load", r)).catch(() => {});
  await sleep(500);

  const prefs = win.webContents.getLastWebPreferences();
  check("B1 工厂默认 webSecurity:true", prefs && prefs.webSecurity === true, `webSecurity=${prefs && prefs.webSecurity}`);
  // getLastWebPreferences 不回传 preload 路径，改用渲染层 electronAPI 是否存在证明 preload 已挂载
  const hasApi = await win.webContents.executeJavaScript(`!!window.electronAPI`).catch(() => false);
  check("B2 工厂仍挂 preload（渲染层 electronAPI 存在）", hasApi);

  // 顶层导航到 http(s)：必须被 will-navigate 拦下
  const urlBefore = win.webContents.getURL();
  await win.webContents.executeJavaScript(`window.location.href = "https://example.com/"`).catch(() => {});
  await sleep(1000);
  check("B3 拦截顶层导航到 https", win.webContents.getURL() === urlBefore, win.webContents.getURL());

  // 顶层导航到其它 file: 页面：也必须被拦（白名单只有 app.html）
  await win.webContents.executeJavaScript(
    `window.location.href = ${JSON.stringify(toFileUrl(path.join(SRC_WINDOWS, "popups/tip/index.html")))}`
  ).catch(() => {});
  await sleep(1000);
  check("B4 拦截顶层导航到其它 file 页", win.webContents.getURL() === urlBefore, win.webContents.getURL());

  // window.open：deny，不派生新窗口
  const winCount = BrowserWindow.getAllWindows().length;
  await win.webContents.executeJavaScript(`window.open("https://example.com/")`).catch(() => {});
  await sleep(800);
  check("B5 window.open 被 deny", BrowserWindow.getAllWindows().length === winCount,
    `windows ${winCount} -> ${BrowserWindow.getAllWindows().length}`);

  // opt-out：声明 webSecurity:false 的窗口（main/smallGame/fishing/backRoom 同款）生效
  await wm.open({
    name: "cspGuardFishing", loadFile: "popups/fishing",
    webPreferences: { webSecurity: false },
    default: { width: 200, height: 150, x: 80, y: 80, show: false },
  });
  const fw = wm.wins.cspGuardFishing.win;
  const fprefs = fw.webContents.getLastWebPreferences();
  check("B6 opt-out 窗口 webSecurity:false 生效", fprefs && fprefs.webSecurity === false);
  fw.close();
  win.close();
}

async function phaseC() {
  console.log("\n=== C. CSP frame-src + 子框架导航（钓鱼/密室 iframe 形态）===");
  let serverHits = 0;
  const server = http.createServer((req, res) => {
    serverHits++;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><body>pond-ok</body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const win = new BrowserWindow({
    width: 400, height: 300, show: false, frame: false,
    webPreferences: { webSecurity: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(SRC_WINDOWS, "app.html"));
  await sleep(1000);

  let willNavFired = false;
  win.webContents.on("will-navigate", () => { willNavFired = true; });
  await win.webContents.executeJavaScript(`
    window.__pondLoaded = false;
    const f = document.createElement("iframe");
    f.id = "pond"; f.src = "http://127.0.0.1:${port}/windows/popups/fishing/indexOnLine.html";
    f.width = 380; f.height = 280;
    f.onload = () => { window.__pondLoaded = true; };
    document.body.appendChild(f);
    true;
  `);
  // 等 iframe load 事件（最多 8s），同时看本地服务有没有收到请求（区分 CSP 拦截与加载慢）
  let pondLoaded = false;
  for (let i = 0; i < 32 && !pondLoaded; i++) {
    await sleep(250);
    pondLoaded = await win.webContents.executeJavaScript(`!!window.__pondLoaded`);
  }
  const frameText = await win.webContents.executeJavaScript(`
    (() => {
      const f = document.getElementById("pond");
      const w = f.contentWindow;
      if (!w) return "NULL-CW";
      // 钓鱼/密室真实依赖的机制：壳页跨源给 iframe 的 window 注入函数并调用。
      // 注意：本站隔离（site isolation）下该直写在本环境会被 Chromium 拦截（与 CSP 无关，
      // 生产构建删除 disable-site-isolation-trials 后即如此，属既有问题），这里只做观测。
      try {
        w.getPetInfoFromMain = () => "shell-inject-ok";
        return w.getPetInfoFromMain();
      } catch (e) { return "ERR:" + e.message; }
    })()
  `);
  check("C1 http://127.0.0.1 iframe 在 CSP 下正常加载", pondLoaded && serverHits >= 1,
    `loaded=${pondLoaded} serverHits=${serverHits}`);
  console.log(`[INFO] C3 跨源 contentWindow 直写探针（观测项，不计入通过数）: ${frameText}`);
  check("C2 子框架导航不触发 will-navigate（工厂守卫不误伤钓鱼）", !willNavFired);

  server.close();
  win.destroy();
}

async function main() {
  await app.whenReady();
  if (!fs.existsSync(SWF)) {
    console.error("测试 SWF 不存在:", SWF);
    app.exit(1);
  }
  await phaseA();
  await phaseB();
  await phaseC();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} 通过 =====`);
  app.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  app.exit(1);
});
