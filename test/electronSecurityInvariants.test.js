/**
 * Electron 安全不变量的静态锚（纯 node，不需要 Electron，不依赖真实素材，平台无关）。
 *
 * 背景：两轮安全加固（窗口 webPreferences 收紧、app.html 的 CSP meta、导航/新窗守卫、
 * 移除子框架 Node 集成的 RCE 面）此前**零自动化覆盖**——唯一验证它们的
 * test/ruffleSmoke/runCspGuard.js 需要真 Electron 与真实 SWF，刻意不被 `npm test` 的
 * glob 收录。也就是说：把 `nodeIntegration:!0` 写回 window.js、删掉 CSP meta、
 * 恢复 nodeIntegrationInSubFrames，整套测试仍会全绿。本文件就是补这个洞。
 *
 * 被测源码是 webpack 压缩单行产物（window.js / 各 main.js 的 `wc -l` 为 0~1，无 sourcemap），
 * 主进程代码又无法在纯 node 里 require（`eval("require")("electron")` 会炸），
 * 因此这里只能做**源码文本断言**——手法与 test/pinkDiamond125.test.js、
 * test/fishingBalance.test.js 的「压缩区接入点」断言一致。
 *
 * 设计原则（这些断言会长期跑在 CI/pre-commit 上，一条误伤的断言比没有断言更糟）：
 *   1. 能用集合等值就不用 `>= N`——「第 5 个窗口偷偷 opt-out」必须红。
 *   2. 不断言键的顺序、不断言整条 CSP 字符串、不断言与安全无关的相邻代码，
 *      正常重构（改窗口尺寸、加一个 CSP 白名单主机、重排 webPreferences 的键）不许触发。
 *   3. 断言失败的信息要写清「怎么修」——本文件的读者是三个月后想改窗口配置的人。
 *
 * 变异自证入口：QQ_SEC_SRC_ROOT=<目录>。该目录被当作仓库根的**覆盖层**：
 * 存在 `<目录>/src/windows/window.js` 就读它，否则回落到真实仓库文件；
 * 目录里多出来的文件也会参与目录扫描（可模拟「新增第 5 个 opt-out 窗口」）。
 * 用法与 test/storeBagCache.test.js 的 QQ_STORE_SRC 同源：把改坏的副本写进临时目录，
 *   QQ_SEC_SRC_ROOT=/tmp/mut node --test test/electronSecurityInvariants.test.js
 * 即可验证这些用例真的会红——无需改动仓库里的 src/。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
/* 变异自证用的覆盖层根目录，见文件头注释。生产/CI 下为空。 */
const OVERRIDE_ROOT = process.env.QQ_SEC_SRC_ROOT || "";

// ---------------------------------------------------------------------------
// 预期常量（全部来自对当前源码的实测，不是抄文档）
// ---------------------------------------------------------------------------

/** 窗口工厂。所有走 loadFile(app.html) 的本地壳窗都由它统一注入 webPreferences 与守卫。 */
const WINDOW_FACTORY = "src/windows/window.js";

/** 所有壳窗共用的页面。CSP meta 落在这里。 */
const APP_HTML = "src/windows/app.html";

/** 加载「用户输入的任意网址」的远程子窗，隔离要求最高。 */
const URL_WINDOW = "src/windows/tool/urlWindow/main.js";

/** 不走工厂、直接 new BrowserWindow 的弹幕覆盖层（需要 screen-saver 置顶层级）。 */
const BARRAGE = "src/windows/barrage/main.js";

/** 弹幕覆盖层的页面。它是全仓唯一一个**不含任何 unsafe- 的严格 CSP**，值得单独钉住。 */
const BARRAGE_HTML = "src/windows/barrage/index.html";

/**
 * `webSecurity:false` 的 opt-out 白名单——**必须恰好是这 4 个窗口**。
 * 理由（源码注释里也各自登记了）：
 *   - main（主宠窗）/ smallGame：Ruffle 要 fetch 本地 SWF，file:// 页面在 webSecurity:true 下子资源请求被拦；
 *   - fishing / backRoom：file:// 壳要跨源直写 http://127.0.0.1 iframe 的 contentWindow。
 * 新增 opt-out 会让该窗口失去同源策略保护，请在此清单登记并说明理由，同时跑
 * test/ruffleSmoke/ 的冒烟确认真的必要（README「已知问题」里怀疑 fishing/backRoom
 * 这两条在 Electron 28 下已无实际作用，可能应当移除而非扩大）。
 */
