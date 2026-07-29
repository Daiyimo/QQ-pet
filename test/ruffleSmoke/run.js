/**
 * Ruffle 播放冒烟测试（一次性验证脚本）
 * 运行方式: cd /e/project/qq_local && npx electron test/ruffleSmoke/run.js
 *
 * 流程：隐藏 BrowserWindow 加载 player.html（内置 ruffle.js），依次加载测试 SWF，
 * 每个等 2.5s 截图 A，再隔 500ms 截图 B，像素分析判定 渲染/动，截图存 shots/。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const os = require("os");

// 独立 userData，避免与正在运行的 qq_local 实例冲突（也不申请单实例锁）
app.setName("ruffle-smoke-test");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "ruffle-smoke-")));
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const HERE = __dirname;
const SHOTS = path.join(HERE, "shots");
const NEW_BASE = "E:/project/QQ_NEW_SWF/点击/Action/10200003/1020000001";

const TESTS = [
    { id: "1_new_stand_normal_001_AS3", file: `${NEW_BASE}/main/stand/normal/001.swf`, expect: "AS3" },
    { id: "2_new_play_001_AS3", file: `${NEW_BASE}/main/play/001.swf`, expect: "AS3" },
    { id: "3_new_walk_left_AVM1_ctrl", file: `${NEW_BASE}/main/walk/walk_left.swf`, expect: "AVM1 对照组" },
    { id: "4_old_happy_Stand_ctrl", file: "E:/project/qq_local/src/assets/Action/GG/Adult/happy/Stand.swf", expect: "老素材对照组" },
    { id: "5_new_main_shell_AS3", file: `${NEW_BASE}/main.swf`, expect: "AS3 壳（观察）" },
];

function toFileUrl(p) {
    return "file:///" + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- SWF 头解析：签名/版本/RECT 尺寸/帧率/帧数/DoABC ---------- */
function parseSwfHeader(file) {
    let buf = fs.readFileSync(file);
    const sig = buf.toString("latin1", 0, 3);
    const version = buf[3];
    if (sig === "CWS") {
        buf = Buffer.concat([buf.subarray(0, 8), zlib.inflateSync(buf.subarray(8))]);
    } else if (sig !== "FWS") {
        return { sig, version, error: `不支持的压缩格式 ${sig}` };
    }
    let pos = 8;
    const nbits = buf[pos] >> 3;
    const rectBytes = Math.ceil((5 + 4 * nbits) / 8);
    const rect = buf.subarray(pos, pos + rectBytes);
    let bitPos = 5;
    const readBits = (n) => {
        let v = 0;
        for (let i = 0; i < n; i++) {
            const byte = rect[(bitPos >> 3)];
            const bit = (byte >> (7 - (bitPos & 7))) & 1;
            v = (v << 1) | bit;
            bitPos++;
        }
        // 符号扩展（RECT 坐标为带符号）
        if (v & (1 << (n - 1))) v -= 1 << n;
        return v;
    };
    const xMin = readBits(nbits), xMax = readBits(nbits), yMin = readBits(nbits), yMax = readBits(nbits);
    const width = (xMax - xMin) / 20, height = (yMax - yMin) / 20;
    pos += rectBytes;
    const frameRate = buf.readUInt16LE(pos) / 256; pos += 2;
    const frameCount = buf.readUInt16LE(pos); pos += 2;
    let doABC = false, doABCdefine = false, hasAS12Action = false, tagCount = 0;
    while (pos + 2 <= buf.length) {
        const h = buf.readUInt16LE(pos); pos += 2;
        const type = h >> 6;
        let len = h & 0x3f;
        if (len === 0x3f) { if (pos + 4 > buf.length) break; len = buf.readUInt32LE(pos); pos += 4; }
        if (type === 0 || len < 0) break;
        if (type === 82) doABC = true;
        if (type === 72) doABCdefine = true;
        if (type === 12 || type === 59) hasAS12Action = true; // DoAction / DoInitAction
        pos += len; tagCount++;
        if (pos > buf.length) break;
    }
    return { sig, version, width, height, frameRate, frameCount, doABC: doABC || doABCdefine, hasAS12Action, tagCount };
}

/* ---------- 像素分析（NativeImage BGRA bitmap） ---------- */
function luminanceStats(bitmap) {
    let sum = 0, sum2 = 0, n = 0;
    let sumA = 0;
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
        const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2], a = bitmap[i + 3];
        const lum = 0.114 * b + 0.587 * g + 0.299 * r;
        sum += lum; sum2 += lum * lum; sumA += a; n++;
    }
    const mean = sum / n;
    const variance = sum2 / n - mean * mean;
    return { mean, stddev: Math.sqrt(Math.max(variance, 0)), meanAlpha: sumA / n, pixels: n };
}

