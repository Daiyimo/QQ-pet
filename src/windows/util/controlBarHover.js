"use strict";

/**
 * controlBarHover.js —— 鼠标悬浮宠物自动展开控制条（悬浮条）
 *
 * ## 背景
 * 官方 1.2.5 行为：鼠标悬浮到宠物本体上时控制条自动展开为菜单态（menu），
 * 鼠标离开后约 1.5s 自动收起（hide）。本模块在 1.2.6 复刻该语义，
 * 与原有「点击宠物打开控制条」逻辑共存，互不影响。
 *
 * ## 信号来源（渲染层 mousemove 实时计算后上报主进程，拖动中不会误触发）
 * - 宠物窗 main/main.js："html_bus-main_eventMouse"，
 *   o.canDoType=true ⇔ 鼠标在宠物本体 #move 容器上
 * - 控制窗 popups/control/main.js："control_bus-Main_eventMouse"，
 *   o.canDoType=true ⇔ 鼠标在控制条可点元素上
 *
 * ## 行为约定
 * - onPetHover(true)   ：清隐藏计时器；state==="hide" 时展开为 {type:"menu"}
 * - onPetHover(false)  ：1500ms 后若 state==="menu" 且最后信号不在可交互元素上 → {type:"hide"}
 * - onControlHover(true) ：清隐藏计时器（用户正在操作控制条，不收起）
 * - onControlHover(false)：同 onPetHover(false)
 * 只有 state==="menu" 才自动收起：active（二级面板展开）状态不动，避免打断用户操作；
 * changeState 一律传对象形式 {type:"menu"|"hide"}（main 窗 blur 处现存的
 * changeState("hide") 字符串调用是疑似既有 bug，不要照抄）。
 *
 * ## 时序说明
 * 1500ms 延迟窗口同时吸收两种空档/抖动：
 * 1. 鼠标「宠物 → 控制条」途中两个窗口 canDoType 都为 false 的信号空档；
 * 2. 渲染层 mousemove 重算造成的 canDoType 抖动。
 * 每次新 hover 信号到来先清旧计时器，因此只有连续 1500ms 没有任何 hover 才真的收起。
 */

/** 自动收起延迟（ms），对齐官方 1.2.5 的 1500ms */
const HOVER_HIDE_DELAY_MS = 1500;

/** 隐藏计时器（同一时间最多一个；新 hover 信号到来即作废） */
let hideTimer = null;

/** 最近一次 hover 信号是否落在可交互元素上（宠物本体或控制条按钮） */
let lastHoverInside = false;

/** control 单例惰性缓存；controlLoadFailed 防止加载失败后每次调用都重试刷错误日志 */
let controlCache = null;
let controlLoadFailed = false;

/**
 * 取 control 窗口单例。
 * 用 eval("require") 与压缩产物保持一致（webpack 包装下直接 require 会被改写）。
 * 注意相对路径：本文件在 src/windows/util/ 下，control 在 src/windows/popups/control/。
 * 必须惰性 require 且缓存：模块加载时机早于 control 窗口创建，但 control/main.js
 * 导出的是模块加载即创建的 mainClass 单例（对象引用不变，只是 isReady/window 后填），
 * 且 changeState 内部有 isReady 守卫（窗口未创建/未就绪时为空操作），所以首次调用时
 * 现取即可，无需额外判 isCleate；仍加 try/catch 兜底，悬浮功能绝不能把主进程打炸。
 * @returns {object|null} control 单例；取不到时返回 null
 */
function getControl() {
  if (controlCache || controlLoadFailed) return controlCache;
  try {
    const _require = eval("require");
    controlCache = _require("../popups/control/main.js");
  } catch (err) {
    controlLoadFailed = true;
    console.error("[controlBarHover] 加载 control 模块失败，悬浮展开已禁用：", err);
    return null;
  }
  return controlCache;
}

/** 作废待执行的隐藏计时器 */
function clearHideTimer() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

/**
 * 安排 HOVER_HIDE_DELAY_MS 后自动收起。
 * 触发时复核两个条件：
 * - control.state 仍为 "menu"（计时期间未被点击等其它路径切成 active/hide）；
 * - 最后一次 hover 信号不在可交互元素上（计时期间用户又移回了宠物/控制条）。
 */
function scheduleHide() {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (lastHoverInside) return;
    const control = getControl();
    if (!control) return;
    try {
      if (control.state === "menu") control.changeState({ type: "hide" });
    } catch (err) {
      console.error("[controlBarHover] 收起控制条失败：", err);
    }
  }, HOVER_HIDE_DELAY_MS);
  // 不阻碍进程退出（node --test 与 Electron 退出路径都受益）
  if (typeof hideTimer.unref === "function") hideTimer.unref();
}

/**
 * 宠物本体 hover 信号（main 窗 "html_bus-main_eventMouse"）。
 * @param {boolean} inside true=鼠标进入宠物本体；false=离开
 */
function onPetHover(inside) {
  lastHoverInside = !!inside;
  if (!inside) {
    scheduleHide();
    return;
  }
  clearHideTimer();
  const control = getControl();
  if (!control) return;
  try {
    if (control.state === "hide") control.changeState({ type: "menu" });
  } catch (err) {
    console.error("[controlBarHover] 展开控制条失败：", err);
  }
}

/**
 * 控制条 hover 信号（control 窗 "control_bus-Main_eventMouse"）。
 * @param {boolean} inside true=鼠标进入控制条可点元素；false=离开
 */
function onControlHover(inside) {
  lastHoverInside = !!inside;
  if (inside) {
    clearHideTimer();
  } else {
    scheduleHide();
  }
}

module.exports = { HOVER_HIDE_DELAY_MS, onPetHover, onControlHover };
