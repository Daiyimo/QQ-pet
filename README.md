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

喂养 / 清洗 / 吃药 / 玩具、打工赚元宝、上学提升学识、双栏商城（背包 + 购物 + 购物车）、背景装备切换（永久拥有）、粉钻特权（8 折 / 专属商品 / 成长加成）、35 款小游戏（21 个一级入口 + 「冒险岛合集」9 个 + 「其他换皮小游戏合集」5 个，见 `src/windows/popups/smallGame/index.js` 的 `gameList`）、钓鱼、后花园、宠物资料与属性面板、贴边隐藏、鼠标穿透。右键菜单、悬浮控制条、商城、小游戏大厅等界面均已对齐官方 1.2.5 的素材与交互（详见 CHANGELOG）。

宠物属性（饥饿 / 清洁 / 心情 / 健康 / 成长 / 学识 / 魅力 / 体力）按 60 秒心跳衰减与成长，等级上限 400 级。

### 从上游继承的工具

**透明浏览器** — 设置页「工具-玩~」→ 按钮**「打开控制透明浏览器，你懂得~」**。来自上游 `qqpet_automation` 的摸鱼工具，既不属于官方原版玩法，也与本项目的 AI 能力无关，故单列。

它开一个独立窗口，**可加载任意 http/https 网址**（地址栏自己填，默认 `https://www.baidu.com`），带前进 / 后退与历史列表，窗口透明度可用滚轮无级调节、可置顶、可鼠标穿透。

这是本项目**最大的出网面**——AI 那条链路只发给你自己配置的服务商，这个窗口能连任何站点。因此它被单独隔离：独立 session 分区 `persist:remote-url`（cookie / 缓存不与桌宠本体各窗共用）、渲染进程沙箱开启、不挂 preload（页面拿不到本应用的 IPC 通道）、只放行 http/https 导航、新窗口一律拒绝、摄像头 / 麦克风 / 定位走与本体相同的权限门禁。相关断言见 `test/electronSecurityInvariants.test.js`。

### 本项目新增的 AI 能力（可选，默认全关）

| 能力 | 说明 |
|---|---|
| **AI 对话** | 与宠物多轮聊天，保留最近 4 轮上下文；`Ctrl+M` 唤起 |
| **动态台词** | 待机、喂食、清洁、升级、上线等场景的台词由 LLM 现编，而非硬编码字典 |
| **屏幕感知** | 定时截屏交多模态模型理解当前场景（游戏 / 上课 / 日常浏览），宠物据此反应 |
| **游戏弹幕** | 感知到游戏画面时，在全屏透明覆盖层发弹幕吐槽 |
| **记忆与日记** | 把感知事件沉淀为 `events.jsonl`，每日聚合成时间轴日记，可再生成配图 |
| **课程录制** | 识别到上课场景后录制关键帧与转写，结束时生成总结并导出到桌面 |
| **专注守护** | 基于系统空闲时间的护眼（25 分钟）、久坐（50 分钟）、深夜劝睡（22:00–03:59）、久别问候提醒，文案全部现编。深夜劝睡**每晚只提醒一次**，去重键按「夜晚」而非日历天（00:00–03:59 归前一天），并落盘 sys，重启不会重新唠叨 |
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

屏幕感知需要**多模态（视觉）模型**。设置页**没有独立的视觉服务商入口**（历史上的 `sys.visionProvider` 是个只读不写的死键，已删除），感知一律复用「自定义」标签页里配好的对话服务商 —— 所以那一栏必须填一个会看图的模型。开启感知时会先做一次零请求预检并气泡告知实际用于看图的模型；若该模型不支持图片，连续 3 次「配置性失败」（400 不支持图片 / 401 Key 无效 / 402、403 欠费 / 404 地址错，以及 HTTP 200 但 body 报图片能力错误）后会**自动停用本进程的感知循环并销毁弹幕窗**，气泡里带真实原因，不再无限重试烧截屏和请求。瞬时失败（408 / 425 / 429 / 5xx / 超时 / 解析失败）仍走退避重试。