function diffStats(b1, b2) {
    let changed = 0, n = 0;
    const len = Math.min(b1.length, b2.length);
    for (let i = 0; i + 3 < len; i += 4) {
        const d = Math.abs(b1[i] - b2[i]) + Math.abs(b1[i + 1] - b2[i + 1]) + Math.abs(b1[i + 2] - b2[i + 2]) + Math.abs(b1[i + 3] - b2[i + 3]);
        if (d > 24) changed++;
        n++;
    }
    return { changedRatio: changed / n };
}

async function main() {
    await app.whenReady();
    fs.mkdirSync(SHOTS, { recursive: true });

    const win = new BrowserWindow({
        width: 480,
        height: 480,
        show: false,
        frame: false,
        backgroundColor: "#FF00FF", // 品红底：未渲染时整屏品红，方差≈0
        webPreferences: {
            webSecurity: false,            // 与项目 src/windows/window.js 一致，允许 file:// 加载
            backgroundThrottling: false,
        },
    });

    win.webContents.on("console-message", (e, level, msg) => {
        console.log(`[renderer:${level}] ${msg}`);
    });

    await win.loadFile(path.join(HERE, "player.html"));
    await sleep(1500); // 等 ruffle wasm 初始化

    const results = [];

    for (const t of TESTS) {
        const r = { id: t.id, file: t.file, expect: t.expect };
        console.log(`\n=== ${t.id} ===`);
        if (!fs.existsSync(t.file)) {
            r.error = "文件不存在";
            results.push(r);
            console.log("  文件不存在，跳过");
            continue;
        }
        // 1) SWF 头解析
        try {
            r.swfHeader = parseSwfHeader(t.file);
            console.log(`  header: ${r.swfHeader.sig} v${r.swfHeader.version} ${r.swfHeader.width}x${r.swfHeader.height} ` +
                `${r.swfHeader.frameRate}fps ${r.swfHeader.frameCount}帧 doABC=${r.swfHeader.doABC}`);
        } catch (e) {
            r.swfHeader = { error: String(e) };
        }
        // 2) Ruffle 加载
        const url = toFileUrl(t.file);
        let loadRes;
        try {
            loadRes = await win.webContents.executeJavaScript(`window.loadSwf(${JSON.stringify(url)})`);
        } catch (e) {
            loadRes = { ok: false, error: String(e) };
        }
        r.load = loadRes;
        console.log(`  load: ${JSON.stringify(loadRes)}`);

        await sleep(2500);
        const imgA = await win.webContents.capturePage();
        await sleep(500);
        const imgB = await win.webContents.capturePage();

        const shotA = path.join(SHOTS, `${t.id}_a.png`);
        const shotB = path.join(SHOTS, `${t.id}_b.png`);
        fs.writeFileSync(shotA, imgA.toPNG());
        fs.writeFileSync(shotB, imgB.toPNG());
        r.shots = [shotA, shotB];

        const bmpA = imgA.getBitmap(), bmpB = imgB.getBitmap();
        const st = luminanceStats(bmpA);
        const df = diffStats(bmpA, bmpB);
        r.pixels = { stddev: +st.stddev.toFixed(2), mean: +st.mean.toFixed(2), meanAlpha: +st.meanAlpha.toFixed(1), changedRatio: +(df.changedRatio * 100).toFixed(2) + "%" };

        // 判定：stddev>8 认为画面有内容（渲染成功）；两帧变化像素>0.5% 认为在动
        r.rendered = st.stddev > 8;
        r.moving = df.changedRatio > 0.005;
        console.log(`  pixels: stddev=${r.pixels.stddev} mean=${r.pixels.mean} alpha=${r.pixels.meanAlpha} changed=${r.pixels.changedRatio}`);
        console.log(`  => rendered=${r.rendered} moving=${r.moving}`);

        await win.webContents.executeJavaScript("window.unloadSwf()");
        results.push(r);
    }

    const reportPath = path.join(HERE, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log(`\n报告已写入: ${reportPath}`);
    console.log("\n===== 汇总 =====");
    for (const r of results) {
        console.log(`${r.rendered ? "[渲染]" : "[未渲染]"} ${r.moving ? "[动]" : "[静]"} ${r.id} ` +
            (r.swfHeader && r.swfHeader.width ? `(${r.swfHeader.width}x${r.swfHeader.height})` : "") +
            (r.error || (r.load && !r.load.ok ? " loadError=" + r.load.error : "")));
    }

    win.destroy();
    app.quit();
}

main().catch((e) => {
    console.error("FATAL", e);
    app.exit(1);
});
