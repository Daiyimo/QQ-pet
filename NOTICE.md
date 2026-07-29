# 来源声明与免责声明

## 项目来源

本项目 fork 自开源项目 [qqpet_automation / WorkBuddy](https://github.com/xuemian168/qqpet_automation)（MIT License，Copyright © 2026 xuemian168），并在其 `qq-pet-macos` 分支基础上继续开发。上游项目对 QQ 宠物怀旧服 v1.2.4 的 Electron 应用做了逆向分析、跨平台移植、遥测与设备指纹移除，以及 Ruffle WASM 替代 Adobe Flash。

本项目在此基础上新增的主要内容：云端多服务商 LLM 接入（OpenAI 兼容协议 / Anthropic）、屏幕感知、记忆与日记、课程录制、弹幕层、成就 / 签到 / 旅行系统、贴边隐藏、换肤路由。

按 MIT License 要求，上游版权声明已保留于本项目 `LICENSE` 文件中。

## 原始程序来源

本项目所基于的原始 Electron 应用程序**并非原创**，来源于公开互联网上流传的「QQ宠物怀旧服 v1.2.4」安装包，其著作权归原作者所有。对其进行解包与修改的目的限于：

1. 学术性逆向研究与通信协议分析
2. 跨平台兼容性移植
3. 移除遥测与设备指纹采集，保护用户隐私
4. 用 Ruffle WASM 替代已废弃的 Adobe Flash 插件，使应用在现代系统上可运行
5. 个人怀旧体验与文化存档

## 知识产权归属

以下知识产权属于**腾讯及其关联主体**所有或运营，本项目对其不主张任何权利：

- 「QQ」「QQ宠物」「QQ Pet」等名称、商标与商业标识
- QQ 宠物角色形象（宠物外观、服饰、配饰、表情）
- 游戏内美术资源（精灵图、动画帧、UI 素材、图标）
- 游戏内音频资源（背景音乐、音效）
- 游戏世界观、剧情文本、道具命名、属性数值等设计要素

## 免责声明

本项目是**个人逆向研究、桌面移植与怀旧存档**项目，**不属于腾讯官方产品**，与腾讯控股有限公司及其关联方**没有任何关联、隶属、授权或合作关系**。

本项目不提供任何游戏资源的分发，不用于商业用途。使用者应自行承担使用风险。

> This project is an independent reverse-engineering, desktop-port and archival effort related to "QQ Pet" (QQ宠物 Legacy v1.2.4). It is **NOT an official Tencent product** and is **not affiliated with, endorsed by, sponsored by, or in any way connected to Tencent Holdings Ltd.** or any of its subsidiaries.

## 第三方组件

- **Ruffle** — Flash Player 模拟器，MIT / Apache-2.0 双许可，见 `src/windows/js/ruffle/LICENSE_MIT` 与 `LICENSE_APACHE`
- **Vue 3** — MIT License
- **Ant Design** — MIT License