图像生成（日记配图）在「记忆与课程」标签页单独配置，走 images/edits 接口。

### 各功能开关

| 标签页 | 可配置项 |
|---|---|
| 全局设置 | 透明度、开机自启、暂停成长、免打扰、宠物皮肤（重启生效） |
| 工具-玩~ | 实时监听播报剪切板、**剪切板内容发送给 AI**、**透明浏览器（可打开任意网址）**、背景音乐、说明书 |
| 自定义 | 启用 AI 对话、服务商类型 / 地址 / Key / 模型 |
| 屏幕感知 | 启用屏幕感知、游戏弹幕、感知间隔毫秒（默认 2000，下限 500） |
| 记忆与课程 | 生成今日记忆、图像服务商配置、参考图路径、生成今日记忆图 |
| 专注守护 | 主开关 + 护眼 / 久坐 / 深夜劝睡 / 回归问候四个分项 |
| 快捷键设置 | 截图、打开设置、上帝模式 |

### 默认快捷键

「快捷键设置」标签页只能改前三项（`screenshot` / `openStting` / `god`）；后三项是代码里写死注册的，设置页看不到也改不了。

| 快捷键 | 功能 | 可在设置页修改 |
|---|---|---|
| `Alt+D` | 打开设置 | 是 |
| `Alt+.` | 上帝模式（调试用，可改元宝 / 成长 / 发道具） | 是 |
| `Alt+Q` | 截图 — **当前在 Windows 上无功能**，见「已知问题」 | 是 |
| `Ctrl+M` | 打开 / 关闭 AI 对话 | 否，由 `src/service/aiWiring.js:102` 动态注册 |
| `Alt+Esc` | 关闭桌面悬浮特效窗并把该开关置为关 | 否，`src/windows/main/main.js` 的 `upShotycut("controlTool", ["ALT","ESC"], …)` |
| `Alt+Shift+Ctrl+R` | 重载：关掉全部子窗口后重新加载主窗口 | 否，同上文件的第二处 `upShotycut("controlTool", …)` |

---

## 数据与隐私

本项目不含任何遥测：上游已把设备指纹采集、RSA 上报、自动更新全部桩化，远程 API 地址置空。除你自己配置的 LLM 服务商、以及你在**透明浏览器**里主动打开的网站外，**不会向任何服务器发送数据**。

### 数据存放位置

