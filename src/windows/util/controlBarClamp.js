"use strict";

/**
 * control 悬浮条（日常/交互/活动）的窗口定位钳制。
 *
 * 为什么需要独立于 windowsMain.clampPosition：
 * control 是 1100x505 的**透明**窗口，真正可见的按钮条只占其中一小块（170x50），
 * 由 CSS 定位在窗口内固定偏移处；505 的高度只是为了容纳向下展开的子菜单。
 * windowsMain.clampPosition 按整个透明窗口的边界钳制，宠物靠屏幕边缘时窗口越界被
 * 推回屏幕内，窗口里的按钮条会跟着一起被推离宠物 —— 实测 2560x1440 下宠物贴右边缘
 * 时按钮条偏左约 250px、贴底时偏上约 100px，表现为「悬浮条不在宠物正下方」。
 *
 * 正确语义：按**可见按钮条**的边界钳制。这样只要按钮条还在工作区内就不动窗口，
 * 从而在保证可点击的前提下最大限度保持与宠物的相对定位。
 */

/**
 * 可见按钮条在 control 窗口内的位置与尺寸。
 * 数值来自 src/windows/popups/control/index.css 与 index.html，改布局时需同步：
 * - width  : 3 个 .m_head(--iconBoxSize: 50px) + 中间 .menu 的 .marginLR(margin: 0 10px)
 * - height : .m_head 的 --iconBoxSize(50px)，另留 4px 给 .m_h_name 标签(top:-2px)的溢出
 * - offsetY: .activeMenu { padding-top: 40px }
 * - offsetX: .activeMenu 带 .fjc(justify-content:center)，在 1100 宽窗口内水平居中
 */
const CONTROL_BAR = Object.freeze({
  width: 50 * 3 + 10 * 2,
  height: 54,
  offsetX: (1100 - (50 * 3 + 10 * 2)) / 2,
  offsetY: 40,
});

/** 与工作区边缘保留的余量，取值与 window.js 的 clampPosition 保持一致。 */
const CONTROL_CLAMP_MARGIN = 8;

/**
 * 在保证按钮条可见的前提下钳制 control 窗口坐标。
 *
 * @param {{x:number, y:number, width?:number, height?:number}} bounds
 *        未钳制的窗口 bounds（由宠物位置推算而来）。
 * @param {{x:number, y:number, width:number, height:number}} workArea
 *        目标显示器的工作区（screen.getDisplayNearestPoint(...).workArea）。
 *        为空或字段非法时原样返回坐标，由调用方决定后续行为。
 * @param {typeof CONTROL_BAR} [bar] 按钮条几何，仅测试需要覆盖时传入。
 * @param {number} [margin] 边缘余量，仅测试需要覆盖时传入。
 * @returns {{x:*, y:*}} 钳制后的坐标；非数字坐标原样透传。
 */
function clampControlBounds(bounds, workArea, bar = CONTROL_BAR, margin = CONTROL_CLAMP_MARGIN) {
  const x = bounds ? bounds.x : undefined;
  const y = bounds ? bounds.y : undefined;

  if (
    !workArea ||
    typeof workArea.width !== "number" ||
    typeof workArea.height !== "number" ||
    typeof workArea.x !== "number" ||
    typeof workArea.y !== "number"
  ) {
    return { x, y };
  }

  const out = { x, y };

  if (typeof x === "number" && Number.isFinite(x)) {
    // 让按钮条左右边都落在工作区内；窗口坐标 = 按钮条坐标 - 窗口内偏移
    const min = workArea.x + margin - bar.offsetX;
    const max = workArea.x + workArea.width - margin - (bar.offsetX + bar.width);
    // 工作区比按钮条还窄时 max < min，用 Math.max 防止上下界反转
    out.x = Math.min(Math.max(x, min), Math.max(min, max));
  }

  if (typeof y === "number" && Number.isFinite(y)) {
    const min = workArea.y + margin - bar.offsetY;
    const max = workArea.y + workArea.height - margin - (bar.offsetY + bar.height);
    out.y = Math.min(Math.max(y, min), Math.max(min, max));
  }

  return out;
}

module.exports = { CONTROL_BAR, CONTROL_CLAMP_MARGIN, clampControlBounds };