const WEB_SECURITY_OPT_OUT = [
  "src/windows/main/main.js",
  "src/windows/popups/backRoom/main.js",
  "src/windows/popups/fishing/main.js",
  "src/windows/popups/smallGame/main.js",
];

/** 允许 new BrowserWindow 的位置——每新增一处都必须单独审查 webPreferences。 */
const BROWSER_WINDOW_CREATORS = [WINDOW_FACTORY, BARRAGE, URL_WINDOW];

/**
 * 危险开关：全仓（第一方代码）零命中。
 * nodeIntegrationInSubFrames 不在此列——它在 urlWindow 里被显式写成 false，
 * 单独用「不许为真」的断言覆盖（见对应用例）。
 */
const FORBIDDEN_TOKENS = [
  "enableRemoteModule", // 早已废弃的 remote 模块，等于把主进程 API 递给渲染层
  "allowRunningInsecureContent", // 允许 https 页面加载 http 子资源
  "webviewTag", // <webview> 是额外的、难以收紧的攻击面
  "--disable-web-security", // 命令行整体关闭同源策略
  "disable-site-isolation-trials", // 二轮已移除：曾用于放行跨源 contentWindow 直写
  "--no-sandbox", // 关掉渲染进程沙箱
  "child_process", // 桌宠不需要拉子进程；一旦引入即是命令注入面
];

/**
 * 第三方浏览器端 bundle：Vue / Ant Design / Ruffle。
 * 它们含 `new Function`（Vue 模板编译、Ruffle wasm glue）属正常，且升级第三方
 * 不该让本文件变红，故所有文本扫描都跳过这两个目录。
 * 代价：不覆盖供应链风险——那超出「防回归锚」的职责范围。
 */
const VENDOR_DIRS = ["src/windows/lib/", "src/windows/js/ruffle/"];

/** app.html 里 CSP 必须仍然存在的指令（实测当前值，缺一条即为收紧被推翻）。 */
const CSP_REQUIRED_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "frame-src",
  "worker-src",
  "object-src",
  "media-src",
  "base-uri",
  "form-action",
];

/**
 * 当前**有意保留**的 `unsafe-` 放行，格式 `<指令> <关键字>`。
 * 用集合等值而不是「不许出现 unsafe-」，因为下面这几条是刻意留的：
 *   - script-src 'unsafe-eval'：vue.global.js 运行时编译模板 + executeJavaScript 注入；
 *   - script-src 'wasm-unsafe-eval'：Ruffle 的 WebAssembly；
 *   - script-src 'unsafe-inline'：app.html 里的 RufflePlayer.config 内联脚本；
 *   - style-src 'unsafe-inline'：大量 :style 绑定与 insertCSS。
 * 将来任何人再加一个新的 unsafe-（尤其加到别的指令上）都会让本用例变红。
 */
const CSP_ALLOWED_UNSAFE = [
  "script-src 'unsafe-eval'",
  "script-src 'unsafe-inline'",
  "script-src 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
];

// ---------------------------------------------------------------------------
// 源码读取（带覆盖层）与文本工具
// ---------------------------------------------------------------------------

/** rel 一律用 `/` 分隔的仓库相对路径。 */
function resolveSource(rel) {
  if (OVERRIDE_ROOT) {
    const overridden = path.join(OVERRIDE_ROOT, rel);
    if (fs.existsSync(overridden)) return overridden;
  }
  return path.join(REPO_ROOT, rel);
}

function readSource(rel) {
  return fs.readFileSync(resolveSource(rel), "utf8");
}

function walk(absDir, onFile) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) walk(abs, onFile);
    else onFile(abs);
  }
}

/** 列出 relDir 下所有指定后缀的仓库相对路径（含覆盖层里多出来的文件），跳过 VENDOR_DIRS。 */
function listSources(relDir, exts) {
  const rels = new Set();
  const roots = OVERRIDE_ROOT ? [REPO_ROOT, OVERRIDE_ROOT] : [REPO_ROOT];
  for (const root of roots) {
    const base = path.join(root, relDir);
    if (!fs.existsSync(base)) continue;
    walk(base, (abs) => {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (!exts.some((e) => rel.endsWith(e))) return;
      if (VENDOR_DIRS.some((d) => rel.startsWith(d))) return;
      rels.add(rel);
    });
  }
  return [...rels].sort();
}

