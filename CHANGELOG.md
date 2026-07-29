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

### 已知问题

- **贴边动画不停在指定帧**：Ruffle 未暴露任何跳帧能力（无 `GotoFrame` 等价 API），`hideleft` / `hideright` 会整片播放而非停在 61/66/39 帧。需改素材或等 Ruffle 支持。
- **本地窗口仍保留 `webSecurity: false`**：后花园与钓鱼小游戏依赖跨源 iframe 的 `contentWindow` 直写（往远端 window 挂 `getPetInfoFromMain` / `saveInfoData` 等回调），强行收紧会直接废掉这两个功能。远程 URL 入口已隔离，彻底修复需先把那两处改为 `postMessage`。
- **`Alt+Q` 截图快捷键在 Windows 上无功能**：调用的是 macOS 的 `screencapture` 命令，且回调 `this` 丢失、成败判断反了。当前仅占用快捷键。
- `src/ini/` 与 `src/windows/` 下多数文件是 webpack 压缩单行产物，仓库内无对应源码，改动只能定点替换。