| 内容 | 路径 |
|---|---|
| 宠物存档、系统设置 | `%APPDATA%\qq-local\config-qq-local.json` |
| 记忆事件与日记 | `%APPDATA%\qq-local\memory\` |
| 课程录制 | `%APPDATA%\qq-local\courses\` |
| 课程导出 | `桌面\QQ-Courses\` |
| 透明浏览器打开过的网站的 cookie / localStorage / 缓存 | `%APPDATA%\qq-local\Partitions\remote-url\`（独立 session 分区 `persist:remote-url`，与桌宠本体各窗**不共用**）。是持久化分区：登录态与浏览痕迹会跨重启保留，想清干净就删掉这个目录 |

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

还有一条**不经过 LLM 服务商**的出网路径，单独列出：

- **透明浏览器** — 你在「工具-玩~」里打开的网址会**直连目标站点**，收到数据的是那个网站本身（以及它页面里的第三方资源），不经过任何 LLM 服务商，也不经过本项目的服务器。对方拿到的是常规浏览器请求：URL、User-Agent、Referer、你在该站点的 cookie 等，与用普通浏览器访问它无异。**此项没有开关**，不打开那个窗口就不会发生；打开哪个网站完全由你输入的地址决定。

磁盘占用**大部分**有上界，逐项都能在代码里找到常量：

| 内容 | 上界 | 常量位置 |
|---|---|---|
| 记忆事件 `events.jsonl` | 现役 4 MiB + 2 份归档 = 12 MiB | `src/service/memory/store.js:16,20` |
| 日记配图 `daily-images/` | 每天最多留 3 张，全库 200 MiB（含元数据 json） | `src/service/memory/store.js:29,33` |
| 课程录制 | 保留最近 20 个会话；单会话关键帧 40 张 / 24 MiB、转写 2 MiB → 本地副本约 20 × 26 MiB ≈ 520 MiB | `src/service/courses/repo.js:14,16,19,22` |
| 课程的块级总结缓存 `summary-chunks.json` | 每会话 80 块 × 4000 字符，随会话数裁剪 → 全局约 6 MiB | `src/service/courses/repo.js:41,42` |

**没有上界的**（如实列出）：

- **宠物存档 `config-qq-local.json`** — `fishing.fishes` / 背包 / `achievements` 三个数组只增不裁。这是**有意未做**：裁剪要先回答「哪些鱼该留」「删掉的鱼算不算钓过」（影响成就与图鉴语义），属产品决策而非护栏，不代用户删数据。现有的护栏只到「涨大了让用户看见」：落盘成功后每 20 次抽检一次体积，超过 2 MiB 会 warn + 弹一次用户可见气泡（`src/ini/storeCache.js:74,82`）。
- **`memory/daily/` 下的每日 markdown 与 `facts.json`** — 每天一份，增长慢但无裁剪。
- **桌面导出目录 `桌面\QQ-Courses\`** — 不会被自动删除（桌面文件是用户可见资产，删除不可逆）。超过 30 个课程目录时每进程弹一次气泡提醒你自己清理（`src/service/courses/manager.js:34,668`）。

---

## 开发

```bash
npm test        # node --test test/*.test.js
```

当前 **986 个测试 / 69 个测试文件**（实测 `npm test` 的 `tests` 计数）。除 `test/newSkinRouter.test.js` 需要运行时依赖 `iconv-lite`（即先 `npm install`）外，其余全部纯 Node 运行、不依赖 Electron，通过依赖注入（时钟 / 随机数 / 存储 / 服务商 / `fs` / `electron-store` / `express` / `realpath`）隔离外部依赖。

**「不依赖 Electron」不等于「不碰磁盘和网络」**（此前的表述容易被误读）：`coursesManager` / `coursesRepo` / `memory` / `memoryDedupe` / `memoryStore` / `pathGuardRealpath` / `storeCorrupt` / `storeGetItemThrow` 八个文件用 `os.tmpdir()` + `mkdtempSync` 建真实临时目录（用后 `rmSync` 清理）；`imageGenAbort` / `imageGenEndpoint` / `providersTransport` 三个文件用 `server.listen(0, "127.0.0.1")` 起真实 HTTP 服务（临时端口、仅回环，无冲突风险）。

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

- **`Alt+Q` 截图无功能** — 当前是**不分平台的空实现**（`src/windows/main/shortcuts.js` 的 `methods.screenshot`）：记一条 warn 说明它依赖 macOS 的 `screencapture`、当前平台不支持，**并弹一条用户可见气泡**「[host]，截图功能暂不支持当前系统哦~~~」，然后跳过。全仓已无 `child_process`。仅占用快捷键，未实现。（此条此前描述为"调用 macOS 命令、回调 `this` 丢失、成败判断反了"，那段代码已不存在，第三轮审查订正；"只记 warn"的说法同样不全，本轮补上气泡。）
- **`shortcuts.js` 的日志前缀 `[快捷键]` 与本文档的日志约定直接矛盾** — 下面「日志与异常约定」把 `[快捷键]` 逐字当作反面例子（"不要用中文功能标签，无法 grep 反查文件"），而 `src/windows/main/shortcuts.js` 现存 3 处 `[快捷键]`（模块加载失败 error、快捷键注册失败 warn、截图不支持 warn），是全仓仅存的中文前缀。按约定应为 `[main/shortcuts]`。**本轮只如实记录，不改代码**：该文件是 webpack 压缩单行产物，改前缀属"顺手改到的地方"以外的独立改动。附带的元问题（6ab27c5 已列为待办）：前缀规范没有任何自动化守卫 —— 上一轮 `src/windows/main/main.js` 与仓库根 `main.js` 的 `[main]` 撞名是靠人发现的，本该由一条扫 `src/` 下 error/warn 前缀的元测试自动抓到。
- **贴边动画不停在指定帧** — Ruffle 未暴露任何跳帧能力（无 `GotoFrame` 等价 API），贴边动画会整片播放。需改素材或等 Ruffle 支持。
- **本地窗口默认 `webSecurity: true`，仅 4 窗显式 opt-out，且其中 2 窗的 opt-out 理由已不成立** — 主宠窗 / smallGame 靠 Ruffle fetch 本地 SWF（`file://` 页面 + `webSecurity: true` 会拦子资源请求），这两个理由仍成立；钓鱼 / 密室的理由写的是「`file://` 壳要跨源直写 `http://127.0.0.1` iframe 的 `contentWindow`」，**这条已经站不住**：`webSecurity: false` 关的是同源策略，关不掉进程级站点隔离；历史上放行靠的是 `disable-site-isolation-trials`，该开关已在第二轮加固中移除，并被 `test/electronSecurityInvariants.test.js:105` 的 `FORBIDDEN_TOKENS` 零命中断言钉死、不计划恢复。项目自己的冒烟脚本 `test/ruffleSmoke/runCspGuard.js:193-204` 已把「该直写会被 Chromium 拦截」写成既定事实，并把 C3 探针降级为**不计入通过数的观测项**；`986ec80` 又专门给钓鱼补了「等待宿主注入 `selfeLoad` 超时」的 warn（`src/windows/popups/fishing/indexOnLine.js:760-772`），正是被拦死后的表现。**结论：钓鱼 / 密室的 `webSecurity: false` 应当被移除而非保留，彻底修复需把那两处改为 `postMessage`。**
  待办（按顺序）：① 跑一次 `node test/ruffleSmoke/runCspGuard.js`，把 C3 探针的实测输出记进 `report.md`，用实测替掉本条的推理；② 若确认被拦，把钓鱼 / 密室的宿主注入改成 `postMessage`；③ 改完把 `webSecurity` opt-out 清单从 4 个收到 2 个，并同步 `electronSecurityInvariants` 里那条「恰好 4 个」的集合等值断言。
  统一的导航 / 新窗守卫（默认 deny）覆盖全部窗口。可输入任意网址的窗口隔离到 `webSecurity: true + sandbox: true + 无 preload + 独立 session 分区`。
