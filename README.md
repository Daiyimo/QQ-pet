# QQ 宠物·离线+AI版

QQ 宠物怀旧服（v1.2.4）的 Windows 桌宠，本体完全离线运行，AI 能力可选接入多服务商 LLM（默认关闭）。宠物会看屏幕、写日记、录课程、发弹幕，并根据你的作息提醒休息。

**当前版本 1.2.6** · 变更记录见 [CHANGELOG.md](CHANGELOG.md) · 来源与免责声明见 [NOTICE.md](NOTICE.md)

---

## 项目来源

本项目 fork 自 [xuemian168/qqpet_automation](https://github.com/xuemian168/qqpet_automation)（WorkBuddy，MIT），后者对 QQ 宠物怀旧服 v1.2.4 的 Electron 应用做了逆向、跨平台移植、遥测与设备指纹移除，并用 Ruffle WASM 替代已废弃的 Adobe Flash。

```
QQ宠物怀旧服 1.2.4（官方）
      └─ qqpet_automation / qq-pet-macos（上游，清理遥测 + 摘掉 PepFlash）
            └─ 本项目（离线运行 + 可选 AI：多服务商 LLM / 屏幕感知 / 记忆 / 课程 / 弹幕）
```

> 与官方 1.2.5 **没有代码血缘**。1.2.5 是官方另起的 Vite + Vue3 工程（还带混淆与 bytenode），其功能只能作为参照，代码无法移植。

版本号跟随上游 QQ 宠物版本线命名，与官方发布无关。

> 1.2.6 起，右键菜单 / 悬浮控制条贴图、新版钓鱼等素材来自对官方 1.2.5 安装包的逆向提取（仅素材与数值配置，无代码移植）。完整移植清单见 [docs/petplayer-1.2.5-porting-list.md](docs/petplayer-1.2.5-porting-list.md)。

---

## 功能

### 继承的原版玩法

喂养 / 清洗 / 吃药 / 玩具、打工赚元宝、上学提升学识、双栏商城（背包 + 购物 + 购物车）、背景装备切换（永久拥有）、粉钻特权（8 折 / 专属商品 / 成长加成）、19 款小游戏、钓鱼、后花园、宠物资料与属性面板、贴边隐藏、鼠标穿透。右键菜单、悬浮控制条、商城、小游戏大厅等界面均已对齐官方 1.2.5 的素材与交互（详见 CHANGELOG）。

宠物属性（饥饿 / 清洁 / 心情 / 健康 / 成长 / 学识 / 魅力 / 体力）按 60 秒心跳衰减与成长，等级上限 400 级。

### 本项目新增的 AI 能力（可选，默认全关）

| 能力 | 说明 |
|---|---|
| **AI 对话** | 与宠物多轮聊天，保留最近 4 轮上下文；`Ctrl+M` 唤起 |
| **动态台词** | 待机、喂食、清洁、升级、上线等场景的台词由 LLM 现编，而非硬编码字典 |
| **屏幕感知** | 定时截屏交多模态模型理解当前场景（游戏 / 上课 / 日常浏览），宠物据此反应 |
| **游戏弹幕** | 感知到游戏画面时，在全屏透明覆盖层发弹幕吐槽 |
| **记忆与日记** | 把感知事件沉淀为 `events.jsonl`，每日聚合成时间轴日记，可再生成配图 |
| **课程录制** | 识别到上课场景后录制关键帧与转写，结束时生成总结并导出到桌面 |
| **专注守护** | 基于系统空闲时间的护眼（25 分钟）、久坐（50 分钟）、深夜劝睡（22 点后）、久别问候提醒，文案全部现编 |
| **成就 / 签到 / 旅游** | 成就体系、每日签到、放宠物出门旅行收集省份 |
| **换肤** | 除经典 Flash 皮肤外，支持 `assets/ActionNew` 下的 PNG 序列帧皮肤 |

AI 相关功能**全部默认关闭**，需在设置里填好服务商后逐项开启。

---

## 快速开始

### 环境要求

- Windows 10 / 11 x64
- [Node.js](https://nodejs.org/) 20 或更高（跑测试需要稳定版 `node --test`）

### 安装与运行

```bash
git clone <你的仓库地址>
cd QQ_pet
npm install
npm start
```

开发模式（会打开可用的 DevTools 入口）：

```bash
npm run dev
```

### 打包

```bash
npm run build            # NSIS 安装包 + 免安装版
npm run build:win:nsis   # 仅安装包
npm run build:win:portable   # 仅免安装版
```

产物输出到 `dist/`。日常用推荐 `QQ宠物离线+AI版-<版本>-portable.exe`：单文件免安装，双击即启动；除 AI 服务商 API 外全部本地运行，本机服务只绑 `127.0.0.1`。

---

## 配置

右键宠物 → **系统设置**（或按 `Alt+D`）。

### 接入 AI 服务商

「自定义」标签页：

1. **服务商类型** — `openai`（OpenAI 兼容协议，绝大多数国内外服务商都适用）或 `anthropic`
2. **API 地址** — 如 `https://api.deepseek.com`、`https://api.openai.com/v1`
3. **API Key** — 保存时用 Electron `safeStorage` 加密后落盘，不存明文
4. **模型名称** — 如 `deepseek-chat`、`gpt-4o`
5. 点**测试连接**确认可用，再**保存并启用该服务商**
6. 勾选**启用 AI 对话**

屏幕感知需要**多模态（视觉）模型**。若未单独配置视觉服务商，会回退到对话服务商 —— 此时若该模型不支持图片，感知会失败。

图像生成（日记配图）在「记忆与课程」标签页单独配置，走 images/edits 接口。

### 各功能开关

| 标签页 | 可配置项 |
|---|---|
| 全局设置 | 透明度、开机自启、暂停成长、免打扰、宠物皮肤（重启生效） |
| 工具-玩~ | 实时监听播报剪切板、**剪切板内容发送给 AI**、背景音乐、说明书 |
| 自定义 | 启用 AI 对话、服务商类型 / 地址 / Key / 模型 |
| 屏幕感知 | 启用屏幕感知、游戏弹幕、感知间隔毫秒（默认 2000，下限 500） |
| 记忆与课程 | 生成今日记忆、图像服务商配置、参考图路径、生成今日记忆图 |
| 专注守护 | 主开关 + 护眼 / 久坐 / 深夜劝睡 / 回归问候四个分项 |
| 快捷键设置 | 截图、打开设置、上帝模式 |

### 默认快捷键

| 快捷键 | 功能 |
|---|---|
| `Alt+D` | 打开设置 |
| `Alt+.` | 上帝模式（调试用，可改元宝 / 成长 / 发道具） |
| `Ctrl+M` | 打开 AI 对话 |
| `Alt+Q` | 截图 — **当前在 Windows 上无功能**，见「已知问题」 |

---

## 数据与隐私

本项目不含任何遥测：上游已把设备指纹采集、RSA 上报、自动更新全部桩化，远程 API 地址置空。除你自己配置的 LLM 服务商外，**不会向任何服务器发送数据**。

### 数据存放位置

| 内容 | 路径 |
|---|---|
| 宠物存档、系统设置 | `%APPDATA%\qq-local\config-qq-local.json` |
| 记忆事件与日记 | `%APPDATA%\qq-local\memory\` |
| 课程录制 | `%APPDATA%\qq-local\courses\` |
| 课程导出 | `桌面\QQ-Courses\` |

存档是明文 JSON（API Key 除外，加密存储）。想备份宠物就复制 `config-qq-local.json`。

若这个文件被异常断电 / 磁盘故障写坏，启动时不会清空它：程序会把它改名为 `config-qq-local.corrupt-<时间戳>.json` 保留原始内容，再以空存档启动（日志里有对应的错误记录）。想抢救数据就手工修复该备份的 JSON 后改回原名。

### 会被发往云端的内容

开启对应功能后，以下内容会发给你配置的 LLM 服务商：

- **AI 对话** — 你输入的消息、宠物属性
- **屏幕感知** — **屏幕截图**（默认 1280 宽）与宠物属性
- **记忆日记** — 当天沉淀的感知事件摘要
- **课程录制** — 课程关键帧与转写文本
- **剪切板发送给 AI** — 你复制的文字。**此项默认关闭**，因为剪贴板可能含密码或密钥；开启前请确认你信任所配置的服务商

关掉「剪切板内容发送给 AI」后，剪贴板播报仍可用，只是不出网。

磁盘占用有上界：记忆事件文件轮转上限约 12 MiB；课程保留最近 20 个会话，单会话帧总量上限 24 MiB、转写文本上限 2 MiB，因此课程本地副本的整体上界约 20 × 26 MiB ≈ 520 MiB。桌面导出目录不会被自动删除。

---

## 开发

```bash
npm test        # node --test test/*.test.js
```

当前 **690 个测试 / 57 个测试文件**（实测 `npm test` 的 `tests` 计数）。除 `test/newSkinRouter.test.js` 需要运行时依赖 `iconv-lite`（即先 `npm install`）外，其余全部纯 Node 运行、不依赖 Electron，通过依赖注入（时钟 / 随机数 / 存储 / 服务商 / `fs` / `electron-store` / `express` / `realpath`）隔离外部依赖。

**「不依赖 Electron」不等于「不碰磁盘和网络」**（此前的表述容易被误读）：`coursesManager` / `coursesRepo` / `memory` / `memoryStore` / `pathGuardRealpath` / `storeCorrupt` / `storeGetItemThrow` 七个文件用 `os.tmpdir()` + `mkdtempSync` 建真实临时目录（用后 `rmSync` 清理）；`imageGenAbort` / `providersTransport` 两个文件用 `server.listen(0, "127.0.0.1")` 起真实 HTTP 服务（临时端口、仅回环，无冲突风险）。

`test/ruffleSmoke/` 是需要 Electron 与真实素材的手动冒烟脚本（`node test/ruffleSmoke/run.js` 等），**刻意不被 `npm test` 的 glob 收录**，改 Ruffle 相关代码时手动跑。

### 代码地形图（改代码前必读）

本项目的源码分成两个性质完全不同的区域：

| 区域 | 形态 | 说明 |
|---|---|---|
| `src/service/**`、`src/windows/util/{pathGuard,controlBarClamp,ipcInputGuard,activeRecheck}.js`、`src/windows/util/pet/{ruffleBridge,newSkinRouter,skinAdapter}.js`、`src/windows/main/edgeHide.js`、`src/ini/{dataWatcher,root,toolResolver}.js` | 多行源码 + 中文注释 + 测试覆盖 | **放心改** |
| `src/ini/` 多数文件、`src/windows/` 多数文件 | **webpack 压缩单行产物**，仓库内无对应源码与 sourcemap | **只能定点字符串替换** |

压缩区的文件 `wc -l` 为 0，所有行号都是 `:1`。改动这些文件时：

- **不要格式化整个文件** — 会产生巨大 diff 掩盖真实改动
- 用唯一片段做字符串替换，并**断言命中次数**
- 新逻辑写成独立的多行模块，在压缩文件里只留一行接入点（`ruffleBridge.js`、`controlBarClamp.js`、`pathGuard.js` 都是这个模式）

`src/windows/lib/`（Vue / Ant Design / iconfont）与 `src/windows/js/ruffle/` 是第三方发行版，不要改。

### 日志与异常约定（新代码按此写）

一轮全量审查后定下的口径。存量代码里仍有多种写法并存，**不必专门去统一**，但新代码与顺手改到的地方按这个来，避免继续漂：

```js
// 意料外的异常 —— 必须留完整堆栈，否则故障不可诊断
console.error("[前缀] 人话描述，含降级后的行为:", e?.stack || e);
// 已知/可预期的业务错误（IPC 载荷解析失败、文件不存在等）—— 有降级，留 message 即可
console.warn("[前缀] 人话描述，含降级后的行为:", e?.message || e);
```

- **前缀**用相对 `src/` 的模块路径去掉扩展名，太长时保留最后两段：`[ini/store]`、`[llm/providers]`、`[main/shortcuts]`、`[perception/loop]`。渲染层加 `/html` 区分（`[tip/html]`）。**不要用中文功能标签**（`[快捷键]` 这类无法 grep 反查文件）。
- 统一用可选链 `e?.stack`，不要再写 `e && e.stack ? e.stack : e`。
- **禁止空体 catch**。唯一例外是 webpack 双模加载探针（`try{module&&(module.exports=…)}catch(e){}`，探测环境有没有 `module`，不是吞业务异常）——新代码请直接写 `if (typeof module !== "undefined" && module)`，不要用 try/catch，更不要靠匹配异常文本来区分预期分支。
- **不可信数值**（IPC 载荷、cookie、渲染层传参）走 `src/windows/util/ipcInputGuard.js`，不要手写。注意 `Number("")` 与 `Number([5])` 都不会得到 `NaN`，光判 `isFinite` 挡不住。
- 压缩产物里既有的 `+x != +x`（只挡 `NaN`）**刻意保留**：它与 `setPetInfo` 把归零字段回写成字符串 `"0"` 的历史语义配套，换成 `Number.isFinite` 会误伤。
- **价格口径的单一真值**是 `pet/pinkDiamondShop.js` 的 `applyPinkDiamondPrice`。跑在浏览器上下文、无法 require 主进程模块的地方（如 `fishing/indexOnLine.js`）允许写第二份实现，但**必须有跨引用断言把两者钉死** —— 可以有第二份实现，不能有第二份测试基准。

### 架构要点

- **主进程**：`main.js` → `src/ini/init.js`（按固定顺序同步 require，顺序即依赖）→ `src/ini/doMain.js`（存档初始化 + 装载 service + 拉起主窗口）。`createWindow()` 整体包了 try/catch：init 阶段的致命异常会弹窗告知并 `app.exit(1)`，不能落到 `unhandledRejection`（那个处理器刻意只记日志不退出，对运行期异常是对的，对启动阶段会留下无窗口却占着单实例锁的僵尸进程）
- **全局状态**：`src/ini/pet.js` 是宠物状态仓库，通过 `getPetInfo` / `setPetInfo` / `getSys` / `setSys` 等全局函数暴露；service 层以 9 个全局单例互相协作，加载顺序是隐式契约
- **窗口**：`src/windows/window.js` 是窗口工厂，所有窗口 `loadFile(app.html)` 后由主进程读取各自的 `index.html` 片段，用 `executeJavaScript` 注入渲染
- **Flash**：`.swf` 由 Ruffle 的 `polyfills` 自动接管 `<embed>` 标签；`ruffleBridge.js` 用 Ruffle 元数据重建虚拟时间轴，补上 Ruffle 不提供的帧回调

---

## 已知问题

- **`Alt+Q` 截图无功能** — 当前是**不分平台的空实现**：只记一条 warn 说明它依赖 macOS 的 `screencapture`、当前平台不支持，然后跳过。全仓已无 `child_process`。仅占用快捷键，未实现。（此条此前描述为"调用 macOS 命令、回调 `this` 丢失、成败判断反了"，那段代码已不存在，本轮审查订正。）
- **贴边动画不停在指定帧** — Ruffle 未暴露任何跳帧能力（无 `GotoFrame` 等价 API），贴边动画会整片播放。需改素材或等 Ruffle 支持。
- **本地窗口默认 `webSecurity: true`，仅 4 窗显式 opt-out** — 主宠窗 / smallGame / 钓鱼 / 密室因 Ruffle fetch 本地 SWF 或跨源 iframe 需要保留 `webSecurity: false`，其余窗口已全部收紧；统一的导航 / 新窗守卫（默认 deny）覆盖全部窗口。可输入任意网址的窗口隔离到 `webSecurity: true + sandbox: true + 无 preload`。
- **CSP meta 只覆盖 2 个文档，iframe 载入的三个页面完全无 CSP** — 全仓 27 个 html 里只有 `app.html`（壳窗）与 `barrage/index.html`（全仓唯一零 `unsafe-` 的严格 CSP）带 CSP meta。而经 `http://127.0.0.1` 载入 iframe 的 `main/indexOnline.html`、`popups/fishing/indexOnLine.html`、`popups/backRoom/indexOnLine.html` 一个都没有 —— 它们恰好就在上面那 4 个 `webSecurity: false` 的窗口里。`app.html` 自己的注释已承认其 CSP 不约束子框架文档。
- **钓鱼 / 密室的跨源 `contentWindow` 直写在 Electron 28 下很可能已失效** — 实测 `webSecurity: false` 下 file:// 壳写 http://127.0.0.1 iframe 的 window 仍被 "Blocked a frame ... cross-origin" 拦截，需 `disable-site-isolation-trials` 才放行（该开关已在安全加固中移除，不计划恢复）。彻底修复需把那两处改为 `postMessage`。
- **多显示器下贴边判定可能错位** — 贴边逻辑用累加后的屏幕尺寸，而窗口钳制是多屏感知的，两套坐标体系不一致。
- 屏幕感知默认每 2 秒截屏一次，长时间开启有一定 CPU 开销。
- **新版钓鱼无"免费饲料"按钮** — 官方 1.2.5 素材本身没有该入口，cmd:10 分支不触发，属预期；鱼苗商店沿用本项目调过价的内置表，官方 `fish_fry_table.json` 未接入。

### 第三轮审查确认、但尚未修复的问题

第三轮深度审查（七个维度：Electron 攻击面 / 状态机与并发 / LLM 与网络层 / 代码质量 / 测试真实质量 / 未提交改动 / 性能与资源）修掉了 4 类 P0，以下 P1 已确认但本轮未动，按优先级排：

**安全**

- **`sandbox:false` 是窗口工厂的全局默认** — 逐个统计 preload 的 require，走工厂的 19 窗里只有主宠窗真正需要 Node 能力（`fs` / `path` / `iconv-lite`），其余 18 窗的 opt-out 无必要。`contextIsolation` 挡不住渲染进程层面的漏洞利用。注意不走工厂的 `barrage` 窗（第 20 个）已经是 `sandbox: true`，不在此列。
- **远程窗与本地窗共用默认 session** — `urlWindow` 未设 `partition`（全仓 `partition` 零命中），任意站点的 cookie / localStorage / SW 落进应用默认 session，且无 `will-download` 处理。**注意连带关系**：若要做 partition 隔离，必须对该 partition 的 session 也调一次 `src/ini/security.js` 的 `installPermissionHandlers`（它目前只保护 `defaultSession`），否则隔离反而会绕过权限门禁。
- **`downloadBuffer` 无回环门禁** — `memory/imageGen.js` 的图片下载只校验 protocol ∈ {http, https}，而那个 URL 是**服务端返回的**，可指向 `http://` 内网地址，且重定向每跳都不复查。它不发 `Authorization` 所以低一档，但 https → http 的降级重定向至少该禁掉。
- **约 70 条 IPC 通道无一校验 `event.senderFrame`** — 属纵深防御缺口而非当前可利用漏洞（子框架无 preload、`nodeIntegrationInSubFrames` 在唯一出现处显式为 `false`）。通道已天然带窗口名前缀，在工厂注册处包一层校验成本很低。

**防回归**

- **已补上锚，但覆盖面有边界** — `test/electronSecurityInvariants.test.js` 是纯 node、平台无关的静态断言（14 条），钉住窗口工厂默认值、`webSecurity` opt-out 文件集合恰好 4 个、CSP 指令与 `unsafe-*` 配对集合、导航与新窗守卫、7 个危险开关零命中、`urlWindow` 隔离、`new BrowserWindow` 出现位置恰好 3 处、`eval` 只许 `eval("require")` 静态形式。建立时做了 24 个变异验证（全部按预期变红）+ 6 个良性对照（含"注释里写 `nodeIntegration:!0` 散文"不误伤）。
  **仍未覆盖的**：第三方 bundle（`lib/`、`js/ruffle/`）被整体排除，故不含供应链风险；`sandbox:false` 全局默认**刻意未断言**（那是 preload 用 Node 的既定设计，断言它等于给未来收紧上锁）；`spawn` / `execSync` 未扫描（"spawn"在刷怪 / 刷鱼语境下会自然出现，纯误伤）。运行期行为（CSP 是否真拦住、Ruffle 是否仍能播）仍只有手动冒烟 `test/ruffleSmoke/runCspGuard.js` 覆盖。

**正确性**

- **屏幕感知失败的根因未消除** — 本轮只让它可诊断（分级日志 + 连续失败一次性气泡告知）。视觉模型未单独配置时仍会静默回退到对话服务商，对不支持图片的模型必然每轮 400。应在设置页保存时或感知入口做一次能力预检，而不是每轮烧一次截屏再失败。
- **`recoverable()` 无调用者** — 启动时不做 finalize 恢复，崩溃遗留的 `finalizing` 会话与总结缺失的会话都需要用户手动触发才会重跑。
- **多块课程总结无部分成功保留** — 串行 N 次 LLM 调用，第 N 块失败会丢掉前 N-1 块的提取结果，重试要从头再花钱。
- **`achievement.js` 等 3 处非启动期 `$Store.getItem` 现在会上抛** — `getItem` 语义本轮从"吞错返 `{}`"改为上抛，这三个调用方未加 try，运行期读失败会冒泡到各自上下文，值得单独排查一轮。
- **`main.js` 的 `uncaughtException` 处理器刻意不退出进程** — 对运行期孤立异常是对的（桌宠是长驻进程），但启动期同步 throw 会留下无窗口却占着单实例锁的僵尸进程。本轮只堵了 `toSex` 一个抛出点，建议给该处理器加"窗口从未创建成功则 exit(1)"的兜底。

**磁盘与性能**

- **`memory/daily-images/` 无上界** — 上面「数据与隐私」列的磁盘上界（events 12 MiB、课程 ≈520 MiB）逐条都真在代码里，但**漏了日记配图**：每次生成成功都新增一个文件，全库无裁剪，点 20 次最坏 500 MiB。
- **存档 `config-qq-local.json` 无上界** — 且 `electron-store` 的 `get`/`set` 每次都是全文件同步读写，稳态每小时约 240 次全量读 + 60 次全量写（其中一半是 dataWatcher 回声造成的多余写）。
- **感知每 tick 都做一次注定被丢弃的 PNG 编码** — `captureScreen` 无条件 `toPNG()` + `toBitmap()`，而"画面未变 / 在途中 / 不到心跳"的判定在截屏之后。12 小时约 21,600 次，每次 PNG 编码 10–30ms CPU；`toBitmap()` 分配 3.69 MB 只为读 576 个采样点。
- **剪贴板轮询 200ms** — 5 次/秒。除 CPU 外有实际副作用：Windows 剪贴板是独占资源，高频 `OpenClipboard` 会让其他程序的复制粘贴间歇失败。
- **录课期间每感知 tick ≥3 次 fsync** — `appendTranscript` 每次全量重读重写 `state.json`，而唯一作用是把 `updated_at` 往前推。一节 1 小时网课 720–3600 次全量重写，同步执行在主进程，动画会周期性卡顿。
- **桌面导出目录的上界只落在日志里** — `MAX_EXPORTED_COURSES` 超限只 `console.warn`，用户看不到，实际等于无护栏。

**文档与注释准确性**

- 本轮发现至少四处**注释断言了代码并不做的事**，且其中三处是缺陷的承重墙（`aiWiring` 的就绪探针、`ruffleBridge` 的 30s 兜底、`dataWatcher` 的"只传原始类型"）。由于本仓库一半源码是无 sourcemap 的 webpack 压缩产物、注释是唯一导航工具，注释准确性在这里等同于代码正确性。已知仍存的一处：`swfPet.js` 的 `TAIL_FORCE_FRAMES` 注释称"配置中最大为 5（bury）"，而 Kid 的 `sickOption` 配了 `lastTimeCut:600`；`test/ruffleSmoke/probeBridge.js` 里的 30000 也仍是旧口径。
- 上面「已知问题」中 `webSecurity` 那两条互相矛盾：一条说钓鱼 / 密室因跨源 `contentWindow` 直写需要保留 opt-out，另一条又说该直写在 Electron 28 下已被站点隔离拦死。两条合起来的结论是**该 opt-out 应当被移除而非保留**，需先用冒烟脚本实测确认。

---

## 许可与免责

本项目以 MIT 许可发布，见 [LICENSE](LICENSE)（按 MIT 要求保留了上游版权声明）。

「QQ」「QQ宠物」相关名称、商标、角色形象、美术与音频资源、游戏设计数据的知识产权属于**腾讯及其关联主体**，本项目对其不主张任何权利，也不分发这些资源。

本项目是个人逆向研究、桌面移植与怀旧存档项目，**不属于腾讯官方产品**，与腾讯控股有限公司及其关联方没有任何关联、隶属、授权或合作关系。详见 [NOTICE.md](NOTICE.md)。
