/**
 * edgeHide.onRelease 的"松手是否算拖动结束"判定回归测试。
 *
 * 修复背景：渲染层 mouseup 恒带 {isDown} 字段，主进程原先只用该字段的**存在性**
 * 区分按下/松手，从不看它的值，也不校验本次按住期间窗口是否真的位移过。
 * 结果宠物停在屏幕边缘时，普通单击或右键松手也会触发贴边隐藏。
 *
 * 全部走注入 mock，不依赖 electron / node_modules。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { EdgeHide } = require("../src/windows/main/edgeHide.js");

const SCREEN_W = 1920;
const WIN_W = 144;

/** 构造一个注入了 mock 的 EdgeHide 实例；x 为窗口当前左上角横坐标 */
function make({ x = 500, y = 300, visible = true, moveThrows = false } = {}) {
  const calls = { toPosition: [], active: [] };
  const bounds = { x, y, width: WIN_W, height: WIN_W };
  const eh = new EdgeHide().init({
    win: {
      isDestroyed: () => false,
      isVisible: () => visible,
      getBounds: () => ({ ...bounds }),
    },
    doMovePosition: (e) => {
      if (moveThrows) throw new Error("mock move failed");
      if (e.toPosition) {
        bounds.x = e.toPosition[0];
        bounds.y = e.toPosition[1];
        calls.toPosition.push([...e.toPosition]);
      }
    },
    getScreenSize: () => [SCREEN_W, 1080],
    playActive: (name) => calls.active.push(name),
  });
  return { eh, calls, bounds };
}

/** 模拟一次"按住 → 拖动 → 松手"，dragDelta 为非零时代表真的拖动过 */
function pressDragRelease(eh, { dragDelta, isDown }) {
  eh.onPress();
  if (dragDelta) eh.onDragMove({ next: dragDelta });
  eh.onRelease(isDown);
}

/** 捕获 console.warn，既屏蔽噪音又能断言"异常必须留日志" */
function captureWarn(fn) {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warns;
}

test("onRelease 不传 isDown 时保持原有行为（调用方尚未改造，必须向后兼容）", () => {
  const { eh, calls } = make({ x: 0 });
  eh.onRelease();
  assert.equal(eh.state, "left", "不传参时贴边处松手仍应进入收边态");
  assert.deepEqual(calls.active, ["hideleft"]);
});

test("右键松手（isDown=false）在屏幕边缘不触发贴边隐藏", () => {
  const { eh, calls } = make({ x: 0 });
  // 右键：move.js 的 isDown 始终为 false，且没有拖动
  eh.onRelease(false);
  assert.equal(eh.state, null, "右键松手不应进入收边态");
  assert.deepEqual(calls.active, [], "不应播放 hideleft/hideright");
});

test("边缘处单击宠物（isDown=true 但未拖动）不触发贴边隐藏", () => {
  const { eh, calls } = make({ x: 0 });
  pressDragRelease(eh, { dragDelta: null, isDown: true });
  assert.equal(eh.state, null, "纯单击不应进入收边态");
  assert.deepEqual(calls.active, []);
});

test("拖动到左边缘松手（isDown=true 且有位移）仍正常进入左收边态", () => {
  const { eh, calls } = make({ x: 0 });
  pressDragRelease(eh, { dragDelta: [12, 0], isDown: true });
  assert.equal(eh.state, "left", "真实拖动松手必须仍能收边");
  assert.deepEqual(calls.active, ["hideleft"]);
});

test("拖动到右边缘松手进入右收边态", () => {
  const { eh, calls } = make({ x: SCREEN_W - WIN_W });
  pressDragRelease(eh, { dragDelta: [0, 9], isDown: true });
  assert.equal(eh.state, "right");
  assert.deepEqual(calls.active, ["hideright"]);
});

test("拖动位移只在按住期间计入：窗口初始定位的位移不算拖动", () => {
  const { eh } = make({ x: 0 });
  // mounted 里的 lastX/lastY 补偿也走 doMovePosition 的 next 分支，但不在按住区间内
  eh.onDragMove({ next: [300, 200] });
  assert.equal(eh.movedWhileDown, false, "未按住时的位移不应被记为拖动");
  eh.onRelease(true);
  assert.equal(eh.state, null, "只有初始定位位移、没真拖过，不应收边");
});

test("每次新的按下都会重置拖动位移标记", () => {
  const { eh } = make({ x: 0 });
  pressDragRelease(eh, { dragDelta: [20, 0], isDown: true });
  assert.equal(eh.state, "left");
  eh.exitHide({ instant: true, quiet: true });
  assert.equal(eh.state, null);
  // 第二次只是单击，不应因为上一次拖过就误判
  pressDragRelease(eh, { dragDelta: null, isDown: true });
  assert.equal(eh.state, null, "上一次的拖动标记不应泄漏到下一次单击");
});

test("屏幕中央松手不进入收边态（与边缘判定无关的回归保护）", () => {
  const { eh } = make({ x: 800 });
  pressDragRelease(eh, { dragDelta: [30, 30], isDown: true });
  assert.equal(eh.state, null);
});

test("贴边滑动位移抛错时记录 console.warn 而不是静默吞掉", () => {
  const { eh } = make({ x: 0, moveThrows: true });
  const warns = captureWarn(() => {
    pressDragRelease(eh, { dragDelta: [12, 0], isDown: true });
  });
  // 后续滑动步骤挂在定时器上，测试结束前收掉，避免异步日志噪音
  eh._cancelTimers();
  assert.ok(warns.length > 0, "doMovePosition 抛错必须留日志");
  assert.match(String(warns[0][0]), /edgeHide/, "日志应带模块前缀便于定位");
});