- **CSP meta 只覆盖 2 个文档，iframe 载入的三个页面完全无 CSP** — 全仓 27 个 html 里只有 `app.html`（壳窗）与 `barrage/index.html`（全仓唯一零 `unsafe-` 的严格 CSP）带 CSP meta。而经 `http://127.0.0.1` 载入 iframe 的 `main/indexOnline.html`、`popups/fishing/indexOnLine.html`、`popups/backRoom/indexOnLine.html` 一个都没有 —— 它们恰好就在上面那 4 个 `webSecurity: false` 的窗口里。`app.html` 自己的注释已承认其 CSP 不约束子框架文档。
- **多显示器下贴边判定可能错位** — `src/windows/main/edgeHide.js` 的 `getScreenSize()` 来自 `src/ini/screen.js` 的 `global.getScreenSize`，返回的是**全部显示器边界并集**的宽高；而窗口钳制（`src/windows/window.js` 的 `clampPosition`）用的是 `screen.getDisplayNearestPoint(...).workArea`，两套坐标体系不一致。
- 屏幕感知默认每 2 秒截屏一次（`src/service/perception/loop.js:290`，下限 500ms），长时间开启有一定 CPU 开销。**已比此前轻**：PNG 编码改成了记忆化惰性 getter（`src/service/perception/capture.js:194`），"画面未变 / 在途中 / 不到心跳"被丢弃的 tick 上完全不编码，省掉每次 10–30ms。仍存的固定开销是每 tick 一次 `toBitmap()`（3.69 MB 分配，用于变化检测的 576 个采样点）—— 要减掉得先 resize 再取 bitmap，但那是插值平均而非点采样，会改变 `FrameChangeDetector` 的语义，阈值要连带重标，属独立议题。
- **新版钓鱼无"免费饲料"按钮** — 官方 1.2.5 素材本身没有该入口，cmd:10 分支不触发，属预期；鱼苗商店沿用本项目调过价的内置表，官方 `fish_fry_table.json` 未接入。

