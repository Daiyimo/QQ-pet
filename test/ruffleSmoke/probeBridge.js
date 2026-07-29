/**
 * probeBridge.js —— 用真实 Ruffle 验证 ruffleBridge 的 API 事实与 finish 触发时机
 *
 * 目的（对应 P0 bug「关闭桌宠必卡 30 秒」）：
 *   1. 实测 Flash 老接口（IsPlaying/CurrentFrame/TotalFrames/GotoFrame/StopPlay/Rewind/PercentLoaded）
 *      在当前 Ruffle 元素上到底存不存在；
 *   2. 实测 metadata 字段（numFrames/frameRate 等）与 loadedmetadata 事件；
 *   3. 加载真实退出动画 SWF，按 24fps 驱动 window.RuffleBridge，
 *      记录 swfPet.js 的 finish 判定（总帧 == 当前帧 + lastTimeCut + 1）首次成立的耗时。
 *
 * 运行：cd /e/project/qq_local && npx electron test/ruffleSmoke/probeBridge.js
 *      （可选：-- <swf路径>，默认 src/assets/Action/GG/Adult/Exit1.swf）
 *
 * 该脚本只读，不写任何文件；结果打印到 stdout（JSON）。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

app.setName("ruffle-bridge-probe");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "ruffle-bridge-probe-")));

const ROOT = path.join(__dirname, "../..");
const APP_HTML = path.join(ROOT, "src/windows/app.html");

const dashIdx = process.argv.indexOf("--");
const args = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : [];
const swfPath = args[0] && args[0] !== "--show" ? path.resolve(args[0]) : path.join(ROOT, "src/assets/Action/GG/Adult/Exit1.swf");
/** 是否显示窗口：隐藏窗口下 Chromium 会把 requestAnimationFrame 降到约 1fps（最坏情况） */
const SHOW_WINDOW = args.includes("--show");

