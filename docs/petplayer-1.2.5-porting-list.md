# 官方 1.2.5 → QQ_pet 可移植内容完整清单

比对双方：`1.2.5/app/dist/pet/`（官方 1.2.5 逆向提取，3070 个文件） vs `QQ_pet/src/assets/`（本项目，3608 个文件）。
方法：先按相对路径 diff，再对路径不同的文件做 MD5 内容比对，剔除"改名/移动"造成的假差异。

## 总览

| 类别 | 数量 | 说明 |
|---|---|---|
| 两边完全一致 | 2251 | 无需处理 |
| 改名/移动但内容相同 | 605 | 本项目已有，无需搬 |
| **1.2.5 真正新增** | **203** | 本项目没有任何路径下的同内容文件 |
| 同名但内容有更新 | 11 | 1.2.5 里的版本更新过 |
| 配置 JSON | 12 | 已解密，本项目无对应数据 |
| 新增文案 | 504 | 见附带的 `zh_new_125.txt` |

---

## 一、真正新增的素材（203 个文件）

### fishing/（71 个）

新版钓鱼全套（主程序、背景、32 种鱼、宠物甩竿动作），本项目无钓鱼素材，可整体引入。

- `fishing/config.xml`（539 字节）
- `fishing/main - 副本.swf`（324,073 字节）
- `fishing/main.swf`（324,062 字节）
- `fishing/res/bg/1.swf`（46,450 字节）
- `fishing/res/bg/dialog20110503.swf`（40,079 字节）
- `fishing/res/fish/1.png`（5,225 字节）
- `fishing/res/fish/1.swf`（17,768 字节）
- `fishing/res/fish/10.png`（5,406 字节）
- `fishing/res/fish/10.swf`（29,376 字节）
- `fishing/res/fish/11.png`（5,471 字节）
- `fishing/res/fish/11.swf`（18,771 字节）
- `fishing/res/fish/12.png`（6,131 字节）
- `fishing/res/fish/13.png`（5,159 字节）
- `fishing/res/fish/13.swf`（11,720 字节）
- `fishing/res/fish/14.png`（5,815 字节）
- `fishing/res/fish/14.swf`（20,115 字节）
- `fishing/res/fish/15.png`（5,526 字节）
- `fishing/res/fish/15.swf`（20,949 字节）
- `fishing/res/fish/16.png`（5,767 字节）
- `fishing/res/fish/16.swf`（24,710 字节）
- `fishing/res/fish/17.png`（6,026 字节）
- `fishing/res/fish/17.swf`（18,406 字节）
- `fishing/res/fish/18.png`（6,073 字节）
- `fishing/res/fish/18.swf`（22,192 字节）
- `fishing/res/fish/19.png`（5,596 字节）
- `fishing/res/fish/19.swf`（31,303 字节）
- `fishing/res/fish/2.png`（4,784 字节）
- `fishing/res/fish/2.swf`（17,135 字节）
- `fishing/res/fish/20.png`（5,047 字节）
- `fishing/res/fish/20.swf`（18,462 字节）
- `fishing/res/fish/21.png`（4,789 字节）
- `fishing/res/fish/21.swf`（15,370 字节）
- `fishing/res/fish/22.png`（4,847 字节）
- `fishing/res/fish/22.swf`（13,543 字节）
- `fishing/res/fish/23.png`（5,285 字节）
- `fishing/res/fish/23.swf`（17,005 字节）
- `fishing/res/fish/28.png`（5,203 字节）
- `fishing/res/fish/28.swf`（22,335 字节）
- `fishing/res/fish/29.png`（5,658 字节）
- `fishing/res/fish/29.swf`（14,606 字节）
- `fishing/res/fish/3.png`（4,934 字节）
- `fishing/res/fish/3.swf`（23,074 字节）
- `fishing/res/fish/30.png`（5,673 字节）
- `fishing/res/fish/31.png`（6,186 字节）
- `fishing/res/fish/31b.swf`（18,040 字节）
- `fishing/res/fish/32.png`（6,513 字节）
- `fishing/res/fish/32.swf`（35,693 字节）
- `fishing/res/fish/33.png`（1,919 字节）
- `fishing/res/fish/33.swf`（18,129 字节）
- `fishing/res/fish/34.png`（3,074 字节）
- `fishing/res/fish/34.swf`（23,200 字节）
- `fishing/res/fish/4.png`（5,073 字节）
- `fishing/res/fish/4.swf`（21,160 字节）
- `fishing/res/fish/5.png`（6,111 字节）
- `fishing/res/fish/5.swf`（46,493 字节）
- `fishing/res/fish/5ab2794a86f055373584eabba90ca4d9.png`（118,156 字节）
- `fishing/res/fish/6.png`（5,012 字节）
- `fishing/res/fish/6.swf`（17,642 字节）
- `fishing/res/fish/7.png`（5,388 字节）
- `fishing/res/fish/8.png`（5,683 字节）
- `fishing/res/fish/8.swf`（21,409 字节）
- `fishing/res/fish/9.png`（5,946 字节）
- `fishing/res/fish/9.swf`（21,530 字节）
- `fishing/res/litter/1.png`（7,402 字节）
- `fishing/res/litter/2.png`（9,485 字节）
- `fishing/res/pet/102.swf`（111,394 字节）
- `fishing/res/pet/103.swf`（115,203 字节）
- `fishing/res/pet/112.swf`（107,547 字节）
- `fishing/res/pet/113.swf`（113,334 字节）
- `fishing/res/pet/122.swf`（102,857 字节）
- `fishing/res/pet/123.swf`（105,167 字节）

