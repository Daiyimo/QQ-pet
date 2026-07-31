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

当前 305 个测试（本轮修复后实测；`test/edgeHide.test.js` 是独立冒烟脚本，`node --test` 把它整体计为 1 个）。除 `test/newSkinRouter.test.js` 需要运行时依赖 `iconv-lite`（即先 `npm install`）外，其余全部纯 Node 运行、不依赖 Electron，通过依赖注入（时钟 / 随机数 / 存储 / 服务商 / `fs` / `electron-store` / `express`）隔离外部依赖。

`test/ruffleSmoke/` 是需要 Electron 与真实素材的手动冒烟脚本（`node test/ruffleSmoke/run.js` 等），**刻意不被 `npm test` 的 glob 收录**，改 Ruffle 相关代码时手动跑。

### 代码地形图（改代码前必读）

本项目的源码分成两个性质完全不同的区域：

| 区域 | 形态 | 说明 |
|---|---|---|
| `src/service/**`、`src/windows/util/{pathGuard,controlBarClamp}.js`、`src/windows/util/pet/{ruffleBridge,newSkinRouter,skinAdapter}.js`、`src/windows/main/edgeHide.js`、`src/ini/{dataWatcher,root}.js` | 多行源码 + 中文注释 + 测试覆盖 | **放心改** |
| `src/ini/` 多数文件、`src/windows/` 多数文件 | **webpack 压缩单行产物**，仓库内无对应源码与 sourcemap | **只能定点字符串替换** |

压缩区的文件 `wc -l` 为 0，所有行号都是 `:1`。改动这些文件时：

- **不要格式化整个文件** — 会产生巨大 diff 掩盖真实改动
- 用唯一片段做字符串替换，并**断言命中次数**
- 新逻辑写成独立的多行模块，在压缩文件里只留一行接入点（`ruffleBridge.js`、`controlBarClamp.js`、`pathGuard.js` 都是这个模式）

`src/windows/lib/`（Vue / Ant Design / iconfont）与 `src/windows/js/ruffle/` 是第三方发行版，不要改。

### 架构要点

- **主进程**：`main.js` → `src/ini/init.js`（按固定顺序同步 require，顺序即依赖）→ `src/ini/doMain.js`（存档初始化 + 装载 service + 拉起主窗口）
- **全局状态**：`src/ini/pet.js` 是宠物状态仓库，通过 `getPetInfo` / `setPetInfo` / `getSys` / `setSys` 等全局函数暴露；service 层以 9 个全局单例互相协作，加载顺序是隐式契约
- **窗口**：`src/windows/window.js` 是窗口工厂，所有窗口 `loadFile(app.html)` 后由主进程读取各自的 `index.html` 片段，用 `executeJavaScript` 注入渲染
- **Flash**：`.swf` 由 Ruffle 的 `polyfills` 自动接管 `<embed>` 标签；`ruffleBridge.js` 用 Ruffle 元数据重建虚拟时间轴，补上 Ruffle 不提供的帧回调

---

## 已知问题

- **`Alt+Q` 截图在 Windows 上无功能** — 调用的是 macOS 的 `screencapture` 命令，且回调 `this` 丢失、成败判断反了。当前仅占用快捷键，未修复。
- **贴边动画不停在指定帧** — Ruffle 未暴露任何跳帧能力（无 `GotoFrame` 等价 API），贴边动画会整片播放。需改素材或等 Ruffle 支持。
- **本地窗口保留 `webSecurity: false`** — 后花园与钓鱼依赖跨源 iframe 的 `contentWindow` 直写传数据，强行收紧会废掉这两个功能。可输入任意网址的窗口已隔离到 `webSecurity: true + sandbox: true + 无 preload`。彻底修复需先把那两处改为 `postMessage`。
- **多显示器下贴边判定可能错位** — 贴边逻辑用累加后的屏幕尺寸，而窗口钳制是多屏感知的，两套坐标体系不一致。
- 屏幕感知默认每 2 秒截屏一次，长时间开启有一定 CPU 开销。
- **新版钓鱼无"免费饲料"按钮** — 官方 1.2.5 素材本身没有该入口，cmd:10 分支不触发，属预期；鱼苗商店沿用本项目调过价的内置表，官方 `fish_fry_table.json` 未接入。

---

## 许可与免责

本项目以 MIT 许可发布，见 [LICENSE](LICENSE)（按 MIT 要求保留了上游版权声明）。

「QQ」「QQ宠物」相关名称、商标、角色形象、美术与音频资源、游戏设计数据的知识产权属于**腾讯及其关联主体**，本项目对其不主张任何权利，也不分发这些资源。

本项目是个人逆向研究、桌面移植与怀旧存档项目，**不属于腾讯官方产品**，与腾讯控股有限公司及其关联方没有任何关联、隶属、授权或合作关系。详见 [NOTICE.md](NOTICE.md)。