/**
 * 去注释。压缩产物里的说明性 `/* ... *\/` 注释会复述 `webPreferences:{webSecurity:!1}`
 * 这类文本（window.js 与 app.html 都有），不去掉就会把注释误判成真实配置。
 *
 * 行注释的处理刻意保守：只在 `//` 前一个字符不是 `:`/单词字符/引号/反斜杠时才剥离，
 * 这样 `http://`、`file://` 之类不会被误砍。极端情况下（字符串里出现裸 `//`）
 * 会多砍掉一行代码——宁可漏一条（假阴性）也不要凭注释里的散文变红（假阳性）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\w"'`\\])\/\/[^\n]*/g, "$1");
}

const BOOL_LITERALS = { "!0": true, "!1": false, true: true, false: false };

/** 从 src 中 openBraceIdx 处的 `{` 起，按括号配对取出对象字面量文本（含两端花括号）。 */
function extractBraceBlock(src, openBraceIdx, where) {
  assert.equal(
    src[openBraceIdx],
    "{",
    `${where}: 期望在偏移 ${openBraceIdx} 处找到对象字面量的 '{'，源码结构已变，请更新本测试的定位方式`
  );
  let depth = 0;
  for (let i = openBraceIdx; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(openBraceIdx, i + 1);
    }
  }
  assert.fail(`${where}: 对象字面量花括号未配对，无法解析`);
}

/**
 * 从对象字面量文本里读一个布尔开关。压缩产物写作 `!0`/`!1`，未压缩的写 `true`/`false`。
 * 要求该键在该字面量里恰好被赋值一次——出现多次说明结构变了，宁可报错也不要猜。
 */
function readBooleanFlag(objText, key, where) {
  const hits = [
    ...objText.matchAll(
      new RegExp(`[{,]\\s*${key}\\s*:\\s*(!0|!1|true|false)\\s*(?=[,}])`, "g")
    ),
  ];
  assert.equal(
    hits.length,
    1,
    `${where}: 期望 ${key} 被显式赋一次布尔值，实测 ${hits.length} 次。` +
      `若确实改了写法（如换成变量/三元），请同步更新本测试，不要直接删断言——` +
      `这条断言存在的意义就是让该开关的任何变动都必须被人看到。`
  );
  return BOOL_LITERALS[hits[0][1]];
}

/** 取出 window.js 里 defaultOption 的 webPreferences 字面量文本。 */
function defaultWebPreferences() {
  const src = stripComments(readSource(WINDOW_FACTORY));
  const anchor = src.indexOf("defaultOption={");
  assert.notEqual(
    anchor,
    -1,
    `${WINDOW_FACTORY}: 找不到 defaultOption 对象。所有壳窗的安全默认值都从这里来，` +
      `若已重命名请同步本测试的锚点常量。`
  );
  const optionText = extractBraceBlock(
    src,
    src.indexOf("{", anchor),
    `${WINDOW_FACTORY} defaultOption`
  );
  const wpAt = optionText.indexOf("webPreferences:");
  assert.notEqual(
    wpAt,
    -1,
    `${WINDOW_FACTORY}: defaultOption 里没有 webPreferences——窗口将退回 Electron 默认值，` +
      `安全默认（nodeIntegration:false / contextIsolation:true / webSecurity:true）随之失效。`
  );
  return extractBraceBlock(
    optionText,
    optionText.indexOf("{", wpAt),
    `${WINDOW_FACTORY} defaultOption.webPreferences`
  );
}

