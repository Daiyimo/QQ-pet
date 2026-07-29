"use strict";

/**
 * control 悬浮条定位的回归测试。
 *
 * Bug 背景：control 是 1100x505 的透明窗口，可见的按钮条（日常/交互/活动）只占
 * 其中 170x50，靠 CSS 定位在窗口内 offsetX=465 / offsetY=40 处。
 * 原实现用 windowsMain.clampPosition 按【整个透明窗口】的边界做钳制，宠物靠屏幕
 * 边缘时窗口越界被推回屏幕内，窗口里的按钮条跟着一起被推走：
 *   实测 2560x1440（workArea 1392）、宠物 (2163,807) 180x180 时
 *   期望窗口 x=1703 -> 被钳到 1452（按钮条偏左 251px）
 *   期望窗口 y= 982 -> 被钳到  879（按钮条偏上 103px）
 * 正确语义是按【可见按钮条】的边界钳制，从而在保证按钮条可见的前提下
 * 最大限度保持与宠物的相对定位。
 */

const { test } = require("node:test");
const assert = require("node:assert");

const {
  CONTROL_BAR,
  CONTROL_CLAMP_MARGIN,
  clampControlBounds,
} = require("../src/windows/util/controlBarClamp.js");

/** 实测主屏：2560x1440，任务栏占 48px。 */
const WORK_AREA = { x: 0, y: 0, width: 2560, height: 1392 };

/** 按 control/main.js 的公式由宠物位置推出未钳制的窗口 bounds。 */
function boundsForPet(petX, petY, petSize = 180, addTop = 5) {
  const width = 1100;
  const height = 505;
  return {
        x: petX + petSize / 2 - width / 2,
    y: petY + petSize - addTop,
    width,
    height,
  };
}

/** 按钮条在屏幕上的实际矩形。 */
function barRect(bounds) {
  return {
    left: bounds.x + CONTROL_BAR.offsetX,
    top: bounds.y + CONTROL_BAR.offsetY,
    right: bounds.x + CONTROL_BAR.offsetX + CONTROL_BAR.width,
    bottom: bounds.y + CONTROL_BAR.offsetY + CONTROL_BAR.height,
  };
}

/** 按钮条中心 X，用于衡量与宠物中心的对齐程度。 */
function barCenterX(bounds) {
  return bounds.x + CONTROL_BAR.offsetX + CONTROL_BAR.width / 2;
}

test("宠物在屏幕中间时不做任何钳制，按钮条精确对准宠物中心", () => {
  const petX = 1200;
  const petY = 600;
  const raw = boundsForPet(petX, petY);
  const out = clampControlBounds(raw, WORK_AREA);

  assert.strictEqual(out.x, raw.x, "中间位置不应改动 x");
  assert.strictEqual(out.y, raw.y, "中间位置不应改动 y");
  assert.strictEqual(barCenterX(out), petX + 90, "按钮条中心应对准宠物中心");
});

test("宠物靠右边缘时按钮条不超出工作区，且与宠物的偏移远小于按整窗钳制", () => {
  const petX = 2380; // 宠物贴右边缘（2560-180）
  const petY = 807;
  const raw = boundsForPet(petX, petY);
  const out = clampControlBounds(raw, WORK_AREA);

  const bar = barRect(out);
  assert.ok(
    bar.right <= WORK_AREA.x + WORK_AREA.width - CONTROL_CLAMP_MARGIN,
    `按钮条右边 ${bar.right} 应在工作区内`
  );

  // 旧实现（按整窗 1100 宽钳制）的偏移量作为对照基线
  const legacyX = Math.min(
    raw.x,
    WORK_AREA.x + WORK_AREA.width - CONTROL_CLAMP_MARGIN - raw.width
  );
  const legacyOffset = Math.abs(barCenterX({ ...raw, x: legacyX }) - (petX + 90));
  const newOffset = Math.abs(barCenterX(out) - (petX + 90));

  assert.ok(
    newOffset < legacyOffset,
    `新偏移 ${newOffset} 应小于旧实现偏移 ${legacyOffset}`
  );
  assert.ok(newOffset <= 100, `贴右边缘时偏移 ${newOffset} 应控制在 100px 内`);
});

