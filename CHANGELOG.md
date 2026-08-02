# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

版本号说明：跟随 QQ 宠物怀旧服的上游版本线命名。本项目 fork 自 [qqpet_automation](https://github.com/xuemian168/qqpet_automation)，来源与许可见 `NOTICE.md`。

## [未发布]（第三轮 P1 清账）

README「第三轮审查确认、但尚未修复的问题」里约 30 条 P1 的集中清偿，共 **31 个提交**。测试 690 → **986**，全绿。

清账过程中新发现并修掉 **4 条 P0**，都不是审查列表里的条目，而是修前面几条时顺藤摸出来的：`setPetInfo` 传子集会抹掉未传的键（打工 / 上学 / 旅行状态每 60 秒被静默丢一次）、`floatStyle` 读档失败后的回写会用内置默认覆盖用户已存样式、IPC 帧校验的两个 fail-open 缺口、课程总结途中崩溃后恢复会导出无总结稿并把重试入口永久焊死。四条的共同形态是**上一批修复自己引入或没堵干净的洞**，这也是本节把「修复带来的新缺口」单独当作一类来记的原因。

### 破坏性变更

- **移除「小富翁」成就（`1ab186c`）—— 已解锁该成就的存档会看到成就从面板上消失**。本项目定位是离线 + AI 版不设资源门槛：新档默认 `yb: 999999999`、背包预置 878 件道具，这是由三处文档与一条既有测试共同确立的有意设计（审查中曾误判它是调试值遗留，`git log -S` 考证后确认不是）。而「小富翁」的判据是 `yb >= 10000`，在 9.99 亿开局下**开局即达成**，是 8 条成就里唯一被该定位废掉的（其余 7 条——孵化、等级 20、等级上限、养鱼 1000、环游中国、签到、在线 100 分钟——均完好）。
  选择移除而非改判据：查过存档结构，`info` 只有存量字段、`cache` 只有商城缓存而非消费流水，没有任何累计消费信号可复用；改判据要新增计数器 + 落盘 + 老档迁移 + 改压缩产物 `Goods.js` 的扣款路径，成本远超一条装饰性成就。
  **老存档不掉数据**：已解锁的 `achievements.rich` 记录不删、原样写回（保留历史痕迹），`check` 与 `getAll` 只遍历定义表，故面板不会出现未知成就、不报错、其它成就记录不丢。两条变异验证证明这不是恒真断言。渲染层是 `{{ unlockedCount }} / {{ list.length }}`，无硬编码总数，移除后自动显示 x/7。
- **远程网址窗隔离到独立 session（`be5a66e`）—— 升级后首次打开该窗，此前在其中登录过的站点会掉一次登录态**（旧 cookie 留在 `defaultSession`，新分区 `persist:remote-url` 是空的），之后照常持久保存。分区取 `persist:` 前缀而非内存 session 是刻意的：目标是与本地窗隔离，不是不留痕，内存 session 会让用户**每次**重开都掉登录态。
- **删除 `sys.visionProvider` 死键（`998aa2a`）**。全仓只有一处读、零写入点——设置页只 `saveProviders` + `llmActiveProvider`，从没有过视觉模型表单。于是 `resolveVisionProvider` 永远走 fallback 分支，每个开感知的用户都会吃到一条「记得在设置里配一个会看图的模型」的气泡，而那个设置**不存在**。选择删死键而非补 UI：为一个「和对话模型共用即可」的配置引入第二套配置面不划算。`reason` 收敛为 `chat` / `no-provider` / `no-key`，文案改为指向真实入口。
- **删除 `setPreload` IPC 入口（`60013c5`）**。它直接 `ipcMain.on` 裸注册、不过 `_guardIpc`，且天生拿不到 window entry、结构上无法被守卫。当前零调用，但任何人调一次就整体退回「70 条通道无发送方校验」，故删除而非包装。`removePreload` 用的是 `option.preloads`，不受影响。
- **删除 `createMain` 的 express 分支与 `.tools` 下两个一次性改价脚本（`7fe5098` / `0631994`）**。前者在生产中永不执行（唯一调用方 `doMain.js` 传 `none=true` 命中提前返回），只被一条测试撑着——改端口或挂载目录时改了活的那份、漏了死的那份，测试照样全绿。后者删前做了实证而非只看引用数：确认两者的数值全部能从在仓的 `goods_all_categories.json` 现算、效果已固化（`shop.toy` 8 条与官方一致、20 个粉钻商品价格逐一相符），留着会被误当作可重跑的工具，**重跑会二次改价**。

### 行为变更

- **深夜劝睡改为每晚只提醒一次，且跨重启不复发（`431b08a`）**。此前判定是 22 点后或 4 点前、冷却 60 分钟且无任何「每晚一次」上限与跨天重置——熬夜到 4 点会被劝 6 次，第二天照旧。
  去重键不能直接用日期：深夜窗口跨午夜，8 月 1 日 23:00 与 8 月 2 日 01:00 属于同一晚，用 `toDateString` 当键的话跨天后又会劝一次，**等于没修**。现构造「夜晚标识」——22:00–23:59 用当天日期，00:00–03:59 前移一天，跨月跨年由 `setDate(-1)` 自然处理（有 8-31 → 9-01 的用例钉住）。
  选择持久化而非纯内存：桌宠虽长驻，但更新、崩溃、手动重开都可能发生在深夜，「重启就再唠叨一次」是真实的烦人场景。单键覆盖写、不累积，无需清理逻辑；落盘失败降级为仅本进程去重并记堆栈。其他三类提醒（护眼、久坐、久别）的冷却与清零规则完全未动。
- **感知连续 3 次「配置性失败」会自动停用本进程的感知循环并销毁弹幕窗（`bf7cc45` / `998aa2a`）**。配置性 = 4xx 除 408/425/429（400 不支持图片、401 Key 无效、402/403 欠费、404 地址错）、未配置、缺 Key、地址错，以及 **HTTP 200 但 body 报图片能力错误**（不少 OpenAI 兼容网关正是这么报「模型不支持图片」的，此前被判成瞬时失败 → 无限退避重试、永不触发停用）。瞬时失败（408/425/429、5xx、socket hang up、timeout、JSON 解析失败）行为完全不变。
  停用时气泡带真实原因。**刻意不写 `sys.perceptionEnabled`**：那个开关值代表用户意图，且设置页缓存旧值会导致「点开启反而又关一次」。销毁弹幕窗是配套的：`loop.stop()` 只 hide，那个 `backgroundThrottling:false` 的全屏透明窗连同渲染进程会活到进程结束，而用户此时已无途径回收（设置页开关已被跳过）。
- **悬浮特效读档失败后，本次会话不再保存任何样式改动（`1e385d1`）**，并在 warn 文案里写明这层后果（用户需要知道这次的调整不会保存）。
- **剪贴板轮询从 200ms 回到 1000ms，并按 `clip` 开关启停（`5b0e04b`）**。200ms 即 5 次/秒、12 小时 216,000 次主进程同步 OS 读取。除 CPU 外有实际副作用：**Windows 剪贴板是独占资源**，高频 `OpenClipboard` 会让其他程序的复制粘贴间歇失败（Office 与远程桌面的经典症状）。`clipToCloud` 只是 `clip` 的子开关，`clip` 关掉时回调永不触发、两个消费者都死、定时器纯白跑，现按 `getSys` 的 `clip` 值实时启停。
- **台词链超时从 8s 提到 30s（`974d1a6`）**。8s 与它自己的 512 max_tokens 预算自相矛盾——注释明写「推理模型的 thinking 会消耗输出额度，需留足预算」，但 8 秒内推理模型出不完 thinking + 正文（对照：对话 60s、课程 120s、感知 30s，只有台词是 8s）。结果每次台词都：发请求 → 掐断 → **服务端已生成并计费** → 降级离线台词 + 一条全栈 error；且无失败退避，Key 失效时每个触发点都重打一次并刷一条堆栈。30000 等于 `providers.DEFAULT_TIMEOUT_MS` 与感知链，不引入第三个量级；未下调 512（砍掉会换成「只有思考内容」的另一种失败）。新增连续失败计数 + 5 分钟冷却 + 日志按次节流。
- **动画 finish 判定加了与素材无关的硬上界（`e9fe1e1`）**，超长动画的尾段会被提前截断。见下文「修复」里的 MM 幼年期生病动画。

### 修复

**P0 — 数据丢失（本轮新发现）**

- **`setPetInfo` 传子集时会抹掉未传的 `activeOption` / `activeValue` 键（`0197c53`）—— 打工 / 上学 / 旅行状态每 60 秒被静默丢一次**。这两个分支遍历的是内存键集合，却缺少兄弟分支（`info` / `maxInfo` / `otherOptions`）都有的「键缺失」守卫：调用方只传子集时未传的键 `r[t]` 为 `undefined`，而 `undefined != {对象}` 恒真，该键被赋成 `undefined` 并广播落盘，`JSON.stringify` 直接丢键。
  唯一传子集的调用方是 `dataWatcher`——它的 `pickChangedKeys` 会丢掉深度相等的引用类型键。于是宠物打工期间每 60 秒心跳都走一遍：心跳写盘 → watch 事件 → `work` 因深度相等被过滤 → `activeOption.work` 被抹成 `undefined`，进行中的打工 / 上学 / 旅行会话与 `ill` 状态静默丢失。
  判据取 `void 0 !== r[t]` 而非 `null != r[t]`：`activeOption` 的默认值就是全 `null`，`null` 是「已清空」的合法真值，挡掉它是新 bug。回归测试加载**真实** `pet.js`——既有的 `dataWatcher` 用例用的是桩 `setPetInfo`、从未与真实实现对接，正是它让这个缺陷假绿。
- **悬浮特效读档失败后，内置默认值会悄悄覆盖用户已存的全套样式（`1e385d1`）**。上一轮给运行期 `$Store.getItem` 失败加兜底时，判据取的是「读失败后紧接着要做的事是否具破坏性」。**这条判据只看紧邻语句，在 `floatStyle` 上判错了**：读失败后内存对象停在内置默认字面量、窗口照常打开（紧邻语句确实无害），但同一个 `created` 闭包里的**防抖回写**会把整个对象写回磁盘。用户随后按一次 `ALT+↑` 或点保存，2 秒后磁盘上原有的全套样式就被内置默认值覆盖，全程零提示。
  **修复前反而是安全的**：`getItem` 抛出会中断 `created`，`preloads` 从未注册，防抖函数永远调不到。等于把「窗口坏掉但数据安全」换成了「窗口能用但数据被悄悄吃掉」。现改为读失败置 `_readFailed` 标志、回写入口首行拒绝，判据注释订正为「该内存对象后续会不会被**整体回写**」。既有用例同样是假绿——桩 `setItem` 是空函数、从不记录写入，也没触发保存路径和 2 秒定时器。
- **课程总结途中崩溃的会话，恢复时会导出无总结稿并把重试入口永久焊死（`bf71b6a`）**。恢复路径的判据是「有没有 `summary_error`」，注释据此称 `finalizing` 且无 error 就是导出环节失败、沿用已有 summary 重导即可。**这个前提被结稿路径自己的顺序推翻**：status 是在 `await _generateFinalSummary` **之前**就置成 `finalizing` 落盘的。
  于是总结途中崩溃会留下 `finalizing` + 空 summary + `summary_error: null` 这个三件套，恢复时判成「不需要总结」→ 直接导出一份没有总结、也不写失败说明的 `README.md` 并置 `complete` → 此后 `recoverable()` **再也不会列出它**。用户那节课的总结永久丢失且不可重试，而 state 显示一切正常。判据改为「有没有真的产出过 summary」，收进模块级 `needsSummaryRerun` 单一真值。转写为空的会话不打 LLM（未配置服务商时不该被它拦住）。「summary 完好只重导出、不打 LLM」是防修过头的护栏用例。
- **记忆节流的单槽设计会让 12 MiB 归档从约 42 天塌缩到几天（`70973b8`）**。`activity` 的 120s 节流与 900s 去重都带「与上一条同场景」的前置条件，而 `last` **只有一个槽**。场景在 `game` / `other` 之间交替时（`sceneStabilizer` 连续 2 帧就翻面，看游戏实况视频是典型场景），每次 record 的场景都不等于上一次，两道闸门同时被跳过，每次都走一遍主进程同步 fsync。
  真正的代价不是 CPU：`events` 的轮转窗口是按「约 720 事件/天」标定的，实际可达 10 倍以上，于是 `generateDaily` 回补历史天时源数据已被轮转掉——**用户的记忆静默丢失**。改为按场景分槽的 Map，并给槽位加 LRU 上界（scene 来自 IPC / 感知结果，理论上可为任意串）。顺带修时钟回拨：`elapsed` 只做 `<` 比较，时钟往回调 N 秒后同场景事件被全部静默丢弃，现改为负值视为窗口已过期放行 + 一条 warn。

**P0 — 安全（本轮新发现）**

- **IPC 帧校验有两个 fail-open 缺口（`60013c5`）**。`_guardIpc` 上一轮落地时留了两处：① `try` 只包住 `event.senderFrame` 的**取值**，而 `WebFrameMain` 在帧已 dispose 时是**属性访问**才抛，后面 `frame.parent` / `frame.url` 三处访问都在 `try` 之外，异常会从 `ipcMain.on` 监听器逃到 `main.js` 的 `uncaughtException`（运行期只记日志不退出），该条 IPC 被静默丢弃，用户看到「某个操作没反应」；② `senderFrame` 返回 `null` 时 `if (frame)` 整块被跳过，**子框架校验与 app.html 校验双双失效直接放行，且一行日志都没有**——对承载 `http://127.0.0.1` iframe 的钓鱼 / 密室两窗，那两层是唯一防线（子框架与顶层帧共用同一 WebContents，第一层的 `event.sender` 比对拦不住）。
  两条合并收口：`senderFrame` 与 `parent`/`url` 在同一个 `try` 内一次性取完，抛异常与返回 `null` 都拒绝并 warn（带 channel 与窗口名）。误伤面已评估：存活的顶层帧恒可取，Electron 28.3.3 的类型声明里 `senderFrame` 非空、该分支实质不可达。
  **既有的不变量用例是纯源码文本断言、从不执行 `_guardIpc`——这正是三条缺陷漏掉的原因**。新增 6 条行为测试真实驱动守卫（含「正常顶层帧必须放行」，防止收紧过头），另加一条静态锚钉死 `ipcMain.on` 注册点唯一。

**安全纵深（清账）**

- **窗口工厂默认 `sandbox` 翻转为 `true`（`67d5a93`）**。此前 `sandbox:false` 是全局默认，19 个走工厂的窗口全部继承，渲染进程不受 OS 层沙箱约束——一个 Chromium 或 Ruffle-WASM 漏洞就是用户权限代码执行，`contextIsolation` 挡不住这一层。受影响面包括加载第三方皮肤 SWF 的主宠窗与承载 http iframe 的钓鱼、密室。
  先前担心「沙箱下 preload 会全坏」（本仓 preload 用 `eval("require")` 这种双模加载探针写法），核实结论是**不会**：从 `electron.exe` 28.3.3 二进制里挖出 `runPreloadScript` 的实现，它把 preload 源码包进 `(function(require, process, Buffer, …){…})`，`require` 是函数形参，而 `eval("require")` 是直接 eval、沿词法作用域链能解析到那个受限的 `preloadRequire`（白名单 electron/events/timers/url）。真 Electron 探针实测确认。
  逐个扫描 19 个 preload：只有 `main/preload.js` 用 `__dirname`/`Buffer` 并 require `fs`/`path`/`iconv-lite`/`pathGuard`（换肤素材路径解析），其余 18 个只 `require("electron")` 且只用 `contextBridge` + `ipcRenderer`。故默认改 `true`，主宠窗显式 opt-out。真机验证：既有 `runCspGuard` 冒烟 12/12 通过（其中 B2 走真实工厂 + 真实 preload 且未覆写 sandbox，即新默认下 preload 正常工作的实机证明）；另单独实测 Ruffle WASM 在 sandbox true/false 下渲染一致（stddev 32.82、changed 0.57%）。
- **约 70 条 IPC 通道补上发送方身份校验（`67d5a93`）**。不是当前可利用漏洞（子框架无 preload、`nodeIntegrationInSubFrames` 已移除），但单个渲染器一旦获得脚本执行，无需绕过 `contextIsolation` 即可用本窗 preload 的全部通道。
  三层校验，**刻意不做完整 URL 比对**——本应用 productName 含中文与加号，安装路径的 percent-encoding、盘符大小写、斜杠方向差异会让 URL 相等比对在真机上全线失败，而测试里用干净路径根本发现不了。改用：① `event.sender !== win.webContents` 的对象比对（注册在 created 闭包内，直接持有本窗对象，零字符串、天然免疫编码问题）；② 顶层帧校验（钓鱼/密室的 http iframe 与顶层共用 WebContents，第 1 层拦不住）；③ 只对 pathname 取末段再 `decodeURIComponent` 与 `app.html` 比，解析失败则跳过该层不误杀。三条拒绝分支各留一条带通道名与窗口名的 warn——校验一旦写错，表现会是「某个功能突然没反应」，没有日志就是不可诊断故障。
  顺带修一个真实的坑：`removePreload` 靠 `option.preloads` 去 `removeListener`，若存的是原始函数就摘不掉包装后的监听器，**窗口关了通道还活着**。
- **远程网址窗补装 session 权限门禁（`be5a66e`）**。隔离必须与门禁同时做：`installPermissionHandlers` 此前只对 `defaultSession` 调过一次，远程窗**今天恰好因为还在 `defaultSession` 里才被覆盖**。只加 `partition` 不补 handler，摄像头 / 麦克风 / 定位会回到 Electron 的默认放行，而且没有 Chrome 那样的权限气泡 UI——**隔离反而成了负收益**。故新增 `installRemoteSessionGuards` 把「权限门禁 + 下载观测」收成一处，并在造窗**之前**调用（顺序错了等于窗口先于门禁存在）；守卫装不上时回落 `defaultSession`（那里已有门禁），这是唯一的 fail-closed 出口。
  `will-download` 只落一条 warn 后放行系统保存框——默认行为本就是用户确认的对话框、不构成静默下载，直接 `preventDefault` 是把这个窗口的下载能力整个砍掉。日志只记 host 与文件名、不记完整 URL，避免直链 query 里的 token 落盘。「远程 session 与 defaultSession 逐项同策略」是防止隔离顺手放宽权限的核心断言。
- **日记配图 `daily-images/` 补磁盘上界，`downloadBuffer` 补回环门禁（`651d519`）**。README 承诺磁盘有上界并逐项列了 events 12 MiB 与课程约 520 MiB，唯独漏了日记配图：每次生成成功都新增一个文件，全库无裁剪，点 20 次最坏 500 MiB。现定为每天最多 3 张 + 全库 200 MiB 硬上界（同天重复生成属于对首图不满意的重试，留 3 张够挑）。
  `downloadBuffer` 无回环门禁而那个 URL 是**服务端返回的**，可指向内网 http 地址且重定向每跳不复查——SSRF 面。现复用 `providers.isLoopbackHost`（无第三份实现），**逐跳复查**（重定向是递归调用自身，门禁放在执行体开头），并把本跳协议作为下一跳的上游协议传下去，故 https 服务商返回 http 图片地址一律拒绝。本地服务商返回回环地址的图片仍可下载。
  同批还修了两条：`writeDailyImage` 先写图后写元数据、元数据失败留下孤儿（现失败即回滚删图并把原错误抛给调用方——选这个方向而非先写元数据，因为反向失败时若元数据删不掉会留下**指向不存在图片的悬空记录**，UI 会读到不可用条目，而孤儿图片只占字节、下次裁剪即回收）；`generateDaily` 与 `generateDailyImage` 无 in-flight 去重，调用方只有 300ms 防抖，用户右键点两次（间隔超过 300ms 人手可及）就是两次 120s 超时的 LLM 调用并发 + 后写覆盖先写 + 重复计费（现按 day 维护 in-flight Promise Map，成功与失败都清理，否则一次失败后当天永远无法重试）。

**正确性**

- **生病中止旅行仍照发奖励，且可循环刷元宝与省份（`453e94e`）**。`State.js` 的 `ill`/`dead` 分支无条件把档案 `activeOption.trip` 置 `null` 并弹「我不能旅游了」，但 `travel.js` 的 `_trip()` 是**内存优先**且 `finishTimer` 没被清。于是：旅游中因饥饿/清洁跌破阈值**自动**生病（无需用户操作）→ 到点仍 `finishTravel()` → 照发 mood+50 / yb+15 / 收集省份，取消被撤销。加重版：病好后立刻再点去旅游，`startTravel` 不先 `_clearTimers()` 就覆盖 `finishTimer`，旧计时器会结算新行程 = 秒完成，可循环。
  两件都做，因为修的是不同后果：只做「档案为权威」能堵住刷奖励，但**宠物会永久隐藏**——`State.js` 清 trip 后没人调 `_showMain()`，主窗口一直 hide 到重启。所以 `State.js` 必须真的通知 `cancelTravel({silent:true})`；而 `_trip()` 改为以档案为唯一权威是兜底，覆盖其他清 trip 的路径（右键停止状态、存档被改）。新增 `_petInfoReadable` 标志区分「档案里没 trip」与「档案读失败」，避免一次瞬时读失败吞掉进行中的旅行。
  同批另两条：`remainingMs` 无上界钳制，`init()` 只判 `>0` 就 `setTimeout` 而 `startTime` 来自不可信的历史存档——系统时间回拨一天 → 宠物隐藏 24 小时不结束（用户只会以为程序坏了）；回拨超 24.8 天 → 超过 2^31-1，Node 把延迟坍缩成 1ms → **立即结算白拿奖励，可反复**（现钳到 `min(duration, MAX_TIMEOUT_MS)`，`startTime > now` 视为存档异常并立即结算）。以及主窗口可见性有两个主人且状态位分叉：感知的 `_restoreFromGame()` 经 `aiWiring` 直接 `window.show()` 且不更新 `petMain.show` 标志，于是旅游期间关掉屏幕感知会让宠物出现在桌面、而 show 标志仍是 `false`（isStop/托盘/贴边逻辑按「隐藏」处理一个可见窗口）。现收敛到 `setMainWindowVisible` 单一入口，仲裁顺序：旅游态最高（期间任何来源的显示请求一律拒绝并留 warn）→ 感知次之 → 贴边最低且自动服从。
- **`cancelTravel` 移出 `if-else` 链（`af2b50c`）**。上一条把 `cancelTravel` 插在 `State.js` 的 `ill`/`dead` 分支里，但那个分支是 `if-else` 链，调用被放在 `trip` 那一支。于是档案里同时存在 `work` 与 `trip` 时只走 `work` 分支，`cancelTravel` 不被调用，**主窗口保持隐藏、宠物凭空消失**，要等 `finishTimer` 到点才发现档案已空。理论上两者互斥，但互斥校验只在 `travel.startTravel` 一侧，而 `State.doActive` 开工时并不清 `trip`——所以这个组合可达。
  现把调用移出为逗号表达式无条件执行，且**仍在 `setPetInfo` 之前**。顺序很关键：`_trip()` 以档案为权威，写档后再调只会拿到 `not_traveling`，隐藏的主窗口与 `finishTimer` 就没人收了——为此专门加了一条顺序回归。只搬了一个括号的位置，字节数不变。
- **`openai` 分支不做 API 版本段兼容，用户填不带 `/v1` 的地址永久 404（`974d1a6` / `712da3f`）**。DeepSeek / Kimi / 硅基流动等官网首页给的地址半数不带 `/v1`，用户填 `https://api.deepseek.com` 会打到 `/chat/completions` → 404 + HTML 错误页，表现为「测试连接失败」却查不出原因。`anthropic` 分支做了这个判断、还留了注释说明这个坑，`openai` 侧漏了。**而 9 个相关测试的 `baseUrl` 全部以 `/v1` 结尾，完整地绕过了这个 bug**——和 `ruffleBridge` 那条假绿是同一类：测试覆盖了不会出问题的形态。
  顺带修 `anthropic` 自己的潜在 bug：它原先写死 `endsWith("/v1")`，用户填 `/v2` 会拼成 `/v2/v1/messages`。`712da3f` 又补上第三种形态：用户把**完整 endpoint** 粘进 `baseUrl`（`https://x/v1/chat/completions`）时会拼成 `…/chat/completions/v1/chat/completions`。最终收敛为 `resolveEndpoint(baseUrl, type)` 三段优先级——末段已是本协议 endpoint 则原样返回、有 `/v{n}` 则拼 endpoint、否则补 `/v1`，两分支都只调它，**物理上不可能再出现两套口径**。新用例在传输层用本地 http 服务记录服务端实收路径，比拼装断言更强。
- **台词 JSON 无字段类型校验（`974d1a6` / `712da3f`）**。`extractJsonObject` 只保证「是 plain object」，`llm.js` 仅判 `tolk` 真值，调用方直接把它塞进气泡。模型把 `tolk` 写成 `{"text":"…"}` 或 `["…"]` 时（temperature 0.9 + 15 字约束下会发生），气泡正文与按钮文案变成 `[object Object]`。现加归一 + 限长，非字符串或空即视为解析失败走离线兜底。`712da3f` 还上了同批留的债：`normSpeakField`（llm.js）与 `str`（perception/loop.js）是逐字符同口径的两份实现，合并为 `jsonParse.js` 的 `normField`，`loop.js` 的 12 处调用点全部替换。
- **成就巡检读档失败不再误判为全部未解锁（`a618683`）**。`$Store.getItem` 的语义前几轮从「吞错返空对象」改成上抛（为堵住瞬时读失败被当成新宠物、用空存档覆盖的数据丢失），但非启动期的调用方没跟着改。`achievement.js` 的 60 秒巡检读失败会向上冒到 `aiWiring` 的 error 分支，本轮巡检丢失且**日志归因错**（看起来像 `aiWiring` 的问题）。更糟的是若有人「顺手」把它兜底成空表，成就就会被判为全部未解锁并重复发庆祝气泡，既刷屏又污染存档。现 `check` 读失败时明确跳过本轮（不判定、不庆祝、不落盘，下一轮读成功自动补上）；`getAll` 读失败时降级为单路渲染 `petInfo.info.achievements`——抛出去会让成就面板永远空白，因为上层只有 catch + warn。
- **运行期存档读取失败不再裸抛，按破坏性区分兜底与中止（`7a37a93`）**。处 1「重生为另一性别」：读 `pet.info.sex` 的 IPC handler 无 try，读失败直接抛，用户点了按钮没反应且无解释。关键风险是紧随其后的 `$Store.clear()`——**所以绝不能「读失败就按某个性别兜底继续」，那会清档后写错性别、把宠物永久变成另一个性别**。现加 try：记堆栈 + 气泡告知一次 + 短路掉 clear/setItem/relaunch/exit 四步；防重入锁在异常路径下仍会经末尾的 `setTimeout` 复位（用行为测试验证：失败后立即再点不重复执行、400ms 后再点能正常走通），否则按钮会永久失灵。处 2 `floatStyle` 读悬浮特效样式：异常被外层 catch 兜成一行 `console.log`，窗口创建失败且无提示，现回落内置默认 + 记 warn。
  两处处理方式相反，判断依据写进了各自注释并互相点名对方路径：**读失败后紧接着要做的事是否具有破坏性**。（这条判据随后被 `1e385d1` 证明不完整，见上文 P0。）
- **深夜劝睡先发送后标记，发送失败不再吃掉整晚唯一一次提醒（`0f10aff`）**。`431b08a` 的实现把 `_markLateNightDone` 放在 `_fireReminder` **之前**。离线兜底路径是同步调 `openSpeak` 的，主窗正在销毁 / 气泡队列异常时会抛——此时这一晚已被标记为「已劝过」**且已跨重启落盘**，用户整晚含次日凌晨再也不会被提醒，重启也不恢复。旧实现的 60 分钟冷却至少还会重试，新去重把这条退路一并堵死了。
  判定「发出去了」的标准取 `_fireReminder` 同步返回：离线路径同步返回即气泡已入队；AI 路径同步返回时请求已发出，其在途失败自带离线兜底，重发只会重复劝。**不用 `try/finally`——无论抛没抛都标记等于没修**。另补 `_markLateNightDone` 里 `setSys` 缺失的静默 return：真跑到这里意味着「跨重启不复发」整个失效（每次重启重新劝一遍）却查无线索。
- **`focusGuard` 的 30 秒 `setInterval` 补 `unref`，`stop()` 后在途台词不再弹气泡（`b06d0db`）**。同项目其他定时器（`aiWiring` 的引导轮询与成就巡检、courses 看门狗、dataWatcher 重建链、perception tick 链）都 unref 了，这条是遗漏。`_epoch` 代际校验与 `perception/loop.js` 已修过的同类缺陷一模一样：start/stop 各自自增，`_fireReminder` 捕获代际，then/catch 里过期则不弹；catch 的日志保留在校验之前，不静默。
- **MM 幼年期生病动画的 finish 回调永不触发（`e9fe1e1`）**。finish 判定式是 `a == e + (lastTimeCut||1) + 1`，而 MM 的 Kid 档配了 `sickOption:{opt:{lastTimeCut:600}}`。实测 `MM/Kid/Sick.swf` 是 101 帧 @12fps，该等式要求 `currentFrame = -500`，**任何帧序列都不可能命中**。同一个 600 也让「切下一动作」的兄弟判定不可达，幼年期生病后只能靠 power 抢占才换动作。核实过 `notNum` 不是豁免开关（它唯一的消费点只决定文件名带不带随机序号）。
  修法取与素材无关的硬上界（同 `EXIT_FALLBACK_MS` 的「不信任配置、直接给死线」写法），只在配置值不可达时钳制、单帧素材原样返回。**只把常量从 8 调大不算修——那只是把不可达点往后挪。**
- **钓鱼等待宿主注入超时不再静默（`986ec80`）**。`getUpLoad` 轮询 1000 次后静默退出（配 10ms 间隔即约 10 秒），`window.getPetInfoFromMain` 永不调用，界面停在无数据状态——用户只看到一个不动的界面，**日志里连一行放弃都没有**。两个数字都是裸字面量。现两个常量命名并派生出超时总时长（日志直接用它，改常量日志自动跟随），注释写明「两个常数相乘才是总时长」；放弃分支留 warn 并写清降级后的行为。核实过没有可复用的用户可见通道：宿主只往 iframe 注入了四个函数，本文件唯一的 UI 出口 `setPETEVENT` 是往 Flash 推 cmd 响应（需要游戏已握手，正是这里失败的前提），`window.alert` 在本文件被改写成只打日志。
- **`setPETEVENT` 的静默放弃用了模块级共享计数器（`af2b50c`）**：多次数据推送共用 30 次预算，前面用光后面全部直接丢弃、连重试都没有，且无日志。现改为闭包内独立计数，放弃时留 warn 写清哪次推送、什么字段被丢、旧值是什么。顺带把 `player.` 改成 `player?.`——`player` 尚未被 load 回调赋值时原来会在定时器回调里抛 `TypeError` 且连日志都没有，现在走重试。
- **启动期异常不再留僵尸进程（`5b0e04b`）**。`uncaughtException` 处理器刻意不退出进程，这对运行期孤立异常是对的（桌宠是长驻进程，不该因一次异常让用户的宠物消失），**但对启动期是错的**：此时既无窗口也无托盘，进程却活着并占用单实例锁，用户再点图标也起不来，只能去任务管理器杀且毫无提示。`createWindow` 的 try/catch 只挡同步抛出，异步路径（whenReady 之后的 microtask、service 异步 init）会绕过它。
  现用 `browser-window-created` 事件置一次性闭锁作为「窗口是否曾创建成功」的信号——这是 Electron 自身的事实，与 `doMain` 和窗口工厂的实现无关，且闭锁单向置位，退出流程关掉子窗后不会误判回启动期；另豁免抢不到单实例锁的第二实例。`unhandledRejection` 同样纳入。`showErrorBox` 同步阻塞且内部跑嵌套消息循环，弹窗期间定时器仍 tick——这个性质曾是 `aiWiring` 那个 P0 的触发路径，故弹窗返回后只有 `exit(1)`。EPIPE 仍完全静默。

### 性能

- **存档加内存镜像与写防抖（`b1ffce1`）**。`electron-store`（conf 10.2.0）的 `get` 每次都 `readFileSync` + `JSON.parse`，`set` 是读+合并+原子写，**全部同步执行在主进程**。稳态每小时约 240 次全文件读 + 60 次全文件写，12 小时约 2900 读 / 720 写。
  而 `dataWatcher` 的文件头注释声称「只传 `info`/`maxInfo`/`activeOption`，基本都是原始类型或 null」以避免引用比较造成回写——**这个假设是错的**：`pet.js` 的默认 `info` 里 `travel_china` 是数组、`achievements` 是对象，`setPetInfo` 用引用比较，`JSON.parse` 出来的新数组恒不相等，于是每次 reload 都被判为变更并再写一次，把每小时 60 次心跳写**放大成 120 次**。（这是本轮第三次遇到「注释断言了代码不做的事」，前两次都是 P0 的承重墙。）
  新建 `src/ini/storeCache.js`（压缩产物 `store.js` 里只留一行接入点，沿用 `pathGuard`/`ipcInputGuard`/`security` 的既定模式）。核实过「本进程是唯一写者」：全仓只有 `store.js` 引用 `electron-store`，无任何代码直写该 json。与 `dataWatcher` 的协调用 `reconcile` **逐键比对而非整表 invalidate**——能走到那里的变化绝大多数是本进程每 60s 的落盘回声，整表清空会把镜像收益全还回去；判定方向安全：判「不一致」最坏多读一次盘。只有 `pet` 键走防抖（设置页的性别重置是 `clear()` + `setItem` + `app.exit(0)`，而 `app.exit` 不触发任何 quit 事件）。**每小时全文件读 360 → 180、写 120 → 60**；崩溃语义：强杀或断电最多丢 5 秒内的属性衰减，绝不丢更早数据。
- **录课热路径去掉每 tick 重写 state（`0feddf3`）**。`appendTranscript` 每次都 `getState`（`readFileSync` + `JSON.parse`，含最多 40 条 keyframes）再 `statSync`，追加后 fsync，最后 `saveState` 原子写。**一节 1 小时网课 720–3600 次全量 `state.json` 重写、1440–7200 次 fsync，全部同步执行在主进程，录课期间桌宠动画周期性卡顿**。而 `saveState` 在这条路径上唯一作用只是把 `updated_at` 往前推。
  现给 recording 会话的 state 加内存缓存，按 20 次或 30 秒落一次：state 重写降到 120–180 次（降 83%–95%），fsync 降到 840–3780，并省掉每次的 `readFileSync`、`JSON.parse` 与 `statSync`。取舍能成立的关键事实：**`updated_at` 全仓只写不读**——裁剪排序用 `created_at`，看门狗用 manager 内存里的 `_lastCourseSignalAt`。所以崩溃最多丢最后 30 秒的 `updated_at`，而转写正文仍逐次 fsync，一个字都不丢。另加一条 repo 侧防线：缓存绝不会把 `recording` 写回覆盖 `finalizing`。
- **多块课程总结支持部分成功（`0feddf3`）**。此前串行 N 次 LLM 调用，任一块失败就丢掉前面所有块的提取结果，**重试从头再花钱**。现把块级结果存 `summary-chunks.json`（走既有 `atomicJson`，**刻意不放进 `state.json`**——那个文件在录课热路径与 `listSessions`、`recoverable` 里反复读写，掺进上千字符会把这些路径一起拖慢），按块自身内容做 sha1 指纹，所以转写增长或被裁剪后不会错拼旧段落。老会话无该文件时按 ENOENT 降级为全量重跑。
- **`recoverable()` 接上启动恢复的调用者（`0feddf3`）**。此前无调用者，崩溃遗留的 `finalizing` 会话永久滞留。现在构造函数挂一个 20 秒后的 unref 定时器，上界 3 个每次，串行执行，异常全被 catch 并记 error，**不可能阻断启动**。未配置服务商时需重跑总结的整批跳过且只留一条 warn，只差导出的照常恢复。
- **感知的 PNG 编码改惰性（`bf7cc45`）**。`captureScreen` 无条件 `toPNG()`，而「画面未变 / 在途中 / 不到心跳」这三个判定都在截屏**之后**。12 小时约 21,600 次，每次 10–30ms CPU。现改为记忆化惰性 getter，被丢弃的 tick 上完全不编码。未动 `toBitmap` 那 3.69 MB：唯一能减到 2.3 KB 的办法是先 resize 到 32x18 再取 bitmap，但那是插值平均而非点采样，会改变 `FrameChangeDetector` 的语义——阈值 18/0.03/3.0 是按点采样标定的，真要做得连带重标阈值与更新指纹测试，属独立议题。
- **存档体积检查与桌面导出上界改为用户可见（`70973b8` / `0feddf3`）**。`storeCache` 的 2 MB 体积检查只在启动期跑一次且只 `console.warn`——长会话内涨过阈值当场无感，且用户看不到，与刚修掉的「桌面导出目录上界只落日志」是同一个反模式。现改为 flush 成功后**每 20 次抽检一次**（不是每次都 `statSync`——那正是本模块要治的病），超阈值时按既有的每进程一次模式弹一次气泡。启动期那次检查跑在 `openSpeak` 挂上全局之前，故气泡标志位只在真的送达时置位，由下一次抽检补发。桌面导出侧复用课程互动已在用的气泡通道提示一次（进程内去重），**不删任何桌面文件**。

### 测试

- **测试数 690 → 984**。较大的几批：`focusGuard` 29 条（此前零覆盖）、`swfPet` 动画时序 32 条、感知失败分类 7 条、深夜劝睡与其失败路径、IPC 守卫行为测试 6 条、远程 session 6 条、课程恢复 4 条、打工上学以档案为权威 9 条。
- **`test/clipPrivacy.test.js` 是一条活的假绿（`986ec80`）**：用 `lastIndexOf` 加「距离小于 500」判断两个字符串在源码里的相对位置，**既不校验极性也不校验分支归属**——门禁写成相反的判断也会通过。这是隐私相关的断言，而 README 明确承诺「关掉后剪贴板播报仍可用，只是不出网」。
  现改为真实的行为测试：从压缩产物里按结构锚点切出剪贴板文本回调，核实它对外只有五个自由标识符、全部作为 `new Function` 形参注入即可真实执行，不需要 Electron。断言开关关闭时 LLM 调用 0 次、本地播报恰好 1 次且原文完整；开启时恰好 1 次上云且首参正确；`llmEnabled` 或 provider 缺一不出网；`clipToCloud` 为 `undefined`（老配置）按关闭处理。**极性变异实测对比：旧断言 pass 1 fail 0（这正是它假绿的证据），新断言 fail 3**；另有一条变异是在别处补一条没有门禁的上云调用——新断言红、旧断言仍绿。
- **`test/rootListen.test.js` 只做相对断言（`6ab27c5`）**：只断言尝试次数等于常量本身，把 `LISTEN_MAX_ATTEMPTS` 从 5 改成 6 测试照样全绿（实测复现）。现补一条值锁，两条并存——相对断言保护「确实按常量试满了」这个行为，值锁保护这个数字不被无意改动（它决定端口被占用时最多试几个端口，直接决定用户可感知的启动失败等待时长）。
- **`test/electronSecurityInvariants.test.js` 从 14 条增到 18 条**：新增「工厂默认 `sandbox` 必须为 true」「`sandbox` opt-out 清单恰好主宠窗 1 个」「`_guardIpc` 三层校验各自存在且拒绝时留日志」「反向断言：不许出现拼 URL 整串比对、必须 `decodeURIComponent`」「`ipcMain.on` 注册点唯一且无 `setPreload`」「`urlWindow` 的 `persist` 分区与『先装 session 守卫再建窗』的顺序」「第一方代码零 `new Function`」。
- **补测钉死「打工与上学以档案为权威」（`6d16df6`）—— 结论是不改代码**。排查 trip 缺陷时怀疑 work/study 同构，核实后确认不存在该缺陷：全仓 work/study 的唯一结算点是 `GrowUp.js` 的 `countdownActiveTime`，由 60 秒 tick 驱动、入参是当轮现读的档案；`GrowUp` 不持有任何内存副本，也没有绑定到打工上学的定时器；槽位为 `null` 时选活动的三元链得空串直接返回、不结算。第二道防线是生病期间整段倒计时被 `ill` 守卫跳过。也无离线补算。
  **与 trip 的根本差别**：travel 有进程内 `finishTimer` 加内存 `currentTrip` 缓存，档案被清了定时器照样到点结算——那才是 trip 缺陷的根因。所以保持口径一致的正确做法**恰恰是不加第二套取消机制**。这段推理写进了测试文件头注释，防止后人再同构地造一个 `cancelWork` 出来。变异验证里有一条特意复刻旧 travel 缺陷的形态（给 `GrowUp` 加「档案空则回落内存缓存」），确认对应断言会红而其余 8 条仍绿。
- 本节大部分修复都配了变异验证而非口头声称。有代表性的几条：深夜劝睡的 7 个变异全部被杀（含把夜晚标识退化成当天日期 → 5 条变红）；`focusGuard` 30 个变异 29 个变红，唯一存活的经论证是等价变异（`if (!wasActive)` 改成 `if (true)` 无可观测差异，块内三个条件全基于 `awaySec`，重复进入时必然处于活跃态，块退化为空操作）——**未按等价变异含糊处理，首轮暴露的两个真实覆盖缺口已补测并复测变红**；感知的「关键词不得误伤瞬时失败」判定表是配套护栏，正则改宽成 `/image|vision|图片/i` 时它必须变红，否则修完会变成误停用。

### 文档与注释

- **`src/service` 全量复核，订正 26 处「注释断言了代码并不做的事」（`fe51467`）**。本仓库一半源码是无 sourcemap 的 webpack 压缩产物，注释是唯一的导航工具，**注释准确性因此等同于代码正确性**——前几轮已有三处错误注释成了缺陷的承重墙（让人相信代码做了它没做的事，缺陷因此长期存活）。
  较有代表性的几处：`achievement` 的头注释列了「喂食/钓鱼/签到/旅游/升级」五个触发点，实际全仓只有 `aiWiring` 的 `check("timer")` 与 `travel` 的 `check("travel")` 两个，**签到那条纯属虚构**；`aiWiring` 写的感知事件名 `keyframe-requested` 全仓不存在，真名是 `keyframe-capture` 且由 `courseManager` 发出；`travel` 有五处（步骤顺序、别名主次、dirty 标志用途、「唯一权威」、`State.js` 归因）与实现不符，其中「显隐一律经此入口」在本服务自己就有四处绕过；`llm.js` 的三处数字口径（超时同值、字数余量、兜底文案）全部对不上。
  订正原则是**说清代码实际做什么以及为什么，不是删掉了事**。已知缺口如实写成缺口——`courses/manager` 的「当前实现不区分导出失败与总结崩溃」这类，写出来比一句漂亮的假话有价值。`imageGen` 的「配置缺失静默返回」判为改注释而非补日志：记忆配图是 opt-in，「未配置」是常态不是错误，为它打日志等于给从没用过该功能的用户刷噪音；真正需要可观测的「配了但不合法」「配了但读不出」两条本来就有日志。
- **`achievement.js` 与 `swfPet.js` 的两处过期头注释订正（`a618683` / `e9fe1e1`）**。前者原注释称 `achievements` 会被 `setPetInfo` 静默丢弃、只有 `$Store` 才是真正落盘，但 `pet.js` 的默认 `info` 表现在已含该键、`setPetInfo` 对对象走引用比较，赋值是生效的，**双写两路现在都是真存储**（变异验证钉住：把 `pet.js` 默认表里的 `achievements` 删掉，对应断言就红）。后者称「素材配置中最大为 5（bury）」「取 8 覆盖 cut ≤ 6 并留余量」都是错的，实测取值是 1 / 5 / 7（etoj、jtoc）/ 600，**8 实际是恰好覆盖 7、零余量**；新增的跨引用断言让注释与配置互校，不设第二份基准。
- **主进程日志前缀合规（`0631994` / `6ab27c5`）**。仓库根 `main.js` 的 `[启动]` 是中文标签（无法 grep 反查文件）、`[FATAL]` 不是模块路径，现定为 `[main]` 基准 + `[main/startup]` 启动子作用域——**拆两级的理由是启动兜底与运行期兜底行为相反（退出 vs 只记日志）**，分前缀可直接 grep 区分。随后发现 `src/windows/main/main.js` 的 8 处 `[main]` 与仓库根撞名，两个不同文件用同一前缀则 grep 反查失效——而「能 grep 反查到文件」正是 README 禁止中文标签的同一个理由，故改为 `[main/main]`。字节数 21594 → 21634（正好 8 个 `/main`），diff 只有含前缀的两行变动、零重排；`clipPrivacy` 的两个切片锚点未受影响，并用一个破坏锚点的变异证明那些断言不是恒真。
- **端口 33385 此前写了 4 份，其中一份硬编码进错误消息文案（`7fe5098`）**——改端口漏掉那处会输出与实际行为矛盾的日志，**把排查者带向错误方向**。现收敛为 `DEFAULT_PORT` 常量并加两道锁：文件内逐行扫源码（凡出现该数值的行必须是注释或那唯一一处 const 声明），跨文件读 `doMain.js` 的调用尾部正则捕获端口值与常量比对。实测把错误消息重新写死字面量会精确红 1 条。
- **`probeBridge.js` 的 30000 是陈旧口径（`0631994`）**（注释还说「30s 是硬兜底」，而生产兜底是 15000）。现改为 `require` 生产的 `EXIT_FALLBACK_MS` 而非再写一份字面量，并加「读不到常量就抛」的守卫——否则常量哪天改名会静默退化成 `undefined` 超时，**那就是一个新的假绿**。
- `app.exit(true)` 改 `app.exit(0)`（抢不到单实例锁是正常退出，布尔当退出码语义不明）；`indexOnline.html` 清掉残留的内网 IP 字面量（核实过它位于注释内、且 `root.js:21` 明文记载该远程加载分支已是死代码）；删掉从未使用的 `require("path")`。

### 已知未修（已同步 README）

- 存档 `config-qq-local.json` 的 `fishing.fishes` / 背包 / `achievements` 三个数组仍无上界——**有意未做**，裁剪要先回答「哪些鱼该留」以及「删掉的鱼算不算钓过」（影响成就与图鉴语义），是产品决策不是护栏。本轮只做到「涨大了让用户看见」。
- `memory/daily/` 的每日 markdown 与 `facts.json` 无上界（每天一份，增长极慢）。
- `setup` 的「重生为另一性别」正常路径里 `$Store.clear()` 之后紧跟的 `setItem("toSex")` 仍是裸调，抛错就是「已清档、未写 toSex」——这两步应作为一个事务处理。
- `State.doActive` 开工 / 上学时既不清 `trip` 也不校验互斥，`af2b50c` 只是给后果兜了底；应把互斥前置校验收敛进 `doActive`。
- `fishing/indexOnLine.js` 还有一处 `player.PETEventOnReceived` 是裸调（影片未就绪时抛未捕获 `TypeError`）。
- 崩溃留下 `recording` 状态的课程会话仍会永久滞留——`recoverable()` 按设计不含 `recording`，扩展其语义会与本轮 `updated_at` 的落盘精度耦合。
- `focusGuard._tick` 的三个前置守卫会静默 `return`，其中 `powerMonitor` 缺失与 `openSpeak` 未就绪属环境问题，长期不满足会让专注守护整体哑火且零日志。
- `src/windows/main/main.js` 还有约 12 条无前缀的 `console.log` 调试残留。
- **日志前缀规范没有任何自动化守卫**——`[main]` 撞名是靠人发现的，本该由一条扫 `src/` 下 error/warn 前缀的元测试自动抓到。相关地，`src/windows/main/shortcuts.js` 现存 3 处 `[快捷键]` 前缀，正是 README 逐字当作反面例子的那一个，是全仓仅存的中文前缀。
- 钓鱼 / 密室的 `webSecurity:false` opt-out 理由（跨源 `contentWindow` 直写）在 Electron 28 的进程级站点隔离下已不成立，**应当被移除而非保留**；彻底修复需改为 `postMessage`。待办：先跑一次 `node test/ruffleSmoke/runCspGuard.js` 把 C3 探针的实测输出记进 `report.md`，用实测替掉推理。



## [未发布]（第三轮后续：安全纵深与防回归）

补上第三轮审查列出的三条 P1。测试 656 → **690**，全绿。

### 安全

- **权限处理器缺失，恶意页面可无提示取用摄像头 / 麦克风 / 定位**：全仓 `setPermissionRequestHandler` / `setPermissionCheckHandler` 零命中，而 `tool/urlWindow` 的设计用途就是打开用户输入的任意网址；Electron 未设 handler 时默认放行多数权限请求，且**没有 Chrome 那样的权限气泡 UI**。新增 `src/ini/security.js`（多行模块，沿用 `pathGuard.js` / `ipcInputGuard.js` 的"逻辑独立成模块、压缩区只留接入点"模式），在 `main.js` 的 `createWindow()` 首行安装，先于 `init.js` 与任何窗口创建；装不上则走既有 FATAL 弹窗 + `app.exit(1)`（安全控制应 fail-closed）。
  **白名单为空（全 deny）**，依据已写进模块顶部注释：渲染层 `getUserMedia` / `navigator.mediaDevices` / `geolocation` / `navigator.permissions` / `IdleDetector` / `usb|bluetooth|serial|hid` 全部零命中；三个易误判点已逐个验证——屏幕感知走主进程 `desktopCapturer`、通知是主进程 electron `Notification` 而非 Web API、BGM 是 `new Audio()`、剪贴板上云走主进程 `clipboard` 模块，四者都不经渲染层权限。
  两处**已知会被拒且有意为之**（均留 warn 日志，非静默）：Ruffle 自带右键菜单的「全屏」（产品预期是窗口化；且给能打开任意网址的窗口放行全屏 = 给恶意站点无提示伪造全屏 UI 的能力）、Flash `System.setClipboard`。两个 handler 体内只调同一个 `isPermissionAllowed`，结构上排除"`navigator.permissions.query` 说 granted 而实际 request 被拒"的不一致。
- **图像服务商侧的 API Key 明文出网**：`memory/imageGen.js` 的 `buildEndpoint` 缺回环门禁，用户把图像服务商填成 `http://1.2.3.4:8080/v1` 会明文发送 `Authorization: Bearer` + 参考图 + 日记正文——而同一个用户在对话服务商填同样地址会被明确拒绝。现复用 `providers.isLoopbackHost`（惰性 require，与本文件既有模式一致，**未产生第二份回环判定实现**），错误文案与对话侧逐字对齐、仅加"图像"限定以便用户定位是哪个字段。本地 Ollama / LM Studio 的回环地址继续可用。

### 测试

- **新增 `test/electronSecurityInvariants.test.js`（14 条）—— 这批安全加固此前唯一的防回归缺口**：加固做了两轮，但对 54 个测试文件 grep `nodeIntegration|contextIsolation|webSecurity|Content-Security-Policy|setWindowOpenHandler` 全部零命中，唯一验证它们的是刻意不进 `npm test` 的手动 Electron 冒烟脚本 —— 把 `nodeIntegration:!0` 写回 `window.js` 或删掉 CSP meta，整套测试仍会全绿。新测试为纯 node、平台无关的静态断言：窗口工厂默认值、`webSecurity` opt-out 文件集合恰好 4 个（集合等值，第 5 个偷偷 opt-out 会红）、CSP 12 条指令与 `unsafe-*` 配对集合恰好 4 条已登记项、导航与新窗守卫、7 个危险开关零命中、`urlWindow` 隔离、`new BrowserWindow` 出现位置恰好 3 处、`eval` 只许 `eval("require")` 静态形式。
  关键设计：**先剥离注释再匹配** —— `window.js` 与 `app.html` 的注释里都复述了 `webPreferences:{webSecurity:!1}`，不剥离就会把注释误判成配置，这是本任务最大的假阳性陷阱。
  建立时做了 **24 个变异（全部按预期变红且只红对应用例）+ 6 个良性对照全绿**（重排 webPreferences 键顺序并新增键、给 img-src 加白名单主机、改窗口尺寸、**在注释里写 `nodeIntegration:!0` / `eval(code)` / `child_process` 散文**、改守卫日志文案、CSP 指令整体重排）。变异入口 `QQ_SEC_SRC_ROOT` 为覆盖层目录，故"新增第 5 个 opt-out 窗口"这类变异无需碰磁盘源码。
- 新增 `test/permissionHandler.test.js`（13 条）、`test/imageGenEndpoint.test.js`（7 条）。两者的变异验证各自暴露了一个我方指令未覆盖的缺口并被补上：前者发现**删掉 `main.js` 的接入行时全部测试仍绿**（模块会变成死代码），故补了接入点的结构与顺序断言；后者证明"Key 未出网"的方式是把 `http/https` 的 `request`/`get` 四个出网入口换成命中即抛的计数桩并断言 `deepStrictEqual(calls, [])`，回滚门禁后失败栈直接指到 `postBuffer`，把"没抛错"升级成"Key 真的会出网"的证据。

### 订正

- README「已知问题」的 `webSecurity` 条目此前称"壳窗另有 CSP meta"，**覆盖面被高估**：全仓 27 个 html 只有 `app.html` 与 `barrage/index.html`（后者是唯一零 `unsafe-` 的严格 CSP）带 CSP meta，而经 `http://127.0.0.1` 载入 iframe 的 `main/indexOnline.html`、`popups/fishing/indexOnLine.html`、`popups/backRoom/indexOnLine.html` **一个都没有** —— 它们恰好就在那 4 个 `webSecurity: false` 的窗口里。已作为独立的已知问题记入 README。
- `nodeIntegrationInSubFrames` 此前记作"已移除"不准确：它仍以 `nodeIntegrationInSubFrames: false` 显式存在于 `urlWindow`（语义安全，但字面不实）。相应的不变量断言因此写成"不许为真"而非"零命中"，否则会立刻假阳性。
- `sandbox:false` 那条的窗口统计口径补正：不走工厂的 `barrage` 窗（第 20 个）已经是 `sandbox: true`，不在"18 窗无必要"之列。
- 新记录一条本轮发现、未修的同类不对称：`imageGen.downloadBuffer` 无回环门禁，而那个 URL 是服务端返回的，可指向 `http://` 内网地址且重定向每跳不复查（不发 `Authorization`，故低一档）。



## [未发布]（第三轮深度评审修复）

第三轮七维度并行深度审查（Electron 攻击面 / 状态机与并发 / LLM 与网络层 / 代码质量合规 / 测试真实质量 / 未提交改动 / 性能与资源）。三个维度确认无 P0（Electron 攻击面、性能与资源、未提交改动），修掉 4 类 P0、8 个位置。测试 573 → **656**，全绿。约 30 条 P1 已记入 README「第三轮审查确认、但尚未修复的问题」，本轮未动。

### 修复

**P0 — 数据丢失**

- **`aiWiring` 的启动引导会用默认值覆盖整份 sys 存档（含加密的 API Key）**：`bootTimer` 拿 `getSys()` 当就绪探针，注释称"sys 未初始化时会抛 TypeError"。该前提是错的 —— `pet.js` 在模块加载期就把 `e.system` 赋成默认字面量，`getSys()` 无参时直接 `return e.system`，**永不抛错**。于是探针恒真，首个 tick 必定执行 `boot()`；而 `boot()` 第一件事就是写盘（`barrageEnabled` 默认值），此刻 `e.system` 仍是默认字面量，`setSys` 末尾无条件全量落盘，用户的快捷键 / 透明度 / 皮肤 / 免打扰 / `llmEnabled` / `perceptionEnabled` 与 `safeStorage` 加密的 API Key 一并丢失，无任何提示。
  可达路径不是"express 装载慢"（`doMain` 传 `none=true` 走同步分支，express 根本没启动），而是 **`dialog.showErrorBox` 的嵌套消息循环** —— 该弹窗同步阻塞但定时器仍在 tick，且恰好出现在 aiWiring 已 require 而 `setSys({init})` 尚未执行之时，即偏偏在用户存档已出问题、正在读错误提示的时候销毁其设置。
  现改为 `doMain` 在 `setSys({init})` 后置 `global.__sysReady`，探针只认该标志；`boot()` 首行加防御断言（未就绪一律不写 sys），堵的是不变量而非某条时序。

**P0 — 故障不可诊断**

- **屏幕感知的所有失败 100% 静默**：失败只经 `emit("perception-failed")` 外传，而生产端**零监听者**（EventEmitter 对无监听的非 error 事件静默返回 false）。用户开了感知但没配服务商 / 视觉回退到不支持图片的模型 / Key 失效，三种情况都表现为气泡说"屏幕感知开启啦"，此后永久截屏、永久失败、一行日志都没有 —— 全仓唯一一条用户完全无从察觉的链路。现补分级日志（未配置 / 缺 Key / HTTP 4xx 走 warn 带 message，其余含 5xx 走 error 带完整堆栈）+ 按次节流 + 连续失败超阈值时一次性气泡告知。
- **课程终稿总结失败静默且永久不可重试**：同样 emit 到零监听者，且随后照常把 status 置 `complete`，而 `finishSession` 对 `complete` 直接 return。桌面导出的 `README.md` 只有标题和关键帧、没有总结小节，state 却显示正常，日志一片干净。现补分级日志 + `state.summary_error` 留痕 + 导出稿显式写出"总结生成失败：<原因>"而非静默省略 + `recoverable()` 纳入该类会话允许重跑。
- 顺带修**结稿期的僵尸收养**：`finishSession` 此前同步清空 `currentSession` 后才 `await` 总结，期间 `state.json` 的 status 仍是 `recording`，用户在那 30~120 秒里切回课程会被 `findRecordingSession` 收养回正在结稿的会话，转写写进已被总结的 `transcript.md`（导出稿看不到），此后每轮感知抛 `session is not recording` 被上层降级成一条 warn，课程内容静默丢弃。现在任何 `await` 之前就原子落盘 `finalizing`。

**P0 — 测试假绿（5 处）**

- **`ruffleBridge` 的退场阈值比生产兜底松一倍**（最危险的一条，它守的正是本仓库最初那个"关桌宠卡住才被强杀"的 P0）：生产硬兜底是 15000ms，而注释与三条测试都写 30s，唯一时间断言是 `< 30000`。实测 91 帧 finish 于 14000ms（余量仅 1 秒），100 / 110 / 150 帧分别 15000 / 16000 / 19000，**全部越过生产兜底而测试照绿**。根因是 `finishAtMs` 第一项随帧数线性增长，故不止改数字：中段新增与素材无关的硬截止，使 finish 上界与 `numFrames` 解耦（300 帧实测 ≈11.9s，原 25s+），并建立 `EXIT_FALLBACK_MS` 单一真值 + 跨引用断言校验 `main.js` 侧的字面量与日志文案。**代价：单个动画超时长时尾段被提前，观感上动画截短。**
- `controlBarHover` 用例：单例在纯 node 下 `state` 为 undefined，所有分支判定都不成立，`changeState` 一次未被调用。
- `speakOptions` 成就用例：断言的是解锁数而非气泡数且循环体为空。
- `activeRecheck` 的 TOCTOU 用例：实为纯函数自调两次，未钉住"复检必须在 `activeIt` 早退之前"这个真正的修复点。
- `edgeHide` 整个文件是一个合成测试（0 个 `test()` / 21 条 assert）且关键断言包在 `if` 里，不产生位移就什么都不验。现拆成 21 条独立 `test()`。

以上每处修复均做**变异验证**：把被测行为回滚或极性反转，确认对应断言必然变红，而非口头声称。

### 订正

- **本轮发现至少四处「注释断言了代码并不做的事」，其中三处是缺陷的承重墙**（`aiWiring` 的就绪探针、`ruffleBridge` 的 30s 兜底、`dataWatcher` 的"只传原始类型或 null 以避免引用比较回写"—— 而默认 `info` 里 `travel_china:[]`、`achievements:{}` 就是数组和对象，引用比较恒不相等，导致每次心跳写被放大成两次）。本仓库一半源码是无 sourcemap 的 webpack 压缩产物、注释是唯一导航工具，故注释准确性等同于代码正确性。
- 下方第二轮小节的三处不实表述已就地更正：测试数、`openSpeak` 形状统一范围、`http://` 回环校验的覆盖范围。
- README 的 `Alt+Q` 已知问题描述过期（所述缺陷代码已不存在，现为不分平台的空实现）；测试数与"隔离方式"表述已订正（"不依赖 Electron"成立，但 7 个文件用真实临时目录、2 个起真实回环 HTTP 服务）。
- `main/main.js` 新增的中文日志前缀改为可 grep 反查的模块路径（`[退出]` → `[main/exit]`，`[重载]` → `[main/reload]`）。压缩产物出问题时前缀是唯一定位手段。

## [未发布]（第二轮深度评审修复）

第二轮三域并行深度评审（主进程与服务层 / 窗口与渲染层 / 安全专项与测试质量）确认约 30 项缺陷，本次全部修复。测试 502 → **573**，全绿。

复审追加（对上述修复再做一轮对抗性 review 后修掉的问题）：

- **aiWiring boot 引用已删除的局部变量 `sys`**：`getSys("barrageEnabled")` 简化时漏改下一行 `sys.perceptionEnabled`，导致感知自启静默失效（不抛错、无日志）。已改为 `getSys("perceptionEnabled")` 并补 boot 路径回归测试（test/aiWiring.test.js）。
- **getSys 对类型损坏的 sys 值抛 `TypeError`**：存档 `"sys"` 为合法 JSON 但真值原始类型（如 `5`）时 `t in e.system` 抛错。已加 typeof 守卫降级为返回 undefined，与旧实现的静默降级对齐。
- 测试注释漂移（speakOptions）与 signIn 内存兜底的重启边界说明、imageGen abort 未接线的已知边界，均已补注释。

### 安全

- **本地窗口 `webSecurity` 默认收紧为 `true`**：仅主宠窗 / smallGame / 钓鱼 / 密室 4 个窗口因 Ruffle 加载本地 SWF 或跨源 iframe 显式 opt-out（带注释说明理由），其余全部恢复默认安全基线（`src/windows/window.js`）。
- **壳窗补 CSP meta**：`app.html` 注入内容安全策略（兼容 Vue 模板编译的 `unsafe-eval`、Ruffle 的 `wasm-unsafe-eval`、钓鱼/密室 iframe 的 `frame-src http://127.0.0.1:*`）。
- **本地窗口统一导航 / 新窗守卫**：窗口工厂默认 `setWindowOpenHandler` deny + `will-navigate` 白名单仅放 app.html 初始 URL；此前除 urlWindow 外全仓无任何导航防护，老 Flash 页面的 `window.open` 会开出无守卫新窗。
- **`stateInfo_bus-upData` 渲染层 payload 全量透传 `setPetInfo`**：无白名单可写元宝 / 成长值等任意存档字段。现经 `ipcInputGuard.normalizeStateInfoUpdate` 逐字段校验，实测渲染层只发两种合法形态。
- **作弊快捷键（Ctrl+Shift+1/2/3/4 等改元宝 / 成长值）常驻发布版**：现仅 `--dev` 模式注册与响应，store 窗口的 shortcut 透传分支同步门控。
- **LLM 允许 `http://` 明文端点**：API Key 会随 Authorization 头明文上网。现 `http://` 仅允许回环地址（127.0.0.0/8、localhost、[::1]，即本地 Ollama / LM Studio 场景），非回环 http 明确拒绝（`providers.js`）。**订正（第三轮）：此校验只覆盖对话服务商。`memory/imageGen.js` 的 `buildEndpoint` 仍放行任意 `http://` 主机并照样发 `Authorization: Bearer`，同一漏洞在图像服务商侧原样存在，`isLoopbackHost` 已导出但未被复用。**
- 全部 19 个 preload 的 `ipcRenderer.on` 回调不再向渲染层透传原始 `IpcRendererEvent`（含 `sender`），统一包装为 `(_e, ...args) => cb(...args)`。
- `setup` / `smallGame` 两处 `v-html` 改为安全渲染（当前数据源为本地静态串，属"上膛枪"清理）。

### 修复

**数据安全**

- **签到可重复刷奖励**：`signIn.js` 的 `setSys` 落盘失败时奖励已发、状态读不回（`readState` 永不回退内存态），当天可重复签到。现内存态较新时优先内存态。
- **`$Store.getItem` 读键异常静默返回 `{}`**：`doMain` 以 `n?.info` 判新宠物，一次瞬时读错误（杀软占用等）会把老存档当新宠物并覆盖落盘，不可逆。现异常记日志后上抛，启动读档失败走既有的存档隔离 + 弹窗退出路径（`store.js` / `doMain.js`）。
- **`Goods.buy` 入库成功但扣款落盘抛错会"免费拿货"**：现扣款失败就地回滚背包快照并重新落盘。
- **`getPetInfo` 浅拷贝返回活引用**：调用方就改嵌套字段会绕过 `setPetInfo` 的 dirty 检查与落盘。现返回深拷贝（复用 `tool.js` 的 `JSONto`）。
- `addPetInfo` 只钳上限不钳下限，饥饿 / 心情可被扣成负数并持久化，现下限钳 0。

**功能**

- **`getSys(key)` 用 `||` 取值吞掉 `false`/`0`/`""`**：「默认开、显式关」的开关语义无法表达，此前靠两处读整个 sys 对象的 workaround 硬扛。现改为 `in` 语义，workaround 同步简化（`pet.js`、`aiWiring.js`、`perception/loop.js`）。
- **travel.init 与主窗口创建竞态**：恢复中的旅行期间宠物仍显示在桌面；关机期间结束的旅行丢失回家动画与气泡。现 init 经 `_whenMainWindowReady` 等待主窗口就绪（500ms 轮询 + 30s 超时兜底 + epoch 取消令牌）。
- **aiWiring 桥接丢 `course_title`**：感知层发出、记忆层接收的字段在桥接处被丢，课程观察为空时完全不落记忆。
- **自动课程会话在低置信期无限拖延**：自动结束依赖 `confidence ≥ 0.6` 的 activity 事件，屏幕持续模糊时永不结束。现自动会话挂 5 分钟沉默看门狗自动收尾。
- **focusGuard 无条件启动且 `stop()` 是死代码**：现按 `focusEnabled` 设置启停，设置变更实时联动。
- `llm.js` 人设 prompt 写「健康/10」而满值是 5，模型长期以为宠物半血；`openSpeak` 选项形状在成就 / 签到 / 旅游三个调用方补齐为 `{active, nextActiveStr}`。**订正（第三轮）：此前写作"在四个调用方统一"，实际仍有 5 处不传 `active`（`focusGuard` ×2、`courses/manager`、`perception/loop` ×2）。行为上无差异（`openSpeak` 内有 `active:n||"speak"` 兜底），但 `test/speakOptions.test.js` 自称"把这个约定钉死"而只钉了 3 处，属虚假信心。**
- `memory/store.js` 对非法 timestamp 抛 `RangeError`，现回退当前时间并记 warn；`imageGen` 补 AbortSignal 支持，在途图像生成可中止。

**Electron / 窗口杂项**

- `AppUserModelId` 由过于通用的 `"pet"` 改为 `"com.qqlocal.desktop"`（与 `build.appId` 一致）。
- 窗口工厂清理：删除恒 `undefined` 的 `height:this.height`、`openUrl` 死分支（含 80×80 loading 窗泄漏路径），魔法 `+10` 尺寸补偿补注释。
- fishing / backRoom 的 `webPreferences:{}` 空对象传参改为表意清晰的显式 opt-out。
- `screen.js` 的 `oneSize` 多屏下优先取鼠标所在屏，回退主屏。
- `level.js` 常量 `hour`（实为一天毫秒数）改名 `dayMs`；删除粉钻结算的 `console.log` 刷屏与 `signIn.js` 无前缀日志。
- 注释漂移修正：`ruffleBridge.js` 的「30s 硬兜底」（实为 15s）、`controlBarHover.js` 的过时 bug 描述。
- `localstorge.js`（零引用）匿名实例 + 空导出重写为正常导出并标注现状。
- 死代码桩 `request.js` 补「远程 API 已禁用」说明注释。

### 测试

- 新增 11 个测试文件 + 6 个既有文件追加用例（502 → 573）：签到内存态兜底、getSys/getPetInfo/addPetInfo 语义、getItem 异常上抛、http 回环校验、课程看门狗、travel 竞态（含 epoch 作废与超时兜底）、imageGen abort、stateInfo 守卫真实接线、preload event 剥离全量、buy 回滚、作弊门控、openSpeak 形状钉死。
- 新增 `test/ruffleSmoke/runCspGuard.js` Electron 冒烟：真实 app.html + 窗口工厂 + 真实 SWF，验证 CSP 下 Ruffle 正常渲染与播放、webSecurity 默认 true / opt-out false 生效、https 与 file 顶层导航被拦、`window.open` 被 deny、127.0.0.1 iframe 在 `frame-src` 下正常加载。12/12 通过。
- `test/storeCorrupt.test.js` 与 `test/storeBagLeft125.test.js` 各有一处断言钉的是本轮被修复的旧行为（getItem 吞错返回 {}、preload 直传 event），已更新为新契约。

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

### 第二轮深度审查（安全加固 + 健壮性，P0/P1/P2 全清）

四个域（主进程安全 / service 层 / 宠物核心逻辑 / UI 渲染层）并行深审后修复，又经原审查代理逐条复核、补修漏网项。测试维持 **502** 全绿。

**安全**

- **钓鱼/密室窗口 iframe 子框架开启 Node 集成（P0，RCE 面）**：`nodeIntegrationInSubFrames:true` 叠加 HTTP 协议子框架，SWF 经 Ruffle `getURL` 把框架导航到远程页面即可在带 Node 的环境执行。该标志是纯遗产（iframe 通信走 cookie+DOM，已验证零 `require`/`ipcRenderer` 引用），已删除。
- **礼包领取信任渲染层 payload**：发放物品取自 IPC 自带的 `type_Key` 且不复检领取状态，重发 IPC 可无限刷任意物品。现改为服务端列表内的 `type_Key` 发放，并正向判定 `isTake===1` 才放行。
- **设置项写入无白名单**：`setup` 的 `setSys` 通用路径可写任意 sys 键并持久化。现按设置页实际声明的 15 个键收敛（radio/slider/select/input 四条路径全覆盖）。
- **LLM 错误信息脱敏补齐**：HTTP 错误体、响应解析失败体、`parsed.error.message` 共 6 条路径统一过 `redact`，API Key 不再可能落日志；`postJson` 拒绝 URL 内嵌凭据（对齐 `imageGen`）。
- **本地静态服务收窄**：express 从整 `src/` 目录收窄到实际使用的 3 个子目录（fishing/backRoom/ruffle），真实 HTTP 冒烟验证该 200 的 200、源码路径 404。
- 删除 `disable-site-isolation-trials`（PepFlash 遗留，Ruffle 不需要）与 `ELECTRON_DISABLE_SECURITY_WARNINGS`；`urlWindow` 补 `will-navigate` 白名单、opacity 钳制 [0,1]；`doTypes.js` 重建 DOM 剔除 `on*` 属性与 `javascript:` 链接；floatStyle 鼠标跟随字符改 `textContent` + 主进程截断（原可持久化任意 HTML）；backRoom 遗留 `cmd.js` 的 `window.open` 加 http/https 白名单；`openUrl` 辅助窗补显式收紧 webPreferences；`window.js` 的 HTML 注入改 `JSON.stringify`（此前 HTML 含反引号/`${` 即全窗口白屏甚至被求值）。
- 粉钻续费参数（天数/成长值）主进程校验；infoCard 宠物名/主人名主进程截断 + 过滤控制字符；`writeDailyImage` 文件名拒绝 `..`。

**健壮性**

- **动画切换竞争期动作被永久丢弃**：`swfPet.changeSwf` 重试时把 option 本体当 `{option,backFn}` 解构，每次切换都重放一次失败。一行包装修复。
- **9 个遗留窗口 `doClose`/`doHide` 不判空**：`onclose` 置 null 后与渲染层 close IPC 竞态，二次触发在主进程抛 `TypeError`。统一补判空（含 control 的 `isDestroyed` 守卫、tip 的 `setPosition`）。
- **手动「结束课程记录」无反馈**：`finishSession` 前半段裸抛 → 主进程 unhandledRejection；补双层 try/catch 兜底，失败时气泡告知用户。
- **旧明文 API Key 可能永不迁移**：`_legacyMigrateTried` 在尝试之前置位，sys 未初始化时迁移抛出后进程内不再重试。标志位移到迁移成功之后。
- **移动 IPC 载荷全链路校验**：`doMovePosition` 此前零校验（高频 mousemove 通道），非数组/非有限数 payload 可在 ipcMain 处理器内抛异常。
- 数值与边界：y 轴钳制不再错用宽度、`app.exit([!0])` 退出码修正、多显示器尺寸改边界并集并监听显示器变化、粉钻每日结算 `growthValue` 恒被改写为 20 的兜底错误修复（level.js 与 GrowUp.js 内嵌副本同步）、`travel.js` init 幂等 + 启动时补偿重写丢失的收集进度、退出期 `setSys/setCache` 恢复落盘（免打扰状态重启后不再复活）。
- 清理：`word.js` 死文件、`getBuyGoodsOrder`/`lastCourseResult` 死代码、macOS `screencapture` 残留、剪贴板轮询加 `readFormats` 预检、快捷键注册失败告警、非法 timestamp 事件不再产出 `NaN` 进 prompt、`generateDaily` 入口校验 day。

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