### img_res/（52 个）

界面图片资源（按钮/面板/图标等 UI 素材）。

- `img_res/background/xfpng/b0000000.png`（149,160 字节）
- `img_res/background/xfpng/b0000001.png`（393,398 字节）
- `img_res/background/xfpng/b0000002.png`（315,381 字节）
- `img_res/background/xfpng/b0000003.png`（301,912 字节）
- `img_res/background/xfpng/b0000004.png`（323,947 字节）
- `img_res/background/xfpng/b0000005.png`（312,464 字节）
- `img_res/background/xfpng/b0000006.png`（351,474 字节）
- `img_res/background/xfpng/b0000007.png`（325,715 字节）
- `img_res/background/xfpng/b0000008.png`（274,188 字节）
- `img_res/background/xfpng/b0000009.png`（314,592 字节）
- `img_res/background/xfpng/b0000010.png`（205,687 字节）
- `img_res/background/xfpng/b0000011.png`（170,380 字节）
- `img_res/background/xfpng/b0000012.png`（197,752 字节）
- `img_res/background/xfpng/b0000013.png`（274,626 字节）
- `img_res/background/xfpng/b0000014.png`（209,582 字节）
- `img_res/background/xfpng/b0000015.png`（199,065 字节）
- `img_res/background/xfpng/b0000016.png`（185,089 字节）
- `img_res/muns/growth.png`（1,576 字节）
- `img_res/skin/GG/Adult.png`（5,096 字节）
- `img_res/skin/GG/Audilt.png`（5,096 字节）
- `img_res/skin/GG/Egg.png`（5,739 字节）
- `img_res/skin/GG/Kid.png`（4,568 字节）
- `img_res/skin/MM/Adult.png`（6,046 字节）
- `img_res/skin/MM/Egg.png`（5,658 字节）
- `img_res/skin/MM/Kid.png`（5,391 字节）
- `img_res/toy/t0001.png`（1,055 字节）
- `img_res/toy/t0002.png`（3,467 字节）
- `img_res/toy/t0003.png`（715 字节）
- `img_res/toy/t0004.png`（1,175 字节）
- `img_res/toy/t0005.png`（2,164 字节）
- `img_res/toy/t0006.png`（1,675 字节）
- `img_res/toy/t0007.png`（2,112 字节）
- `img_res/toy/t0008.png`（2,179 字节）
- `img_res/toy/刷子.png`（3,035 字节）
- `img_res/toy/哑铃.png`（2,926 字节）
- `img_res/toy/喷壶.png`（2,746 字节）
- `img_res/toy/夹子.png`（2,750 字节）
- `img_res/toy/小老鼠.png`（3,049 字节）
- `img_res/toy/手巾.png`（2,478 字节）
- `img_res/toy/手机.png`（809 字节）
- `img_res/toy/拳套.png`（3,894 字节）
- `img_res/toy/樟脑.png`（2,457 字节）
- `img_res/toy/气泡.png`（2,402 字节）
- `img_res/toy/烟花.png`（1,392 字节）
- `img_res/toy/瓶子.png`（3,238 字节）
- `img_res/toy/糖果.png`（2,802 字节）
- `img_res/toy/绳子.png`（3,307 字节）
- `img_res/toy/羽毛.png`（2,191 字节）
- `img_res/toy/蓝色MP3.png`（572 字节）
- `img_res/toy/足球.png`（2,399 字节）
- `img_res/toy/铃铛.png`（3,288 字节）
- `img_res/toy/银环.png`（2,279 字节）

### windowTip/（30 个）

窗口气泡提示素材（1.2.5 新的提示样式）。