### 已确认、但尚未修复的问题

第三轮深度审查（七个维度：Electron 攻击面 / 状态机与并发 / LLM 与网络层 / 代码质量 / 测试真实质量 / 未提交改动 / 性能与资源）曾在此列出约 30 条 P1。**其中绝大多数已在其后的 30 个提交里修完**（详见 CHANGELOG 的「第三轮 P1 清账」小节）。本节只保留**当前仍然成立**的条目。

**磁盘（有意未做）**

- **存档 `config-qq-local.json` 的数组仍无上界** — `fishing.fishes` / 背包 / `achievements` 三处只增不裁。**这是有意的产品决策而非疏漏**：裁剪必须先回答「哪些鱼该留」以及「删掉的鱼算不算钓过」（直接影响成就与图鉴语义），代用户删数据的风险高于它要防的膨胀。已做的部分：写放大已修（`src/ini/storeCache.js` 的内存镜像 + `pet` 键写防抖，每小时全文件读 360 → 180、写 120 → 60），体积检查已从「启动期一次 + 只 `console.warn`」改为「落盘成功后每 20 次抽检一次，超 2 MiB 弹一次用户可见气泡」（`src/ini/storeCache.js:74,82,327`）。即现状是「涨大了让用户看见」，不是「不会涨大」。
- **`memory/daily/` 的每日 markdown 与 `facts.json` 无上界** — 每天一份，增长极慢但确实无裁剪。同目录的 `daily-images/` 已在 `651d519` 补上「每天 3 张 / 全库 200 MiB」。

**防回归的覆盖边界**

- `test/electronSecurityInvariants.test.js` 是纯 node、平台无关的静态断言（当前 **18 条**），钉住：窗口工厂默认值（含 `sandbox` 默认必须为 `true`）、`webSecurity` opt-out 文件集合恰好 4 个、`sandbox` opt-out 恰好主宠窗 1 个、CSP 指令与 `unsafe-*` 配对集合、`barrage` 的严格 CSP、导航与新窗守卫、`_guardIpc` 三层校验各自存在且拒绝时留日志、`ipcMain.on` 注册点唯一且无 `setPreload`、7 个危险开关零命中、`nodeIntegrationInSubFrames` 不许为真、`urlWindow` 隔离与 `persist` 分区（含"先装 session 守卫再建窗"的顺序）、`new BrowserWindow` 出现位置恰好 3 处、`eval` 只许 `eval("require")` 静态形式、第一方代码零 `new Function`。
  **仍未覆盖的**：第三方 bundle（`lib/`、`js/ruffle/`）被整体排除，故不含供应链风险；`spawn` / `execSync` 未扫描（"spawn"在刷怪 / 刷鱼语境下会自然出现，纯误伤）；日志前缀规范无自动化守卫（见上文「已知问题」）。运行期行为（CSP 是否真拦住、Ruffle 是否仍能播、跨源直写是否真被拦）仍只有手动冒烟 `test/ruffleSmoke/runCspGuard.js` 覆盖。
  > 订正：此前本节写「`sandbox:false` 全局默认**刻意未断言**」——`67d5a93` 把工厂默认翻转为 `sandbox:!0` 之后，该断言已正面存在（`test/electronSecurityInvariants.test.js:305,362`），这句话不再成立。

**正确性（本轮新发现、未修）**