function toFileUrl(p) {
    return "file:///" + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

async function main() {
    await app.whenReady();
    if (!fs.existsSync(swfPath)) {
        console.error("SWF 不存在:", swfPath);
        app.exit(2);
        return;
    }
    const win = new BrowserWindow({
        width: 200, height: 200, show: SHOW_WINDOW, frame: false,
        backgroundColor: "#FF00FF",
        webPreferences: { webSecurity: false, backgroundThrottling: false },
    });
    win.webContents.on("console-message", (_e, _lv, msg) => console.log("[renderer]", msg));
    await win.loadFile(APP_HTML);

    const result = await win.webContents.executeJavaScript(`(async () => {
        const out = { bridgeLoaded: typeof window.RuffleBridge === "function" };
        // 与 swfPet.js changeSwf 一致：<embed type=application/x-shockwave-flash>，靠 Ruffle polyfill 接管
        const el = document.createElement("embed");
        el.setAttribute("id", "probePet");
        el.setAttribute("name", "pet");
        el.setAttribute("wmode", "transparent");
        el.setAttribute("allowScriptAccess", "always");
        el.setAttribute("type", "application/x-shockwave-flash");
        el.setAttribute("src", ${JSON.stringify(toFileUrl(swfPath))});
        el.style.width = "140px"; el.style.height = "140px";
        document.body.appendChild(el);
        await new Promise((r) => setTimeout(r, 1200));
        const dom = document.getElementById("probePet");
        out.tagName = dom && dom.tagName;
        // 1) 老 Flash 大驼峰接口存在性
        out.legacyApi = {};
        for (const k of ["IsPlaying","CurrentFrame","TotalFrames","PercentLoaded","Play","StopPlay","Rewind","GotoFrame"]) {
            out.legacyApi[k] = dom ? typeof dom[k] : "no-dom";
        }
        // 2) Ruffle 真实 API
        out.modernApi = {};
        for (const k of ["play","pause","reload","load","isPlaying","metadata","readyState","PercentLoaded"]) {
            out.modernApi[k] = dom ? typeof dom[k] : "no-dom";
        }
        try { out.metadata = dom.metadata ? JSON.parse(JSON.stringify(dom.metadata)) : null; } catch (e) { out.metadata = "throw: " + e; }
        try { out.isPlaying = dom.isPlaying; } catch (e) { out.isPlaying = "throw: " + e; }
        try { out.percentLoaded = dom.PercentLoaded(); } catch (e) { out.percentLoaded = "throw: " + e; }

        // 3) 用 bridge + 24fps 轮询复刻 swfPet 的 finish 判定
        const bridge = new window.RuffleBridge();
        bridge.setDom(dom);
        const LAST_TIME_CUT = 1;
        const t0 = performance.now();
        out.finishAtMs = null; out.samples = 0; out.frameSeq = [];
        await new Promise((resolve) => {
            let last = t0;
            const step = () => {
                const now = performance.now();
                if (now - last >= 1000 / 24) {
                    last = now;
                    const st = bridge.getState();
                    out.samples++;
                    if (out.frameSeq.length < 12) out.frameSeq.push(st.currentFrame);
                    if (out.finishAtMs === null && st.frame === st.currentFrame + LAST_TIME_CUT + 1) {
                        out.finishAtMs = Math.round(now - t0);
                        out.finishState = st;
                        return resolve();
                    }
                }
                if (now - t0 > 30000) { out.timeout = true; return resolve(); }
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        });
        out.totalFrames = bridge.totalFrames();
        out.fallbackTimeline = bridge.isFallbackTimeline();
        return out;
    })()`);

    console.log("=== 阶段1：Ruffle API 事实 + bridge 帧驱动 ===");
    console.log(JSON.stringify(result, null, 2));

    // 阶段2：把真实 swfPet.js 注入同一页面（等价 window.js 的 jsFiles 注入），
    // 走完整链路 changeSwf("exit", {finish}) → 验证 finish 回调真的被调用。
    const swfPetSrc = fs.readFileSync(path.join(ROOT, "src/windows/util/pet/swfPet.js")).toString();
    await win.webContents.executeJavaScript(swfPetSrc);
    const phase2 = await win.webContents.executeJavaScript(`(async () => {
        const out = { swfPetLoaded: typeof window.swfPet === "function" };
        document.body.innerHTML = "";
        const el = document.createElement("embed");
        el.setAttribute("id", "pet");
        el.setAttribute("type", "application/x-shockwave-flash");
        el.setAttribute("src", "../assets/Action/GG/Adult/happy/Stand.swf");
        el.style.width = "140px"; el.style.height = "140px";
        document.body.appendChild(el);
        await new Promise((r) => setTimeout(r, 800));
        const pet = new window.swfPet({ id: "pet", backFn: () => {}, goNormal: () => "normal" });
        pet.init({
            baseRouter: "../assets/Action",
            state: {
                info: { sex: "GG", age: 10, growth: 5, mood: 950, health: 10, lastX: 0, lastY: 0 },
                maxInfo: { level: 10 },
            },
        });
        await new Promise((r) => setTimeout(r, 1500));
        const t0 = performance.now();
        out.finishCalled = false;
        await new Promise((resolve) => {
            let done = false;
            pet.changeSwf("exit", {
                load: () => { out.loadCalled = true; },
                finish: () => {
                    out.finishCalled = true;
                    out.finishAtMs = Math.round(performance.now() - t0);
                    if (!done) { done = true; resolve(); }
                },
            });
            // 30s 是 main/main.js 的硬兜底，超过即等于"没修好"
            setTimeout(() => { if (!done) { done = true; out.timeout = true; resolve(); } }, 30000);
        });
        try { out.watcherState = JSON.parse(JSON.stringify(pet.state.state)); } catch (e) { out.watcherState = String(e); }
        return out;
    })()`);
    console.log("=== 阶段2：swfPet.js 全链路 finish 回调 ===");
    console.log(JSON.stringify(phase2, null, 2));

    win.destroy();
    app.exit(result && result.finishAtMs !== null && phase2 && phase2.finishCalled ? 0 : 1);
}

main().catch((e) => {
    console.error("probe 失败:", e);
    app.exit(3);
});