- `windowTip/alert/bg.png`（53,076 字节）
- `windowTip/game/bg.png`（21,527 字节）
- `windowTip/game/guanbi_00.png`（4,012 字节）
- `windowTip/game/guanbi_01.png`（3,976 字节）
- `windowTip/game/guanbi_02.png`（3,973 字节）
- `windowTip/normal/beijing1.bmp`（312 字节）
- `windowTip/normal/beijing2.bmp`（11,520 字节）
- `windowTip/normal/beijing3.bmp`（292 字节）
- `windowTip/normal/beijing4.bmp`（3,936 字节）
- `windowTip/normal/beijing5.bmp`（3,312 字节）
- `windowTip/normal/beijing6.bmp`（144 字节）
- `windowTip/normal/beijing7.bmp`（4,560 字节）
- `windowTip/normal/beijing8.bmp`（140 字节）
- `windowTip/normal/bg.bmp`（70 字节）
- `windowTip/normal/btn_close1.png`（3,796 字节）
- `windowTip/normal/btn_close2.png`（3,747 字节）
- `windowTip/normal/btn_close3.png`（3,816 字节）
- `windowTip/sweetHeart/sweetHeart.png`（278,825 字节）
- `windowTip/vip/Q_01.png`（360 字节）
- `windowTip/vip/Q_02.png`（4,305 字节）
- `windowTip/vip/Q_03.png`（353 字节）
- `windowTip/vip/Q_04.png`（1,096 字节）
- `windowTip/vip/Q_06.png`（1,112 字节）
- `windowTip/vip/Q_07.png`（384 字节）
- `windowTip/vip/Q_08.png`（946 字节）
- `windowTip/vip/Q_09.png`（336 字节）
- `windowTip/vip/bg.bmp`（70 字节）
- `windowTip/vip/btn_closedefault.png`（4,030 字节）
- `windowTip/vip/btn_closehover.png`（4,405 字节）
- `windowTip/vip/btn_closepress.png`（4,063 字节）

### Menu/（22 个）

菜单/地图相关图片。

- `Menu/ditu01~1.png`（224 字节）
- `Menu/ditu02~1.png`（587 字节）
- `Menu/ditu03.png`（286 字节）
- `Menu/ditu04.png`（122 字节）
- `Menu/ditu04_2.png`（755 字节）
- `Menu/ditu04_22.png`（737 字节）
- `Menu/ditu04_new.png`（528 字节）
- `Menu/ditu05.png`（121 字节）
- `Menu/ditu05_2.png`（131 字节）
- `Menu/ditu06.png`（133 字节）
- `Menu/ditu06_2.png`（163 字节）
- `Menu/ditu06_jiantou00_2.png`（358 字节）
- `Menu/ditu06_jiantou01_2.png`（379 字节）
- `Menu/ditu06_jiantou01_22.png`（366 字节）
- `Menu/ditu06_jiantou02_2.png`（371 字节）
- `Menu/ditu07.png`（307 字节）
- `Menu/ditu08.png`（136 字节）
- `Menu/ditu09.png`（273 字节）
- `Menu/fengexian.png`（254 字节）
- `Menu/xf02.png`（128 字节）
- `Menu/xf03.png`（135 字节）
- `Menu/xf11.png`（147 字节）

### email/（11 个）

邮件系统素材（本项目无邮件功能）。

- `email/bg_01.png`（550 字节）
- `email/bg_03.png`（554 字节）
- `email/bg_09.png`（469 字节）
- `email/bg_10.png`（766 字节）
- `email/bg_8.png`（773 字节）
- `email/notice_title.png`（3,644 字节）
- `email/shuaxin00.png`（3,743 字节）
- `email/shuaxin01.png`（3,274 字节）
- `email/shuaxin02.png`（3,279 字节）
- `email/uyj.png`（1,278 字节）
- `email/yj.png`（1,300 字节）

### shppingMall/（5 个）

商城（本项目对应目录叫 `shop`，这 5 个是 1.2.5 新增商品/界面图）。

- `shppingMall/add.svg`（5,725 字节）
- `shppingMall/cut.svg`（5,301 字节）
- `shppingMall/left.svg`（540 字节）
- `shppingMall/menu/lmenu_31.png`（1,048 字节）
- `shppingMall/right.svg`（565 字节）

### talk/（4 个）

对话气泡 SWF（4 个朝向变体）。

- `talk/1/talk.swf`（17,310 字节）
- `talk/2/talk.swf`（16,104 字节）
- `talk/3/talk.swf`（16,808 字节）
- `talk/4/talk.swf`（16,415 字节）

