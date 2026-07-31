/**
 * 钓鱼 SWF 冒烟测试（旧版对照 / 1.2.5 新版虚拟合并）
 * 运行方式:
 *   cd /e/project/qq_local && npx electron test/ruffleSmoke/runFishing.js -- old
 *   cd /e/project/qq_local && npx electron test/ruffleSmoke/runFishing.js -- new
 *
 * 流程：起本机 http 静态服务（模拟 src/ini/root.js 的 express），
 * old 模式根目录 = src/windows/popups/fishing（生产现状）；
 * new 模式把 main.swf 和 res/** 映射到 src/assets/fishing（1.2.5 素材），
 * 其余（config.xml、Yahei.swf）仍取 popups/fishing —— 即“换 SWF+res、保留现有 config”的方案A布局。
 * 隐藏 BrowserWindow 加载 fishingPlayer.html（复刻 indexOnLine.html 的 embed + ExternalInterface 钩子），
 * 等 SWF 暴露出 PETEventOnReceived 后推送 cmd:1 池塘数据，截图×2 做像素判定，
 * 输出 HTTP 请求日志（含 404）、SWF→JS 调用日志，写 reportFishing_<mode>.json。
 */
const { app, BrowserWindow } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

app.setName("ruffle-fishing-smoke");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "ruffle-fish-")));
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const HERE = __dirname;
const SHOTS = path.join(HERE, "shots");
const POP = path.resolve(HERE, "../../src/windows/popups/fishing");
const NEWBASE = path.resolve(HERE, "../../src/assets/fishing");
const MODE = process.argv.includes("new") ? "new" : "old";

const MIME = {
  ".swf": "application/x-shockwave-flash",
  ".xml": "text/xml; charset=utf-8",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const reqLog = [];

function resolveFile(urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "");
  if (p === "" || p === "fishingPlayer.html") return path.join(HERE, "fishingPlayer.html");
  // 测试页引用的项目内绝对路径（ruffle.js 等）
  if (p.startsWith("src/")) return path.resolve(HERE, "../..", p);
  if (MODE === "new") {
    // 方案A布局：popups/fishing/main.swf 换成 1.2.5 版；
    // 1.2.5 SWF 硬编码 pet\fishing\ 前缀，故在 fishing 目录内嵌套 pet/fishing/ 子树
    if (p === "main.swf") return path.join(NEWBASE, "main.swf");
    if (p.startsWith("pet/fishing/")) return path.join(NEWBASE, p.slice("pet/fishing/".length));
    return path.join(POP, p);
  }
  return path.join(POP, p);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function luminanceStats(bitmap) {
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const lum = 0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2];
    sum += lum; sum2 += lum * lum; n++;
  }
  const mean = sum / n;
  return { mean, stddev: Math.sqrt(Math.max(sum2 / n - mean * mean, 0)) };
}

function diffStats(b1, b2) {
  let changed = 0, n = 0;
  const len = Math.min(b1.length, b2.length);
  for (let i = 0; i + 3 < len; i += 4) {
    const d = Math.abs(b1[i] - b2[i]) + Math.abs(b1[i + 1] - b2[i + 1]) +
      Math.abs(b1[i + 2] - b2[i + 2]) + Math.abs(b1[i + 3] - b2[i + 3]);
    if (d > 24) changed++;
    n++;
  }
  return { changedRatio: changed / n };
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = http.createServer((req, res) => {
    const file = resolveFile(req.url);
    let status = 200;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    } else {
      status = 404;
      res.writeHead(404);
      res.end("not found");
    }
    reqLog.push({ url: req.url, status, file: status === 404 ? undefined : path.relative(path.resolve(HERE, "../.."), file) });
    console.log(`[http:${status}] ${req.url}`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  console.log(`mode=${MODE} server at http://127.0.0.1:${port}/`);

  const win = new BrowserWindow({
    width: 380,
    height: 300,
    show: false,
    frame: false,
    backgroundColor: "#FF00FF",
    webPreferences: { webSecurity: false, backgroundThrottling: false },
  });
  win.webContents.on("console-message", (e, level, msg) => {
    if (!/ruffle|Ruffle/.test(msg) || /ERROR|error|WARN/.test(msg)) {
      console.log(`[renderer:${level}] ${msg.slice(0, 300)}`);
    }
  });

  const report = { mode: MODE, port, reqLog, checks: {} };

  await win.loadURL(`http://127.0.0.1:${port}/fishingPlayer.html`);
  await sleep(4000); // 等 ruffle wasm 初始化 + SWF 加载

  // 1) SWF 是否暴露出 ExternalInterface 回调 PETEventOnReceived
  let eiReady = false;
  for (let i = 0; i < 20 && !eiReady; i++) {
    eiReady = await win.webContents.executeJavaScript(
      "!!(document.getElementById('hlyg') && typeof document.getElementById('hlyg').PETEventOnReceived === 'function')"
    );
    if (!eiReady) await sleep(500);
  }
  report.checks.eiReady = eiReady;
  console.log(`PETEventOnReceived 暴露: ${eiReady}`);

  // 2) 推送 cmd:1 池塘数据（模拟 indexOnLine.js setPetInfo）
  if (eiReady) {
    const pushed = await win.webContents.executeJavaScript("window.__pushPond()");
    report.checks.pushed = pushed;
    console.log(`cmd:1 推送: ${pushed}`);
  }
  await sleep(3000);

  // 3) 截图 + 像素判定
  const imgA = await win.webContents.capturePage();
  await sleep(500);
  const imgB = await win.webContents.capturePage();
  const shotA = path.join(SHOTS, `fishing_${MODE}_a.png`);
  const shotB = path.join(SHOTS, `fishing_${MODE}_b.png`);
  fs.writeFileSync(shotA, imgA.toPNG());
  fs.writeFileSync(shotB, imgB.toPNG());
  const st = luminanceStats(imgA.getBitmap());
  const df = diffStats(imgA.getBitmap(), imgB.getBitmap());
  report.checks.pixels = {
    stddev: +st.stddev.toFixed(2),
    mean: +st.mean.toFixed(2),
    changedRatio: +(df.changedRatio * 100).toFixed(2) + "%",
  };
  report.checks.rendered = st.stddev > 8;
  report.checks.moving = df.changedRatio > 0.005;
  console.log(`pixels: stddev=${report.checks.pixels.stddev} changed=${report.checks.pixels.changedRatio} => rendered=${report.checks.rendered} moving=${report.checks.moving}`);

  // 4) SWF -> JS 调用日志
  report.fishLog = await win.webContents.executeJavaScript("window.__fishLog || []");
  console.log(`SWF->JS 调用 ${report.fishLog.length} 条:`);
  for (const l of report.fishLog.slice(0, 20)) console.log(`  ${l.kind}: ${l.data.slice(0, 160)}`);

  // 5) 404 汇总
  const notFound = reqLog.filter((r) => r.status === 404);
  console.log(`\nHTTP 请求 ${reqLog.length} 条，404 ${notFound.length} 条`);
  for (const r of notFound) console.log(`  [404] ${r.url}`);

  const reportPath = path.join(HERE, `reportFishing_${MODE}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`报告: ${reportPath}`);

  win.destroy();
  server.close();
  app.quit();
}

setTimeout(() => { console.error("整体超时，强制退出"); app.exit(2); }, 90000);

main().catch((e) => {
  console.error("FATAL", e);
  app.exit(1);
});