/** 取 html 里 CSP meta 的 content，解析成 { 指令名: [取值...] }。 */
function parseCspDirectives(rel) {
  const html = readSource(rel);
  /* 属性值用反向引用配对引号：CSP 里大量出现 'self' / 'none'，不能用 [^"'] 这种字符类。 */
  const meta = html.match(
    /<meta\s+http-equiv=(["'])Content-Security-Policy\1[\s\S]*?content=(["'])([\s\S]*?)\2/i
  );
  assert.ok(
    meta,
    `${rel}: 找不到 Content-Security-Policy 的 meta 标签。它是该页面唯一的 CSP 来源，` +
      `删掉等于让 file:// 页面回到无 CSP 状态；如需调整请改 content 而不是移除标签。`
  );
  const directives = new Map();
  for (const chunk of meta[3].split(";")) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    directives.set(parts[0].toLowerCase(), parts.slice(1));
  }
  return directives;
}

// ---------------------------------------------------------------------------
// 1. 窗口工厂默认值
// ---------------------------------------------------------------------------

test("窗口工厂默认值：nodeIntegration 必须关、contextIsolation 必须开、webSecurity 默认必须开", () => {
  const wp = defaultWebPreferences();
  const where = `${WINDOW_FACTORY} defaultOption.webPreferences`;

  assert.equal(
    readBooleanFlag(wp, "nodeIntegration", where),
    false,
    `${where}: nodeIntegration 必须为 false。渲染层拿到 require 即等于把 RCE 面直接暴露给` +
      `任意注入的脚本（本项目渲染层还会加载 Ruffle 跑第三方 SWF）。窗口需要 Node 能力时，` +
      `走 preload + contextBridge 白名单，不要开这个开关。`
  );
  assert.equal(
    readBooleanFlag(wp, "contextIsolation", where),
    true,
    `${where}: contextIsolation 必须为 true。关掉它，preload 与页面共享同一个 JS 世界，` +
      `contextBridge 暴露的白名单可被页面脚本原型污染绕过。`
  );
  assert.equal(
    readBooleanFlag(wp, "webSecurity", where),
    true,
    `${where}: webSecurity 的**默认值**必须为 true。个别窗口确需关闭时，应在自己的 open() 里` +
      `显式传 webPreferences:{webSecurity:!1} opt-out，并登记进本文件的 WEB_SECURITY_OPT_OUT，` +
      `绝不能把默认值改掉——那会一次性给所有窗口关掉同源策略。`
  );
});

// ---------------------------------------------------------------------------
// 2. webSecurity opt-out 清单
// ---------------------------------------------------------------------------

test("webSecurity 的 opt-out 窗口清单必须恰好是登记过的 4 个", () => {
  const found = listSources("src/windows", [".js"]).filter((rel) =>
    /[{,]\s*webSecurity\s*:\s*(!1|false)\s*(?=[,}])/.test(
      stripComments(readSource(rel))
    )
  );
  assert.deepEqual(
    found,
    [...WEB_SECURITY_OPT_OUT].sort(),
    `webSecurity:false 的窗口集合发生变化。\n` +
      `实测: ${JSON.stringify(found)}\n` +
      `登记: ${JSON.stringify([...WEB_SECURITY_OPT_OUT].sort())}\n` +
      `多出来的窗口=该窗口失去同源策略保护：若确有必要新增 opt-out，请把文件路径加进本文件的` +
      ` WEB_SECURITY_OPT_OUT 并在那里写明理由（哪个功能需要、为什么没有别的办法）；\n` +
      `少了的窗口=收紧成功，同样请更新清单，并跑 test/ruffleSmoke/ 确认 SWF 播放与钓鱼 iframe 没坏。`
  );
});

// ---------------------------------------------------------------------------
// 3. app.html 的 CSP
// ---------------------------------------------------------------------------

test("app.html 的 CSP：必需指令仍在，且 base-uri/form-action/object-src 未被放宽", () => {
  const directives = parseCspDirectives(APP_HTML);
  const missing = CSP_REQUIRED_DIRECTIVES.filter((d) => !directives.has(d));
  assert.deepEqual(
    missing,
    [],
    `${APP_HTML}: CSP 缺少指令 ${JSON.stringify(missing)}。` +
      `这些指令是加固时逐条加上的（frame-src 限制 iframe 只能到 127.0.0.1、connect-src 限制外联、` +
      `base-uri/form-action 'none' 挡 <base> 注入与表单外发）；缺失即回退到 default-src 兜底或完全放开。` +
      `确需删除请说明该指令为何不再需要，并同步 CSP_REQUIRED_DIRECTIVES。`
  );

  assert.deepEqual(
    directives.get("base-uri"),
    ["'none'"],
    `${APP_HTML}: base-uri 必须保持 'none'，否则注入的 <base href> 能改写所有相对路径的脚本来源。`
  );
  assert.deepEqual(
    directives.get("form-action"),
    ["'none'"],
    `${APP_HTML}: form-action 必须保持 'none'——桌宠没有表单提交需求，放开等于给数据外发开口子。`
  );
  assert.deepEqual(
    directives.get("object-src"),
    ["'self'"],
    `${APP_HTML}: object-src 必须保持 'self'。Ruffle 走 <ruffle-player>/wasm，不需要放开 <object>/<embed>。`
  );
  assert.ok(
    directives.get("default-src").includes("'self'"),
    `${APP_HTML}: default-src 必须含 'self' 作为兜底来源。`
  );
});

test("app.html 的 CSP：unsafe- 放行集合必须与已登记的完全一致（不许悄悄新增）", () => {
  const directives = parseCspDirectives(APP_HTML);
  const unsafe = [];
  for (const [name, values] of directives) {
    for (const value of values) {
      if (/unsafe-/.test(value)) unsafe.push(`${name} ${value}`);
    }
  }
  unsafe.sort();
  assert.deepEqual(
    unsafe,
    [...CSP_ALLOWED_UNSAFE].sort(),
    `${APP_HTML}: CSP 的 unsafe- 放行集合变了。\n` +
      `实测: ${JSON.stringify(unsafe)}\n` +
      `登记: ${JSON.stringify([...CSP_ALLOWED_UNSAFE].sort())}\n` +
      `多出来的（尤其是加到 style-src 之外的新指令上）请说明是哪个功能必须、有无替代方案，` +
      `再加进 CSP_ALLOWED_UNSAFE；少了的说明收紧成功，请同步常量并跑 test/ruffleSmoke/ 验证 SWF 与 Vue 模板编译。`
  );
});

test("barrage/index.html 的 CSP 必须保持严格（零 unsafe-）", () => {
  const directives = parseCspDirectives(BARRAGE_HTML);
  const unsafe = [];
  for (const [name, values] of directives) {
    for (const value of values) if (/unsafe-/.test(value)) unsafe.push(`${name} ${value}`);
  }
  assert.deepEqual(
    unsafe,
    [],
    `${BARRAGE_HTML}: 出现了 unsafe- 放行 ${JSON.stringify(unsafe)}。` +
      `弹幕页是全仓唯一一个不需要 Vue 运行时编译、也不跑 Ruffle 的页面，因此 CSP 能做到零 unsafe-；` +
      `它同时是唯一通过 executeJavaScript 注入内容的页面，放开 unsafe-inline 风险最高。` +
      `确需放开请说明理由并把它登记成一条与 app.html 同风格的白名单常量。`
  );
  for (const name of ["default-src", "script-src", "style-src"]) {
    assert.deepEqual(
      directives.get(name),
      ["'self'"],
      `${BARRAGE_HTML}: ${name} 必须保持 'self'（当前弹幕页的资源全部同目录自带，不需要外部来源）。`
    );
  }
});

// ---------------------------------------------------------------------------
// 4. 导航与新窗守卫
// ---------------------------------------------------------------------------
test("窗口工厂：新窗守卫存在且默认 deny（全文件不许出现 action:'allow'）", () => {
  const src = stripComments(readSource(WINDOW_FACTORY));
  const at = src.indexOf("setWindowOpenHandler");
  assert.notEqual(
    at,
    -1,
    `${WINDOW_FACTORY}: 缺少 setWindowOpenHandler。没有它，子框架的 window.open 与 SWF 的` +
      ` getURL _blank 会直接派生新 BrowserWindow（继承的 webPreferences 不受本文件其它断言约束）。`
  );
  const handler = src.slice(at, at + 400);
  assert.match(
    handler,
    /action\s*:\s*"deny"/,
    `${WINDOW_FACTORY}: setWindowOpenHandler 必须返回 {action:"deny"}。实测紧随其后的代码是：\n` +
      handler.slice(0, 200)
  );
  assert.equal(
    (src.match(/action\s*:\s*["']allow["']/g) || []).length,
    0,
    `${WINDOW_FACTORY}: 出现了 action:"allow"。本地窗口一律禁止派生新窗口；确需开窗的窗口应显式审查后` +
      `在自己的 main.js 里实现（并为那个新窗单独写 webPreferences 断言），不要在共用工厂里放开。`
  );
});

test("窗口工厂：will-navigate 守卫存在且是「只允许停在 app.html」的白名单形态", () => {
  const src = stripComments(readSource(WINDOW_FACTORY));
  const at = src.indexOf('"will-navigate"');
  assert.notEqual(
    at,
    -1,
    `${WINDOW_FACTORY}: 缺少 will-navigate 监听。没有它，页面里任意一个链接/脚本都能把壳窗顶层导航` +
      `到外部站点，而该窗口带着 preload 与（部分窗口的）webSecurity:false。`
  );
  const handler = src.slice(at, at + 400);
  assert.match(
    handler,
    /app\.html/,
    `${WINDOW_FACTORY}: will-navigate 必须是白名单形态——只放行 app.html 自身，其余一律拦。` +
      `实测处理器开头：\n${handler.slice(0, 200)}`
  );
  assert.match(
    handler,
    /preventDefault/,
    `${WINDOW_FACTORY}: will-navigate 处理器里没有 preventDefault，等于只记日志不拦截。` +
      `实测处理器开头：\n${handler.slice(0, 200)}`
  );
});

// ---------------------------------------------------------------------------
// 5. 危险开关零命中
// ---------------------------------------------------------------------------

test("危险开关在第一方代码里必须零命中", () => {
  const files = [...listSources("src", [".js", ".html"]), "main.js"];
  const hits = [];
  for (const rel of files) {
    const src = stripComments(readSource(rel));
    for (const token of FORBIDDEN_TOKENS) {
      if (src.includes(token)) hits.push(`${rel}: ${token}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `出现被禁用的危险开关/模块：\n${hits.join("\n")}\n` +
      `这些都是二轮加固里被明确移除的东西（disable-site-isolation-trials 曾用于放行跨源 contentWindow 直写，` +
      `child_process 则是桌宠完全不需要的命令注入面）。若确认必须恢复其中某一条，` +
      `请在 FORBIDDEN_TOKENS 里删掉它并写明威胁模型与补偿措施——不要给单个文件加豁免。`
  );
});

test("nodeIntegrationInSubFrames 不许被打开（子框架 Node 集成 = RCE 面复活）", () => {
  const files = [...listSources("src", [".js", ".html"]), "main.js"];
  const hits = [];
  for (const rel of files) {
    const src = stripComments(readSource(rel));
    for (const m of src.matchAll(
      /nodeIntegrationInSubFrames\s*:\s*(!0|!1|true|false|[^,}\s]+)/g
    )) {
      if (m[1] !== "!1" && m[1] !== "false") hits.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `nodeIntegrationInSubFrames 被赋了非 false 的值：\n${hits.join("\n")}\n` +
      `本项目的子框架会加载 http://127.0.0.1 的本地服务页面与第三方 SWF，一旦子框架拿到 Node，` +
      `任何一处内容注入都升级为任意代码执行。二轮加固刚把这个面移掉，不要恢复。`
  );
});

// ---------------------------------------------------------------------------
// 6. 远程子窗隔离
// ---------------------------------------------------------------------------

test("urlWindow 远程子窗：sandbox 开 / webSecurity 不关 / 隔离开 / 不挂 preload", () => {
  const src = stripComments(readSource(URL_WINDOW));
  const anchor = src.indexOf("REMOTE_URL_WEB_PREFERENCES={");
  assert.notEqual(
    anchor,
    -1,
    `${URL_WINDOW}: 找不到 REMOTE_URL_WEB_PREFERENCES。这个窗口用 loadURL 加载**用户输入的任意网址**，` +
      `它的 webPreferences 必须集中成一处常量以便审查；若已重命名请同步本测试。`
  );
  const wp = extractBraceBlock(
    src,
    src.indexOf("{", anchor),
    `${URL_WINDOW} REMOTE_URL_WEB_PREFERENCES`
  );
  const where = `${URL_WINDOW} REMOTE_URL_WEB_PREFERENCES`;

  assert.equal(
    readBooleanFlag(wp, "sandbox", where),
    true,
    `${where}: sandbox 必须为 true。这是唯一加载任意远程网页的窗口，` +
      `渲染进程必须待在 OS 沙箱里（工厂默认的 sandbox:false 是为了 preload 用 Node，远程窗不适用）。`
  );
  assert.equal(
    readBooleanFlag(wp, "webSecurity", where),
    true,
    `${where}: webSecurity 必须为 true——远程页面必须受同源策略约束。`
  );
  assert.equal(
    readBooleanFlag(wp, "contextIsolation", where),
    true,
    `${where}: contextIsolation 必须为 true。`
  );
  assert.equal(
    readBooleanFlag(wp, "nodeIntegration", where),
    false,
    `${where}: nodeIntegration 必须为 false——远程页面拿到 require 就是完整 RCE。`
  );
  assert.equal(
    readBooleanFlag(wp, "nodeIntegrationInSubFrames", where),
    false,
    `${where}: nodeIntegrationInSubFrames 必须为 false——远程页面的 iframe（广告位等）同样不能有 Node。`
  );
  assert.doesNotMatch(
    wp,
    /[{,]\s*preload\s*:/,
    `${where}: 远程子窗不许挂 preload。preload 在沙箱里仍有 ipcRenderer，` +
      `等于把 IPC 通道递给任意网站；壳窗（tool/urlWindow/preload.js）才需要 preload。`
  );
});

test("弹幕覆盖层（不走工厂的 BrowserWindow）同样保持 nodeIntegration 关 / contextIsolation 开", () => {
  const src = stripComments(readSource(BARRAGE));
  const anchor = src.indexOf("webPreferences:");
  assert.notEqual(
    anchor,
    -1,
    `${BARRAGE}: 直接 new BrowserWindow 却没有 webPreferences，会退回 Electron 默认值而非本项目的安全默认。`
  );
  const wp = extractBraceBlock(
    src,
    src.indexOf("{", anchor),
    `${BARRAGE} webPreferences`
  );
  assert.equal(
    readBooleanFlag(wp, "nodeIntegration", `${BARRAGE} webPreferences`),
    false,
    `${BARRAGE}: 该窗口不走 window.js 工厂（需要 screen-saver 置顶层级），安全默认必须自己写一遍：` +
      `nodeIntegration 必须为 false。`
  );
  assert.equal(
    readBooleanFlag(wp, "contextIsolation", `${BARRAGE} webPreferences`),
    true,
    `${BARRAGE}: contextIsolation 必须为 true。`
  );
});

test("new BrowserWindow 的位置必须恰好是登记过的 3 处", () => {
  const files = [...listSources("src", [".js"]), "main.js"];
  const found = files.filter((rel) =>
    /new\s+BrowserWindow\s*\(/.test(stripComments(readSource(rel)))
  );
  assert.deepEqual(
    found,
    [...BROWSER_WINDOW_CREATORS].sort(),
    `直接创建 BrowserWindow 的文件集合变了。\n` +
      `实测: ${JSON.stringify(found)}\n` +
      `登记: ${JSON.stringify([...BROWSER_WINDOW_CREATORS].sort())}\n` +
      `新增一处=新增一个不受 window.js 工厂安全默认约束的窗口：请把它加进 BROWSER_WINDOW_CREATORS，` +
      `并为它的 webPreferences 补一条与本文件同风格的断言（nodeIntegration/contextIsolation/webSecurity）。` +
      `优先考虑改走 windowsMain.open() 复用工厂默认值与导航/新窗守卫。`
  );
});

// ---------------------------------------------------------------------------
// 7. 动态 eval
// ---------------------------------------------------------------------------

test("第一方代码里的 eval 只能是 webpack 产物的 eval(\"require\") 静态形式", () => {
  const files = [...listSources("src", [".js"]), "main.js"];
  const bad = [];
  for (const rel of files) {
    const src = stripComments(readSource(rel));
    for (const m of src.matchAll(/(?<![\w.$])eval\s*\(/g)) {
      const call = src.slice(m.index, m.index + 24);
      if (!/^eval\s*\(\s*"require"\s*\)/.test(call)) bad.push(`${rel}: ${call}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `出现了非 eval("require") 形式的 eval：\n${bad.join("\n")}\n` +
      `本仓库所有 eval 都是 webpack 外部依赖占位（eval("require") 静态字符串，等价于普通 require），` +
      `除此以外任何 eval——尤其是拼接变量的——都会把数据变成代码。` +
      `需要动态分派请用查表/白名单函数映射。`
  );
});

test("第一方代码里不许出现 new Function（Vue/Ruffle 等第三方 bundle 除外）", () => {
  const files = [...listSources("src", [".js"]), "main.js"];
  const hits = [];
  for (const rel of files) {
    const src = stripComments(readSource(rel));
    if (/new\s+Function\s*\(/.test(src)) hits.push(rel);
  }
  assert.deepEqual(
    hits,
    [],
    `出现了 new Function：\n${hits.join("\n")}\n` +
      `它与 eval 等价（且是 CSP 保留 'unsafe-eval' 的唯一理由——第一方代码若也开始用，` +
      `就再也没法收紧 script-src 了）。第三方 bundle（${VENDOR_DIRS.join(", ")}）不在扫描范围内。`
  );
});
