# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

版本号说明：跟随 QQ 宠物怀旧服的上游版本线命名。本项目 fork 自 [qqpet_automation](https://github.com/xuemian168/qqpet_automation)，来源与许可见 `NOTICE.md`。

## [未发布]

一轮全量源码审查后的集中修复，随后又做了一轮独立 code review（正确性 / 测试质量 / 一致性三个视角）并修掉 review 发现的问题。审查分五个域并行进行（主进程/IPC、宠物数值与经济、AI 服务层、渲染层、存储与测试），共确认约 50 项缺陷 + review 追加约 20 项，本次修完其中全部代码类缺陷。测试 279 → **502**，全绿。

### 破坏性变更

- **移除 SWF 文件查看器工具窗（`viewSwf`）**：`NODE_TOOL=viewSwf` 入口不再可用，设置页对应菜单项已删除。它的三个 IPC 通道把渲染层传来的任意路径直接交给 `fs.rename` / `readFileSync` / `readdir`，零校验、也没用上仓库里现成的 `pathGuard`；工具本身需环境变量才可达，属半死代码，删除比加固更彻底（git 历史可找回）。
- **`tip` 气泡不再支持 `type:"html"`**：该分支是个 `v-html` 注入点（当前无调用方，但一旦有人开始用即是 XSS）。现在发 `type:"html"` 会走转义文本渲染。

### 修复

**数据安全**

- **存档损坏会被整体清零**：`src/ini/store.js` 开着 electron-store 的 `clearInvalidConfig`，该选项语义是「读配置抛 `SyntaxError` 就把整个配置文件清空」，而这个 store 是宠物存档、系统设置、加密后的 API Key 的唯一载体。断电 / 磁盘满导致 `config-qq-local.json` 被截断时，下次启动即走「新宠物」分支，存档、成就、服务商配置全部消失，且日志里没有任何痕迹。现改为把损坏文件隔离为 `config-qq-local.corrupt-<时间戳>.json` 后再新建，用户可自行找回。
- **背包可被 `splice(-1)` 损坏**：`Goods.useConsumables` 用渲染时的数量快照做精确串匹配定位道具，一旦背包在此期间变化（打工/学习结算发道具）就 `indexOf` 得 -1，`splice(-1)` 打在数组**最后一个元素**上——无关道具被整条替换或删除，而属性效果已经先结算完，界面还提示「使用成功」。现在结算属性**之前**先校验。
- **买东西白扣元宝**：`Goods.buy` 先扣款、后入库，且 `toAddGoods` 的异常被自己吞掉、返回值无人检查。配合 `cleanOurStoreGoods` 漏掉 `background` 类目，买背景会扣钱、物品不进背包、还能重复购买。现改为先入库校验成功再扣款。
- **道具可复制 / 钓鱼可无限刷元宝**：背包落盘有 1s 防抖、钓鱼存档有 500ms 防抖，而属性与元宝是同步落盘，且都没有退出前 flush。收获后立刻关窗重开，鱼还在。

**安全**

- **删除 `viewSwf` 工具窗与 `src/windows/util/file.js`**：其三个 IPC 通道把渲染层传来的任意路径直接交给 `fs.rename` / `readFileSync` / `readdir`，零校验，也没用上仓库里现成的 `pathGuard`。
- **环境变量 `NODE_TOOL` 不过白名单**：其值被直接拼进 `require("./src/windows/tool/" + name + "/main.js")`。删除 viewSwf 后 `NODE_TOOL=viewSwf` 会 `MODULE_NOT_FOUND` 让桌宠崩在启动阶段；可控值则能加载任意本地 js。现 argv 与 env 统一走 `src/ini/toolResolver.js` 的白名单。
- **API Key 随整个 sys 配置广播进渲染进程**：设置页广播只剔除了 `shortcuts`，`llmProviders` / `imageGenProvider` / `llmApiKey` 常驻渲染进程内存（safeStorage 不可用时其中是明文）。现按字段裁剪；渲染层本就不需要这些字段。
- **`pathGuard` 可被 junction / 符号链接绕过**：只做 `path.resolve` + 前缀比较，无 `realpath` 复核。附带收益是同时归一化了 NTFS 8.3 短名。
- 打工/学习二次确认无复检（TOCTOU）：确认期间宠物病死时，`doActive` 会无条件把 `activeOption.ill` 置 null，等于免费复活 + 免费治病，还会静默清掉进行中的旅行。

**功能失效**

- **桌面特效开启后点不动桌面**：`floatStyle` 的 mousemove 处理器里 `i||return8` 引用了一个未声明的标识符（本意是 `if(!i)return`），每次 mousemove 抛 `ReferenceError`，吞掉后面的穿透状态上报，全屏 overlay 持续吃掉鼠标事件。
- **关闭屏幕感知后桌宠永久消失**：`stop()` 没有取消令牌，在途请求返回后照样 `emit pet-hide`，而恢复显示的 `_restoreFromGame` 已先执行过，此后没有任何代码会再 `show()`。同一根因还会把刚销毁的弹幕窗重新创建。
- **感知开关反复切换会叠加定时链**，实测截屏频率从 3 次/秒升到 17 次/秒，直到再次关闭感知才恢复。
- **本地服务端口被占用时窗口永远不出现**：`root.js` 三处 `listen` 都没挂 `error`，EADDRINUSE 只会抛成未捕获异常，池塘/钓鱼/密室的回调永不触发、零提示。现端口自增重试，全失败则让调用方降级并提示。
- **「签到达人」成就永不解锁**：签到写 `sys.signin`（`signIn.js` 的注释明确说过 `info.signin` 会被 `setPetInfo` 丢弃），而成就读的正是 `p.info.signin`。此前测试因手工注入 `info.signin` 一直是绿的。
- **本地模型接不上**：`providers.postJson` 硬编码 `https.request` + 端口 443，填 `http://127.0.0.1:11434/v1`（Ollama / LM Studio）必然失败，且只报 OpenSSL 底层错误。同项目的 `imageGen` 做对了协议分流。
- **带跳转的网址一律白屏**：`urlWindow` 无条件 `preventDefault()` 所有 `will-redirect`，而渲染层收到新 URL 只更新地址栏、不重新导航。
- **商城装扮页错版且翻页锁死**：背景名录预拉取用 `pageSize:20` 污染了背包缓存，20 个背景被挤进 2×3 网格。
- **悬浮条不收起**：主窗口 blur 时 `changeState("hide")` 传的是字符串而实现读 `e.type`，实际走的是显示分支并下发 `type:undefined`；另一处 `"mainFocus"==x||"hide"==x&&doHide()` 因 `&&` 优先级高于 `||` 而恒为 no-op。
- **贴边处单击/右键会误触发隐藏**：`onRelease` 只看 `isDown` 字段存在性，不看值也不看本次是否真的拖动过。
- `Alt+Q` 截图在 Windows 上必抛 `ENOENT` 且把 `isPrintIng` 永久卡在 true（此后按键只打日志），`exit` 回调 `this` 丢失、成败判断还是反的。现按平台分支并补 `error` 监听。

**数值**

- 等级表封顶缺一档且未匹配时返回**实例残留的上次等级**（实测：先查 288 级，再查 6 亿成长值仍返回 288）。该缺陷在 `level.js` 与 `GrowUp.js` 内嵌的 webpack 副本里各有一份，成长主循环走的是后者，两处都已修。
- 粉钻等级 7 不可达，成长值 ≥2800 时 `level` 为 `undefined`，`undefined*2 = NaN` 传进钓鱼一键成长次数。
- 粉钻过期当天仍按生效发 VIP 次数（`toChangeOtherDatas` 拿的是结算**前**的旧对象）。
- `getInterval` 的表里字面量键重复（`100`/`500`/`0` 各两次），「非数值」守卫被后者覆盖丢弃，老存档 health 为空时被当满健康按最高速率成长。
- 病树下标错位：「吃太饱」取 `s[3]`（越界 `undefined`）使该致病路径整体失效；`getRandom(1,2)` 让咳嗽系病树永不可达，对应 4 种药成死道具。
- `toAddGoods` 用 `indexOf` 前缀匹配，`_10001030` 永远进不了背包、数量加到 `_100010300` 头上。
- 钓鱼「使用饲料」不校验余额，元宝可扣成负数并持久化；鱼苗商店展示价 `/0.8` 而扣费用原价（非粉钻用户看到的价是实付的 1.25 倍，粉钻 8 折在钓鱼里反而不生效）。
- `getRandom` 用 `Math.round`，两端取值概率只有中间档的一半（实测 `getRandom(5,8)` → 16%/33%/33%/17%）。
- `addPetInfo` 超上限时整条丢弃而非钳制，导致心情等奖励静默丢失。

**可诊断性（项目铁律：异常不裸吞）**

- 全仓 34 处空体 catch 补日志（按级别表：已知业务错误 `warn`、意外异常 `error` + 完整堆栈），降级行为一字未改。未动 12 处 webpack 双模加载探针。
- LLM 全链路的 `.catch(()=>{})` 补堆栈：此前 Key 失效、欠费、返回非 JSON 全部无声，用户只看到兜底台词。
- `dataWatcher` 四处静默吞异常补堆栈，`watcher.on("error", () => {})` 空实现改为带退避重建。另修 `app` 可用性判定——`require("electron")` 在非 Electron 运行时**能成功、只是 `app` 为 undefined**，只靠 `try/catch` 会漏。
- `travel.js` 9 处、`signIn.js` 2 处裸 catch 补堆栈；`_saveCollected` 落盘失败不再当成功（此前旅行收集进度静默丢失，`travelChina` 成就永不解锁）。

### 变更

- LLM 的 JSON 解析两套标准收敛为 `src/service/llm/jsonParse.js`：`callLLM` 此前只去 ` ```json ` 围栏，模型在 JSON 前带一句解释就解析失败；感知侧的截断恢复行为保留。
- `postJson` 响应体加 2 MiB 上限，并把字符串累加改为 Buffer 收集（原写法会把跨 chunk 的多字节汉字切成乱码）。
- 弹幕补免打扰门禁（弹幕不走 `openSpeak`，此前绕过总开关）。
- 皮肤 XML 解码先嗅探 BOM 与 `encoding` 声明，UTF-8 素材不再乱码。
- 移除 `crypto-js` / `node-xlsx` / `nodejs-websocket` 三个零调用依赖及 `openWS` 死代码。`axios` 的 advisory 单独排期。
- `window.js` 的 `onload` 幂等化：`did-finish-load` 每次导航都会触发，而 `onload` 里做的是一次性初始化，reload 会重建 Tray、重复注册全局快捷键（此前只因重载快捷键里先手动 `destroyTray` 才没出现双托盘图标，这层依赖很脆）。
- `floatStyle` / `model` 的主进程发送通道补 `_h` 后缀，与 preload 监听对齐。此前渲染层的 `load` 回调一直收不到，只是碰巧被注入脚本里无条件调的 `seeApp()` 兜住了。
- 礼包领取先校验分页下标与 `useType` 白名单，"发放道具"与"标记已领取"合并为校验通过后的同一次写入（此前越界会抛异常，而道具已发放、领取状态未落盘 → 可重复领取）。
- 右键菜单与状态面板的"停止状态"取键判空：三元链在无进行中活动时会落到键 `""`，写 `.stopNow` 抛 `TypeError`（活动刚结束的竞态窗口内点击必崩）。
- `floatStyle` 根元素的 `id="appMain por"`（id 里带空格）使两处 `#appMain` 样式全部失配，丢失 `font-size` 与显隐 `transition`。
- 新增"日志与异常约定"到 README 的改代码前必读：日志前缀用模块路径、`e?.stack` 统一写法、禁止空体 catch（webpack 双模探针除外）、不可信数值走 `ipcInputGuard`、价格口径的单一真值。存量多种写法并存**不做统一改写**（零功能收益的风险），只约束新代码。

### 独立 code review 后追加的修复

三个视角各自复核了上面那批改动，发现的问题：

- **存档损坏隔离失败时会把程序变成无窗口僵尸进程 —— 比它要修的 bug 更糟**。`renameSync` 被杀软 / 备份程序 / 编辑器持有句柄挡住时（Windows 上很常见），隔离返回空、第二次 `new Store` 撞同一个损坏文件再抛，异常冒到模块顶层变成 `unhandledRejection` —— 而那个处理器刻意只记日志不退出。结果是进程活着、没有窗口没有托盘、还占着 `requestSingleInstanceLock`，用户只能去任务管理器杀且毫无提示。现改为四级降级：rename 隔离 → `copyFileSync` 备份 + 原文件覆盖 → 换 `-recovered-<ts>.json` 新文件名启动 → 全部失败才抛；每级都 `dialog.showErrorBox` 明确告知，前三级一律不再抛。同时 `main.js` 的 `createWindow()` 整体包了 try/catch，init 阶段的致命异常一律弹窗 + `app.exit(1)`，不再落到 `unhandledRejection`。
- **`toAddGoods` 落盘失败时白拿物品**：先改内存后落盘，`setCache` 抛错时物品已在内存里，之后任意一次成功落盘就把它持久化。现在改动前做快照、失败就地回滚（必须就地还原而非整体赋值——`storeGoods` 的类目数组与 `$Store` 里的是同一对象）。
- **元宝 / 钓鱼次数正好归零时不落盘**：`0` 曾被当成"不写入"（沿用旧的真值判断语义），于是 `canusecnt` 用完减到 0 落不了盘，关窗重开又被种回 1 → 白送一次粉钻钓鱼次数。现在显式传的 0 会写入，空字符串与 `"NaN"` 被拒。
- **"取不到 electron.app"的判定在四处各写一遍，其中三处是静默降级**：`require("electron")` 在非 Electron 运行时**不抛错、只是 `app` 为 undefined`（实测纯 Node 下它返回的是可执行文件路径字符串），所以只靠 `try/catch` 判定会漏。三处收敛到新的 `src/service/electronPaths.js`，三条降级分支各自留日志。
- **`pathGuard` 的 realpath 复核改为 fail-closed**：复核本身抛错时以前会把异常抛给调用方，现在记堆栈并拒绝——越权校验拿不到结论时放行等于没有校验。
- **`dataWatcher` 的 error 处理器会关掉已被替换的新 watcher**：用的是外层变量而非闭包捕获的实例，旧 watcher 重建后补发 error 会误关新的（能自愈但会抖动）。改为身份比对，与 `perception/loop.js` 的 `this._abort === controller` 同源。
- **mousedown 的 IPC 载荷不再塞 MouseEvent 原对象**：贴边收边依赖"载荷里没有 `isDown` 键"来区分按下/松手，而原对象跨 contextBridge 的行为（摊平成 `{}` 还是抛 `DataCloneError`）决定了这个功能是正常还是整体失效。现在只传 `{which, clientX, clientY}` 三个原语。
- **商城背包的守卫把降级路径换成了挂死**：畸形失败回包（无 `error` 无 `result`）会在清 `bagLoading` 之前早退，转圈永不停也不报错。守卫收窄为只挡"页大小不符的合法回包"。
- **用药失败的真实原因被文案短路吃掉**：库存失配时用户看到的是"我很健康哦~~"（宠物可能正病着）。判别式改用 `ok:false`（reviewer 建议的 `overType==="err"` 会误伤正常的"健康无需吃药"路径——`State.js` 在那条路径上也把 `overType` 兜底成了 `"err"`）。
- 清理本轮自己制造的死代码：`getLocalIP()`（60 行，随 `openWS` 删除而失去调用点）、`Goods.saveTimes`（防抖改同步后永不执行）、`tip/main.js` 的惰性 `JSON.parse` 块。
- `level.js` 的双模导出探针不再靠**匹配 V8 英文异常文本**区分预期分支（换引擎/换 locale 就会刷日志），改用 `typeof module !== "undefined"`。粉钻顶级返回的区间与等级对齐为自洽（`upGrowth` 1800 → 2800）；`GrowUp.js` 内嵌的那份副本同步修改——成长主循环走的是内嵌副本，两份必须一起改。

### 测试

- 279 → **502** 个测试，全绿、0 跳过。新增覆盖此前完全空白的领域：感知的 `start()`/`stop()` 生命周期、存档损坏隔离的四级降级、`dataWatcher` 全部降级分支、端口重试、`pathGuard` 的符号链接绕过、`electronPaths` 的三条降级分支。
- **修掉三条经实证抓不住 bug 的用例**（把被测源码回滚到修复前再跑，仍通过的即为假绿）：
  - `stateIll.test.js` 的 `getRandom` 桩忽略区间参数，导致"病树随机区间"这半个修复完全裸奔——把实现改回 `getRandom(1,2)` 全套仍全绿。桩改为尊重区间并直接断言区间。
  - `achievement.test.js` 一条"防回归"用例名与行为不符（两处都没写 signin），已删除。
  - `storeBagCache.test.js` 标着"端到端复现"的用例只看最终状态，而后到的正常回包会把错误状态覆盖掉；改为断言中间态。
- **删掉对压缩产物做源码文本断言的用例**（`toy125.test.js`），其行为已由真实行为用例覆盖；同时把它唯一独有的覆盖点（玩具与食物同走状态回调）转成真实行为断言，覆盖率不降。
- **"定时链叠加"的防线从墙钟速率比值换成确定性断言**：断言观测窗口内出现的 tick epoch 集合恰好只有最新那一个。旧实现下报 `[7, 5]`，直接指出残留的是哪条链。
- **`pathGuard` 的安全保证不再依赖文件系统权限**：原来三条 junction 用例在没有 symlink 权限的环境会静默跳过、套件依然全绿，等于唯一防线消失。新增 6 条平台无关用例（含反向对照组，排除"一旦注入 realpath 就一律拒绝"的假通过）。
- `test/edgeHide.smoke.js` 改名为 `edgeHide.test.js`：`npm test` 的 glob 是 `test/*.test.js`，该文件里的状态机断言从未被执行过（断言内容未改）。
- 钓鱼 8 折与商城 8 折现在有跨引用断言钉住：口径可以有第二份实现（浏览器上下文无法 require 主进程模块），但不能有第二份测试基准。

## [1.2.6] - 2026-07-29

首个以 1.2.6 命名的版本。本次集中修复安全、隐私与稳定性问题（P0 级），不含新功能。

### 修复

- **关闭桌宠卡 30 秒**（最明显的用户可感知故障）

  `swfPet.js` 的 `StateWatcher` 以约 24fps 轮询 Flash 旧版 ActiveX/NPAPI 方法（`IsPlaying` / `CurrentFrame` / `TotalFrames` / `Play` / `StopPlay` / `Rewind` / `GotoFrame`），这些在 Ruffle 中全部不存在（仅 `PercentLoaded` 幸存）。调用全抛 `TypeError` 并被静默吞掉，导致帧驱动逻辑整体失效、`finish` 回调永不触发，而退出流程正是等 `finish`，只能走 30 秒兜底。

  新增 `src/windows/util/pet/ruffleBridge.js`：用 Ruffle 的 `metadata.numFrames` / `frameRate` 加单调时钟重建虚拟时间轴，还原 `currentFrame` / `totalFrames` 语义。端到端实测 `finish` 在 7.6 秒触发（此前 30 秒内从未触发）。退出兜底同时由 30 秒缩短至 15 秒并补日志。

- **剪贴板内容默认上传云端**（隐私）

  此前只要配置了 API Key，复制的任何文字（含密码、密钥）都会无提示、无脱敏发往云端 LLM。新增 `clipToCloud` 开关，**默认关闭**，需在设置页显式开启。本地剪贴板播报（不出网）保持默认开启，功能不受影响。

- **API Key 明文落盘**（安全）

  `safeStorage` 不可用时不再静默降级为明文写盘，改为拒绝写入并告知用户；旧的明文 `sys.llmApiKey` 通路在首次读取时一次性迁移进加密存储并清除明文键（迁移幂等；凭据服务不可用时保留配置下次重试，不会抹掉用户的 Key）。

- **远程 URL 窗口越权**（安全）

  可输入任意网址的窗口（`openUrl` / 透明浏览器子窗）不再继承默认配置，改为 `webSecurity: true` + `sandbox: true` + 不挂 preload，远程页面无法触达宠物 IPC。移除 `nodeIntegration: true`。已在 Electron 28 移除的 `new-window` 事件迁移为 `setWindowOpenHandler`。

- **preload 路径穿越**（安全）

  换肤配置读取接口可通过 `../` 越界读取任意文件并解码返回渲染层。新增 `src/windows/util/pathGuard.js` 做白名单目录校验，越界拒绝并记日志。

- **后花园窗口在生产环境弹出 DevTools**：改为仅在开发模式（`--dev` 或 `$test`）生效。

- **磁盘无边界增长**：`events.jsonl` 加字节轮转（上界约 12 MiB）；课程会话数上限 20、帧总字节上限 24 MiB、转写文本上限 2 MiB；桌面导出目录超限只告警不代删。

- **记忆读取路径随使用时长线性劣化**：`readEvents` 由每次全量读盘改为增量尾部读 + 按天索引缓存（3000 事件：首次 6ms，稳态 0.015ms）。附带修掉多字节字符在增量读边界被截断的隐患。

- **全局异常静默**：`uncaughtException` 此前除 EPIPE 外无日志直接吞、`unhandledRejection` 为空函数，导致全部 service 与 LLM 调用的失败完全无声。现均记录完整堆栈。另修复多处裸 `catch` 与损坏 JSON 阻断链路的问题。

- **`.gitignore` 误伤源码目录**：`memory/` 与 `courses/` 未加路径前缀，导致 `src/service/memory/` 与 `src/service/courses/`（约 2000 行核心代码）从未进入版本控制。已修正为 `/memory/` `/courses/` 并补入源码。

### 移除

- **`dragtest/` 调试注入**：此前挂在生产启动路径上（`npm start` / `npm run dev` 下会多开窗口、每 500ms 无限追加写日志、注入探针）。
- 根目录无扩展名的 `build` 文件（与 `resources/icon.png` 内容相同的重复副本，且与 electron-builder 默认 `buildResources` 目录名冲突）。

### 变更

- `version` 0.1.0 → 1.2.6，`author` → Daiyimo。
- 补齐 `LICENSE`（MIT 双版权，按 MIT 要求保留上游版权声明）与 `NOTICE.md`（来源溯源、知识产权声明、免责声明）。`package.json` 的 `license` 字段此前指向不存在的路径。
- 产品更名「QQ宠物·云端版」→「QQ宠物·离线+AI版」，项目目录 `qq_local` → `QQ_pet`：`package.json` 的 description / productName / shortcutName / artifactName、README、NOTICE 同步更新；设置页「关于」版本号 1.2.4 → 1.2.6（压缩文件定点字符串替换）。定位调整为：本体完全离线运行，AI 为可选增强（默认全关，接入用户自己配置的服务商）。

### 已知问题

- **悬浮条（日常/交互/活动）不跟随宠物**，越靠屏幕边缘偏得越多

  control 是 1100×505 的透明窗口，可见按钮条只占其中 170×50 且由 CSS 固定在窗口内。原实现按**整个透明窗口**的边界做钳制，宠物靠边时窗口越界被推回屏幕内，窗口里的按钮条跟着一起被推离宠物（实测 2560×1440 下贴右边缘偏 468px）。新增 `src/windows/util/controlBarClamp.js`，改按**可见按钮条**的边界钳制 —— 只要按钮条还在工作区内就不动窗口。同样条件下偏移从 468px 降到 3px。

- **每次启动都有一次静默的渲染层脚本注入失败**

  `window.js` 两处 `executeJavaScript` 都没有 `.catch`，Promise 拒绝逃逸；基础脚本注入的外层 `catch` 还是空的（窗口白屏时无任何线索）。补上错误处理后定位到真凶：main 窗口的 `jsFiles` 里包含 `../service/websocket.js`，它是 `module.exports={}` 的死代码，作为 CommonJS 模块在 `contextIsolation:true` 的渲染层必然抛错。已移除该注入项（渲染层引用它 0 次）。

### 已知问题

- **贴边动画不停在指定帧**：Ruffle 未暴露任何跳帧能力（无 `GotoFrame` 等价 API），`hideleft` / `hideright` 会整片播放而非停在 61/66/39 帧。需改素材或等 Ruffle 支持。
- **本地窗口仍保留 `webSecurity: false`**：后花园与钓鱼小游戏依赖跨源 iframe 的 `contentWindow` 直写（往远端 window 挂 `getPetInfoFromMain` / `saveInfoData` 等回调），强行收紧会直接废掉这两个功能。远程 URL 入口已隔离，彻底修复需先把那两处改为 `postMessage`。
- **`Alt+Q` 截图快捷键在 Windows 上无功能**：调用的是 macOS 的 `screencapture` 命令，且回调 `this` 丢失、成败判断反了。当前仅占用快捷键。
- `src/ini/` 与 `src/windows/` 下多数文件是 webpack 压缩单行产物，仓库内无对应源码，改动只能定点替换。

### 新增（2026-07-30，新手体验）

- **新宠物默认 999999999 元宝、背包预置商店全品类道具各 10 个**（食品 552 + 日用品 287 + 药品 22 + 背景 17）：离线+AI版不设资源门槛，全部喂养/清洁/治疗内容开箱即用。默认背包生成逻辑抽为多行模块 `src/windows/util/pet/starterKit.js`（`doMain.js` 只留一行接入点），仅影响新建宠物，已有存档不变。

### 新增（2026-07-30，官方 1.2.5 特性移植）

基于对官方 1.2.5 反混淆源码（`1.2.5/deobfuscated/renderer.index.js`）的逐点侦查移植的功能（逻辑重写，非代码搬运）：

- **企鹅眼神追随**：眼神逻辑本内建于动作 SWF 的 DoABC（眼球椭圆轨迹、揉眼、晕眼判定），官方 JS 仅提供 `window.API.GetCursorPosition/GetWindowRect` 两个 ExternalInterface 回调。新建 `src/windows/util/pet/petExternalApi.js` 补桥（document 级 mousemove + `#pet` 矩形协议），`main.js` jsFiles 一行接入。此前缺桥时 SWF 走 debug 回退分支，眼神基本不生效。
- **白手指指针对齐官方**：主窗口宠物本体光标由张手（`hand/default`）改为官方同款食指白手（`hand/focus/normal.cur`，按下 `press.cur`）；素材与 `focusPress` CSS 此前已移植。
- **鼠标悬浮展开控制条**：新模块 `src/windows/util/controlBarHover.js`（悬浮开、离开 1500ms 收，与官方 `DZ` 延迟一致；仅 menu 态可收，active 二级面板不收；与点击打开路径共存），`main/main.js` 与 `control/main.js` 各留一行接入点，复用既有 `canDoType` 悬浮信号，拖动中不误触发。
- **商城升级官方 1.2.5 双区制**：新模块 `src/windows/util/storeMallData.js` 接线 `shop_tabs.json`（推荐 shopTj / 元宝 shopWy 双区，官方页码：元宝食品 6 页/日用品 4/药品 3，每页 8 个，`clean→commodity` 映射，price≤0 不上架，无官方分区回退旧全量逻辑）；商店 UI 重写（双区切换 + 分页条 + 商品真图标 `<img :src="item.icon">`（emoji 兜底）+ 悬停属性浮层 + 粉钻价展示预留）。
- **粉钻购买链路**：新模块 `src/windows/util/pet/pinkDiamondShop.js`（PD 商品表惰性加载自 `goods_all_categories.json`，22 个 PD:true）；`Goods.buy` 接 8 折（开通中 `Math.round(price*0.8)`）与 PD 门槛（未开通返回官方文案"你要帮我开通粉钻贵族才能购买哦~~"）；开通价格改官方梯度（首开 666 元宝/5 天、续费 等级×888），消除旧"文案 300 实扣 200"不一致；成长速度粉钻加成对齐官方为固定 +10（原为 +10×等级）。
- **小游戏菜单补齐官方 19 款**：`smallGame/index.js` 补入 11 个缺失官方游戏（跳跳/宠物挖矿/端盘子/穿越火线1.2/抓喜鹊/速配/穿云/跆拳道/跑酷/保姆/搭积木），素材此前已全部在 `assets/game/`（文件名逐字节核对通过）。

### 修复（2026-07-30，实机验收）

- **右键菜单首行文字上沿被裁**：头/尾行九宫格贴图的 6px 列表留白缺对应 margin，`head::after` 贴图直接盖住首行顶部 6px（"AI 聊天"渲染成"AI 聊大"），一二级菜单同因。`head`/`foot` 补 6px 间距。菜单容器同时由官方 110px 放宽到 130px（本项目最长 6 字标签 + 箭头需 129px）。
- **商城装扮区空页与贴图观感**：背景 1-10 此前全部 `price:-1` 不可购，官方分页第 1 页整页空缺；已按 `goods_all_categories.json` 回填全部 17 个背景官方价（10/120/240/.../840，PD 背景此前已回填）。面板 `rt_bg_04.gif` 烘焙的 8 个灰卡槽在不满页时露出带假按钮的灰槽，加同色系"空货位"占位格遮盖；表头烘焙 5 个 tab 位而本项目 4 个大区，第 5 空槽用同一贴图的无槽区域遮盖（大区 tab 保持官方 86px 比例，不拉伸变形）。
- **小游戏窗口左侧菜单"全黑"隐形**：窗口 `backgroundColor:"#00000000"` 在不透明窗口下实际渲染成黑色，深色菜单文字黑底隐形（此前只能靠 hover 高亮瞥见）。`.home` 补浅色底，并给未选游戏的右区加占位提示替代黑屏。
- **Ruffle 启动画面（ruffle logo splash）**：3 处 `RufflePlayer.config`（app.html、钓鱼、夺宝奇兵）加 `splashScreen: false`，SWF 直接开播。官方 1.2.5 用 PepFlash 无此画面。
- **剪贴板播报长文本刷屏**：本地播报超过 200 字截断并提示总字数（此前复制的整段代码原文会灌满气泡）。
- **小游戏菜单展开/收起按钮重做**：蓝色大方块换成细描边圆形小按钮（白底蓝箭头、hover 反色放大、箭头随状态旋转），title 写明用途"收起菜单，放大游戏画面"。
- **设置「记忆与课程」新增"打开记忆文件夹"**：记忆日记此前只能手动找文件（`%APPDATA%\qq-local\memory\daily\YYYY-MM-DD.md`，配图在 `memory\daily-images\`），现可一键打开目录。
- **商城补官方左栏「我的背包」**：窗口 560→830 双栏（左栏 347px + 右栏 456px），官方贴图与类名 1:1（mall_03/mall2_03/user_mallconbg/Card_Items/mall2_25 等 12 个新拷素材）。左栏含 喂养[食品/日用品/药品]/功能[玩具]/装扮[背景] 三个大 tab、物品卡（图标+名称+剩余数量+使用按钮）、底部元宝+分页（每页 6 件对齐官方烘焙格）；头部为**宠物状态展示区**（托盘图标头像 + 昵称/等级/粉钻 + 饥饿/清洁/心情/健康/成长五条状态栏，数据随使用/购买实时刷新）。使用走 `petControl.Goods.useConsumables` 既有结算链路（与控制条一致），购买/使用后背包与元宝自动联动刷新。官方「属性」子 tab（nums 充值物品）不做。装扮（背景）暂不支持装备，返回提示。
- **小游戏画面黑带**：Ruffle 在 `wmode:transparent` 下 SWF 舞台外区域透出窗口底色（渲染成黑），`.gameMain`/`ruffle-player` 补浅色底。
- **背景系统重做（永久拥有 + 切换装备）**：背景购买即永久拥有（`Goods.buy` 拦截重复购买"这个背景你已经拥有啦~"），不再按消耗品处理；左栏「装扮」tab 物品卡改为 已拥有 + 装备/使用中，点装备写 `activeOption.background`（`pet.js` 默认键补齐，写档时保留 activeOption 其余键），可随时切换；左栏头部显示当前背景缩略图（`img_res/background/xfpng` 官方大图）与名称；**无背景 = 不显示任何背景图**（官方用 🚫 图标占位，本项目按需求改为纯文字"无背景"）。旧存档自动补 background 字段。
- **商城双栏缝隙透出桌面**：左栏与右栏间留 10px 透明缝（商城窗口整体透明），看起来像缺背景；改为两栏相邻贴合（803px），与官方布局一致。官方商城背后同样为透明（桌面透出），与官方一致不再另加底衬。
- **商城价格行改单实付价显示**：商品卡价格由"原价/粉钻折价"双显（如 元宝：10/8）改为只显示实付价（粉钻显示 8 折价，非粉钻显示原价），与购物车合计口径一致。
- **右键子菜单闪退与难移入**：三处根因——菜单面板 `overflow:hidden` 把左出子菜单整体裁剪（闪一下就没了）；子菜单与父菜单零重叠，鼠标跨越 1px 空隙即触发 `setFv(null)` 子菜单销毁（移慢就进不去）；子菜单左出超出 340px 窗口左边界被系统裁剪。修复：撤掉 overflow、子菜单定位 ±100%→±98%（2% 重叠 hover 桥）、窗口加宽到 480px。
- **右键菜单改对齐官方 1.2.5 实测样式**：实跑官方 petplayer 取证——官方右键菜单是**白底扁平面板**（左侧蓝色竖条、行距 20px、`#175282` 12px 600 粗），ditu 铅笔贴图只出现在 hover 行；此前本项目把贴图铺在每一行常态上，显厚重且行距显大。重写为：常态白底扁平行 + hover 换官方贴图行 + 0.16s 淡入上抬打开动画，保留 130px 宽（6 字标签需要）与 `.unShow` 等既有规则。
- **控制条对齐官方 1.2.5 五 tab**：日常[食物/清洁/吃药/玩具]、粉钻（点击直接弹开通窗）、交互[打工/学习/看病]、工具[签到/设置]、游戏[池塘/游戏]；本项目特色项（任务/旅游/好礼）保留为第 6 个「活动」tab。
- **玩具（toy）分类接线**：官方 8 个玩具商品入库 `shop.js`（图标为 `.png`，与全库 `.gif` 惯例不同，`getGoodsInfo` 已做 toy 特例），背包/新手礼包/旧存档归一化全链路兼容，`State.useConsumables` 补 mood 结算（按条目值、上限 1000），控制条"日常"tab 新增"玩具"入口（无 mood 进度条，footer 仅 hunger/clean/cure 三键）。
- **PD 粉钻专属商品价格回填**：`shop.js` 20 个 PD 商品 `price:-1` → 官方正价（食品 8/日用品 6/背景 6，如锦绣大闸蟹 1040、背景13-16 各 5760），回填后粉钻用户可购买并自动享受 8 折；背景保证"能买到、进背包"，装备生效逻辑未动。

### 新增（2026-07-30，官方 1.2.5 素材移植）

- **官方 1.2.5 素材与数值配置移植**：基于对官方 1.2.5 安装包的逆向提取（仅素材与数据，无代码移植）。新增 201 个素材文件（新版钓鱼全套、img_res UI 图、windowTip 提示气泡、email 邮件素材、商城新增、talk 对话气泡等）、更新 11 个同名素材（3 个小游戏 SWF、3 张地图、3 个动作 SWF、2 个等级图标）、新增 12 个解密配置 JSON（`src/assets/config/`，含商城分类、学校阶段规则、疾病表、奖池概率等）。完整清单见 `docs/petplayer-1.2.5-porting-list.md`。
- **新版钓鱼**：钓鱼窗口换用官方 1.2.5 的 `main.swf` 与全部素材（约 32 种鱼、新增宠物甩竿动作）。1.2.5 SWF 硬编码 `pet\fishing\` 路径前缀，通过在 fishing 目录内嵌套 `pet/fishing/` 子树适配，未改任何 JS。Ruffle 冒烟验证通过（0 404、画面正常渲染）。旧版素材备份在 `src/windows/popups/fishing/legacy_124/`。
- **右键菜单与悬浮控制条换官方 1.2.5 铅笔手绘风**：菜单重写为官方规格的九宫格 PNG 贴图样式（宽 110px、`#175282` 12px 粗体、行三段式、hover 换贴图、箭头/勾选贴图），菜单项与功能逻辑不变；控制条补官方同款 hover 光环动效（图标经字节比对本就与官方一致）。顺带删除 `rightMenu/index copy.*` 遗留备份与控制条调试残留 `background-color: red !important`。

### 变更（离线化收口）

- **本机服务只绑回环地址**：`src/ini/root.js` 的 express（:33385）与 WebSocket 服务由绑局域网 IP 改为只绑 `127.0.0.1`，`src/` 静态目录不再对局域网可达。除 LLM API 与 urlWindow 用户工具窗外，全仓无出网点（含一次全量外链审计）。
- 移除 `backRoom/cmd.js` 残留的 pay.qq.com 粉钻开通外链（替换为 `about:blank`，该脚本本就依赖已不存在的 `pet://` 协议）。
- 删除死代码 `src/service/websocket.js`（`module.exports={}` 且全仓 0 引用，此前正是启动时静默注入失败的根源）。

### 修复

- **右键菜单"退出宠物"在跟随宠物模式下未被隐藏**：`index.js` 在 `followMain` 模式下会置 `menu[7].unShow=true`，但 CSS 从未定义 `.unShow` 规则（1.2.4 遗留），该菜单项一直可见。补上 `.unShow{display:none}`（与官方 1.2.5 规则一致）。

### 已知问题（新增）

- 新版钓鱼没有旧版的"免费饲料"按钮（官方 1.2.5 素材本身没有），cmd:10 分支不会触发，属预期。买苗/喂食/收获等交互链路已经 Ruffle 冒烟验证初始画面，深度交互建议实机再验。
- `fish_fry_table.json`（官方鱼苗原价表）未接入，商店沿用本项目调过价/调等级的内置表，避免改变游戏平衡。