- **`setup` 的"重生为另一性别"不是事务** — 异常路径已在 `7a37a93` 补好（读 `pet.info.sex` 失败时中止而非兜底，避免清档后写错性别），但正常路径里 `$Store.clear()` 之后紧跟的 `setItem("toSex")` 仍是裸调：它若抛错就是「已清档、未写 toSex」，重启后按默认性别建新宠物。这两步应作为一个事务处理。
- **`State.doActive` 开工 / 上学时既不清 `trip` 也不校验互斥** — `af2b50c` 只是给后果兜了底（把 `cancelTravel` 从 if-else 链里移出为无条件执行）。根因是互斥校验只存在于 `travel.startTravel` 一侧，应把前置校验收敛进 `doActive`。
- **`fishing/indexOnLine.js` 还有一处 `player.PETEventOnReceived` 是裸调** — 影片未就绪时抛未捕获 `TypeError`。同文件的 `setPETEVENT` 已在 `af2b50c` 改成闭包内独立计数 + 放弃时留 warn，这一处漏了。
- **崩溃留下 `recording` 状态的课程会话仍会永久滞留** — `0feddf3` 给 `recoverable()` 接上了启动恢复的调用者，但它按设计不含 `recording`，只有下次课程感知触发"收养"才会结稿。扩展其语义会与 `updated_at` 的落盘精度耦合，影响面更大。
- **`focusGuard._tick` 的三个前置守卫会静默 `return`** — 其中 `powerMonitor` 缺失与 `openSpeak` 未就绪属环境问题，长期不满足会让专注守护整体哑火且零日志。
- **`src/windows/main/main.js` 还有约 12 条无前缀的 `console.log` 调试残留** — 前缀已在 `6ab27c5` 全部改对（`[main]` → `[main/main]`，去掉与仓库根 `main.js` 的撞名），但这批裸 `console.log` 未动。

**文档与注释准确性**

- 前几轮共发现**五处**「注释断言了代码并不做的事」，其中三处是缺陷的承重墙（`aiWiring` 的就绪探针、`ruffleBridge` 的 30s 兜底、`dataWatcher` 的"只传原始类型"），第四处是 `achievement.js` 的头注释（称 `achievements` 会被 `setPetInfo` 丢弃，实际现在双写两路都是真存储），第五处是 `swfPet.js` 的 `TAIL_FORCE_FRAMES` 注释（称"配置中最大为 5（bury）"）。由于本仓库一半源码是无 sourcemap 的 webpack 压缩产物、注释是唯一导航工具，注释准确性在这里等同于代码正确性。
  **已修**：五处注释均已订正；`e9fe1e1` 实测出配置里的真实取值是 1 / 5 / 7 / 600（`8` 恰好覆盖 7、零余量），并给 `lastTimeCut` 加了与素材无关的硬上界 + 跨引用断言让注释与配置互校；`test/ruffleSmoke/probeBridge.js` 的 30000 旧口径已改为 `require` 生产的 `EXIT_FALLBACK_MS`（并加"读不到常量就抛"的守卫，防止常量改名时静默退化成 `undefined` 超时）。
  **`fe51467` 又对 `src/service` 做了全量复核，另订正 26 处**（`achievement` 头注释虚构的触发点、`aiWiring` 写错的感知事件名、`travel` 的五处、`llm.js` 的三处数字口径等）。这类注释债目前**没有自动化守卫**——注释与代码的一致性只能靠人复核，唯一的例外是 `e9fe1e1` / `0631994` 那种「把注释里的数字改成 `require` 生产常量 + 跨引用断言」的写法，值得作为新注释的默认体例。
- **本文档的日志前缀约定只覆盖 `src/` 下的模块，未规定仓库根 `main.js` 的前缀** —— 应补一句固化 `6ab27c5` / `0631994` 定下的口径（`[main]` 基准 + `[main/startup]` 启动子作用域，拆两级是因为启动兜底与运行期兜底行为相反：退出 vs 只记日志）。

---

## 许可与免责

本项目以 MIT 许可发布，见 [LICENSE](LICENSE)（按 MIT 要求保留了上游版权声明）。

「QQ」「QQ宠物」相关名称、商标、角色形象、美术与音频资源、游戏设计数据的知识产权属于**腾讯及其关联主体**，本项目对其不主张任何权利，也不分发这些资源。

本项目是个人逆向研究、桌面移植与怀旧存档项目，**不属于腾讯官方产品**，与腾讯控股有限公司及其关联方没有任何关联、隶属、授权或合作关系。详见 [NOTICE.md](NOTICE.md)。