test("宠物靠左边缘时按钮条不超出工作区左边", () => {
  const raw = boundsForPet(0, 807);
  const out = clampControlBounds(raw, WORK_AREA);
  const bar = barRect(out);
  assert.ok(
    bar.left >= WORK_AREA.x + CONTROL_CLAMP_MARGIN,
    `按钮条左边 ${bar.left} 应在工作区内`
  );
});

test("宠物贴屏幕底部时按钮条整条仍可见（不会掉出屏幕外）", () => {
  const petY = 1200; // 贴底
  const raw = boundsForPet(1200, petY);
  const out = clampControlBounds(raw, WORK_AREA);
  const bar = barRect(out);

  assert.ok(
    bar.bottom <= WORK_AREA.y + WORK_AREA.height - CONTROL_CLAMP_MARGIN,
    `按钮条底部 ${bar.bottom} 应在工作区内`
  );
  assert.ok(bar.top >= WORK_AREA.y, `按钮条顶部 ${bar.top} 不应在工作区上方`);
});

test("按钮条顶部不会被钳到工作区上方（宠物在顶部时）", () => {
  const raw = boundsForPet(1200, 0);
  const out = clampControlBounds(raw, WORK_AREA);
  const bar = barRect(out);
  assert.ok(bar.top >= WORK_AREA.y, `按钮条顶部 ${bar.top} 应 >= ${WORK_AREA.y}`);
});

test("副屏（workArea 原点非 0）时按边界相对计算，不使用绝对坐标", () => {
  const second = { x: 2560, y: 0, width: 1920, height: 1032 };
  const petX = 2560 + 1920 - 180; // 副屏最右
  const raw = boundsForPet(petX, 800);
  const out = clampControlBounds(raw, second);
  const bar = barRect(out);

  assert.ok(
    bar.right <= second.x + second.width - CONTROL_CLAMP_MARGIN,
    `副屏上按钮条右边 ${bar.right} 应在该屏内`
  );
  assert.ok(
    bar.left >= second.x + CONTROL_CLAMP_MARGIN,
    `副屏上按钮条左边 ${bar.left} 应在该屏内`
  );
});

test("工作区窄于按钮条时取下界不反转，且不抛异常", () => {
  const tiny = { x: 0, y: 0, width: 100, height: 80 };
  const raw = boundsForPet(10, 10);
  const out = clampControlBounds(raw, tiny);
  assert.strictEqual(typeof out.x, "number");
  assert.strictEqual(typeof out.y, "number");
  assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y));
});

test("非法输入原样返回且不抛异常（缺 workArea / 坐标非数字）", () => {
  const raw = boundsForPet(1200, 600);
  assert.deepStrictEqual(clampControlBounds(raw, null), { x: raw.x, y: raw.y });

  const bad = { x: "abc", y: undefined, width: 1100, height: 505 };
  const out = clampControlBounds(bad, WORK_AREA);
  assert.strictEqual(out.x, "abc", "非数字 x 应原样返回，由调用方决定");
  assert.strictEqual(out.y, undefined);
});

test("CONTROL_BAR 常量与 control/index.css 的布局一致", () => {
  // 3 个 .m_head(--iconBoxSize:50) + 中间 .menu 的 .marginLR(margin:0 10px)
  assert.strictEqual(CONTROL_BAR.width, 50 * 3 + 10 * 2);
  // .activeMenu { padding-top: 40px }
  assert.strictEqual(CONTROL_BAR.offsetY, 40);
  // .activeMenu 用 .fjc 水平居中于 1100 宽窗口
  assert.strictEqual(CONTROL_BAR.offsetX, (1100 - CONTROL_BAR.width) / 2);
});