### control/（3 个）

控制条素材。

- `control/icons/game.svg`（2,127 字节）
- `control/icons/gonggao00.png`（3,709 字节）
- `control/icons/juanzhou00.png`（3,926 字节）

### Action/（2 个）

动作动画（详见下方备注）。

- `Action/GG/Adult/happy/Stand - 副本 (2).swf`（40,801 字节）
- `Action/MM/Adult/happy/swfData.js`（209,992 字节）

### community/（1 个）

社区功能素材。

- `community/icon.png`（7,004 字节）

### face/（1 个）

变装/脸型素材。

- `face/click.svg`（1,985 字节）

### reset/（1 个）

重置/领养（`Adopt.swf`）。

- `reset/Adopt.swf`（145,634 字节）

> 备注：`Action/GG/Adult/happy/Stand - 副本 (2).swf` 和 `fishing/main - 副本.swf` 是官方打包时误带进去的资源管理器副本文件，搬的时候跳过。

---

## 二、同名但 1.2.5 有更新（11 个）

| 文件 | 说明 |
|---|---|
| `Action/GG/Adult/happy/Stand.swf` | 成年公宠站立动作更新 |
| `Action/GG/Kid/play/P61.swf` | 幼年公宠玩耍动作更新 |
| `Action/MM/Kid/play/P60.swf` | 幼年母宠玩耍动作更新 |
| `Menu/ditu00.png` | 地图图片更新 |
| `Menu/ditu01.png` | 地图图片更新 |
| `Menu/ditu02.png` | 地图图片更新 |
| `game/QQ狩猎场.swf` | 小游戏更新版本 |
| `game/QQ飞车.swf` | 小游戏更新版本 |
| `game/宠爱QQ堂.swf` | 小游戏更新版本 |
| `stateInfo/dengji1.png` | 等级图标更新 |
| `stateInfo/dengji2.png` | 等级图标更新 |

---

## 三、解密配置 JSON（12 个，本项目无对应数据）

位于 `1.2.5/config/`，是纯数据文件，按需要适配进 `src/ini` 或 `src/service`：

- `about_version_text.json`
- `fish_fry_table.json`
- `gameList_swf.json`
- `goods_all_categories.json`
- `illList_diseases.json`
- `lottery_LotteryPool_LEVEL_PROBABILITIES.json`
- `mapRules_school_stages.json`
- `petinfo_field_alias_map.json`
- `shop_tabs.json`
- `tamper_warning_text.json`
- `version_1.2.5b.json`
- `watermark_text.json`

---

## 四、新增文案（504 条）

已随本文档复制到 `docs/zh_new_125.txt`，内容包括：新台词、学校问答题库（语文/数学/音乐/体育/思政等）、签到与在线奖励文案、防改时间提示（"你别改时间啦"）、变装/背景/粉钻相关文案。

---

## 五、本项目已有、无需搬的（605 个改名/移动文件）

| 1.2.5 目录 | 本项目对应位置 | 数量 |
|---|---|---|
| `img_res/` | `img_res/` | 372 |
| `img_res/` | `iconList/` | 5 |
| `shppingMall/` | `shop/` | 130 |
| `Action/` | `Action/` | 32 |
| `email/` | `goodList/` | 16 |
| `email/` | `iconList/` | 12 |
| `answerQuestions/` | `goodList/` | 4 |
| `answerQuestions/` | `iconList/` | 4 |
| `answerQuestions/` | `login/` | 3 |
| `windowTip/` | `tip/` | 10 |
| `windowTip/` | `shop/` | 1 |
| `info/` | `info/` | 6 |
| `control/` | `iconList/` | 3 |
| `control/` | `active/` | 2 |
| `stateInfo/` | `stateInfo/` | 3 |
| `leave.ico/` | `img_res/` | 1 |
| `tool.ico/` | `floatStyle.ico/` | 1 |

重点：`answerQuestions/`（答题）的全部素材本项目已有（散在 `goodList/`、`iconList/`、`login/`），只需照着反混淆源码重写答题逻辑；1.2.5 的 34 个"新"动作动画里 32 个本项目已有同内容文件。

## 接入注意事项

1. 新增 SWF（尤其钓鱼全套 43 个）接入前逐个用 Ruffle 验证可播，1.2.5 官方跑的是 PepFlash，   若用了较新的 ActionScript 特性 Ruffle 可能不支持。
2. 跳过所有带"副本"字样的文件（官方打包失误）。
3. 功能逻辑（签到/粉钻/变装/答题/改时间检测）参考 `1.2.5/deobfuscated/` 下的反混淆源码重写，   不要直接搬代码。
