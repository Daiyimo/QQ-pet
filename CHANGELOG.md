# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

版本号说明：跟随 QQ 宠物怀旧服的上游版本线命名。本项目 fork 自 [qqpet_automation](https://github.com/xuemian168/qqpet_automation)，来源与许可见 `NOTICE.md`。

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
