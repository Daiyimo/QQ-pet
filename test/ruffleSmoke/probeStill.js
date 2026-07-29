/**
 * 复测脚本：针对"渲染成功但疑似静止"的 SWF 做长时间、低阈值观测。
 * 运行: cd /e/project/qq_local && npx electron test/ruffleSmoke/probeStill.js -- <swf路径> [观测秒数]
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

app.setName("ruffle-smoke-probe");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "ruffle-probe-")));

const HERE = __dirname;
const SHOTS = path.join(HERE, "shots");

const dashIdx = process.argv.indexOf("--");
const args = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : process.argv.slice(2);
const swfPath = args[0];
const seconds = Number(args[1]) || 5;
if (!swfPath || !fs.existsSync(swfPath)) {
    console.error("用法: npx electron test/ruffleSmoke/probeStill.js -- <swf路径> [观测秒数]");
    console.error("收到:", JSON.stringify(args));
    process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toFileUrl(p) {
    return "file:///" + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

function diffAtThreshold(b1, b2, th) {
    let changed = 0, n = 0;
    const len = Math.min(b1.length, b2.length);
    for (let i = 0; i + 3 < len; i += 4) {
        const d = Math.abs(b1[i] - b2[i]) + Math.abs(b1[i + 1] - b2[i + 1]) + Math.abs(b1[i + 2] - b2[i + 2]) + Math.abs(b1[i + 3] - b2[i + 3]);
        if (d > th) changed++;
        n++;
    }
    return changed / n;
}

async function main() {
    await app.whenReady();
    fs.mkdirSync(SHOTS, { recursive: true });
    const win = new BrowserWindow({
        width: 480, height: 480, show: false, frame: false,
        backgroundColor: "#FF00FF",
        webPreferences: { webSecurity: false, backgroundThrottling: false },
    });
    win.webContents.on("console-message", (e, l, m) => console.log(`[renderer] ${m}`));
    await win.loadFile(path.join(HERE, "player.html"));
    await sleep(1500);

    const url = toFileUrl(swfPath);
    console.log("probe:", swfPath, `${seconds}s`);
    const loadRes = await win.webContents.executeJavaScript(`window.loadSwf(${JSON.stringify(url)})`);
    console.log("load:", JSON.stringify(loadRes));

    const frames = [];
    const total = Math.max(2, Math.round(seconds * 2)); // 每 500ms 一帧
    for (let i = 0; i < total; i++) {
        await sleep(500);
        const img = await win.webContents.capturePage();
        frames.push(img.getBitmap());
        if (i === 0) fs.writeFileSync(path.join(SHOTS, "probe_a.png"), img.toPNG());
        if (i === total - 1) fs.writeFileSync(path.join(SHOTS, "probe_last.png"), img.toPNG());
    }
    for (let i = 1; i < frames.length; i++) {
        console.log(`frame${i - 1}->${i}: ` +
            `th6=${(diffAtThreshold(frames[i - 1], frames[i], 6) * 100).toFixed(3)}% ` +
            `th24=${(diffAtThreshold(frames[i - 1], frames[i], 24) * 100).toFixed(3)}%`);
    }
    win.destroy();
    app.quit();
}

main().catch((e) => { console.error("FATAL", e); app.exit(1); });
