# Ruffle 播放冒烟测试报告 — 新版 QQ 宠物 SWF 素材验证

- 日期：2026-07-29
- 环境：Electron 28（项目 node_modules 内）+ 项目内置 Ruffle `0.2.0-nightly.2026.4.6`（wgpu-webgl 渲染器，`src/windows/js/ruffle/ruffle.js`）
- 方法：隐藏 BrowserWindow（品红底 #FF00FF，webSecurity:false 与项目 `src/windows/window.js` 一致）加载 `player.html`（配置与 `src/windows/app.html` 相同：autoplay on / wmode transparent / letterbox off），逐个加载 SWF，2.5s 后截图 A、再隔 500ms 截图 B，像素方差判定渲染、帧间差异判定动；SWF 头 RECT 解析得舞台尺寸。
- 运行方式：`cd /e/project/qq_local && npx electron test/ruffleSmoke/run.js`

## 逐项结果

| # | SWF | 类型 | Stage 尺寸 | 渲染 | 动 | 备注 |
|---|-----|------|-----------|------|----|------|
| 1 | `QQ_NEW_SWF/.../1020000001/main/stand/normal/001.swf` | AS3（CWS v9, DoABC, 75帧@12fps） | 140x140 | ✅ | ✅* | *主测试中 2.5s~3.0s 两帧恰落在动画停顿段（diff=0%），`probeStill.js` 6s 复测确认多段帧间变化 3.6%~12.4%，确为"呼吸-停顿"式待机动画 |
| 2 | `QQ_NEW_SWF/.../1020000001/main/play/001.swf` | AS3（CWS v9, DoABC, 767帧@12fps） | 140x140 | ✅ | ✅ | 帧间变化 20.1%，举重动作，渲染完整 |
| 3 | `QQ_NEW_SWF/.../1020000001/main/walk/walk_left.swf` | AVM1 对照组（CWS v9, 无 DoABC） | 140x140 | ✅ | ✅ | 帧间变化 6.5%，对照组正常 |
| 4 | `qq_local/src/assets/Action/GG/Adult/happy/Stand.swf` | 老素材对照组（CWS v12, 含 DoABC） | 140x140 | ✅ | ✅ | 老素材本身也含 DoABC，一直由该 Ruffle 播放 |
| 5 | `QQ_NEW_SWF/.../1020000001/main.swf` | AS3 壳（CWS v9, DoABC） | 140x140 | ✅ | ✅ | 壳直接渲染出企鹅并有小动作（0.7%），ExternalInterface/加载子 SWF 的完整行为未测 |

判定阈值：亮度 stddev > 8 判"渲染成功"（未渲染时整屏品红 stddev≈0）；帧间变化像素 > 0.5% 判"动"。全部 5 个文件 `player.load()` 均 resolve 成功（`isPlaying=true`），无 Ruffle 报错。

## 截图（人工可查）

目录 `E:/project/qq_local/test/ruffleSmoke/shots/`：

- `1_new_stand_normal_001_AS3_a.png` / `_b.png` — 挥手企鹅，渲染正确
- `2_new_play_001_AS3_a.png` / `_b.png` — 举重企鹅，渲染正确
- `3_new_walk_left_AVM1_ctrl_a.png` / `_b.png` — 行走企鹅，渲染正确
- `4_old_happy_Stand_ctrl_a.png` / `_b.png` — 老素材企鹅，渲染正确
- `5_new_main_shell_AS3_a.png` / `_b.png` — 壳渲染出企鹅
- `probe_a.png` / `probe_last.png` — stand/001.swf 复测首末帧

## 总结论

**新皮肤接入可行。** 项目内置 Ruffle（0.2.0-nightly.2026.4.6）能正常渲染并播放新版 QQ 宠物素材，包括含 DoABC 的 AS3/AVM2 文件（stand/normal、play 及 main.swf 壳），AVM1 纯时间轴文件（walk）亦正常。对照组（老素材、AVM1）均通过。

可用素材范围（本次实测）：`main/stand/normal/`、`main/play/`、`main/walk/` 及 `main.swf`。未实测的目录（`stand/motion`、`turn`、`lead` 等）按同批同格式推断大概率可用，接入前可用本脚本（改 `run.js` 的 `TESTS` 数组）批量复测确认。

注意点：

1. `main.swf` 是壳，本次只验证其自渲染；若皮肤机制依赖壳内 AS3 通过 `Loader` 加载子 SWF 或 ExternalInterface 通信，需在接入阶段另做集成验证。
2. stand 类动画存在停顿段，做"是否在动"检测时应取 ≥2s 观测窗，避免误判。

## 临时文件清单（保留，勿删）

- `test/ruffleSmoke/run.js` — 主冒烟脚本
- `test/ruffleSmoke/probeStill.js` — 静止疑似项复测脚本（`npx electron test/ruffleSmoke/probeStill.js -- <swf路径> [秒数]`）
- `test/ruffleSmoke/player.html` — 测试页（引项目内置 ruffle.js）
- `test/ruffleSmoke/report.json` — 机读结果
- `test/ruffleSmoke/report.md` — 本报告
- `test/ruffleSmoke/shots/` — 全部截图

测试进程均自行 `app.quit()` 退出，使用独立临时 userData 目录，未触碰系统中其它 electron.exe 进程。
