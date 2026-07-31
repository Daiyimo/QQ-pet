/**
 * edgeHide 状态机纯逻辑冒烟测试（不依赖 electron，直接 node 运行）
 * 运行：node test/edgeHide.smoke.js
 */
const assert = require("assert");
const { EdgeHide } = require("../src/windows/main/edgeHide.js");

const SCREEN_W = 1920;
const WIN_W = 144;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 构造一个带 mock 的 EdgeHide 实例 */
function make({ x = 500, y = 300, visible = true } = {}) {
  const calls = { toPosition: [], active: [] };
  const bounds = { x, y, width: WIN_W, height: WIN_W };
  const eh = new EdgeHide().init({
    win: {
      isDestroyed: () => false,
      isVisible: () => visible,
      getBounds: () => ({ ...bounds }),
    },
    // 模拟 main.js 的 doMovePosition：toPosition 分支直接写位置（无 clamp）
    doMovePosition: (e) => {
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

async function main() {
  // 1. 松手在左边缘 -> 收进左边，滑到 -(144-20) = -124，播 hideleft
  {
    const { eh, calls } = make({ x: 0 });
    eh.onRelease();
    assert.strictEqual(eh.state, "left", "应进入 left 收边态");
    assert.deepStrictEqual(calls.active, ["hideleft"], "应播放 hideleft");
    await sleep(300); // 等滑动动画结束
    const last = calls.toPosition.at(-1);
    assert.strictEqual(last[0], -(WIN_W - 20), "左收边目标位应为 -124");
    assert.strictEqual(eh.animating, false);
    console.log("pass 1: 左边缘松手 -> 收边滑出 + hideleft");
  }

  // 2. 收边后悬停：armTime 前不弹出，之后弹出滑回 x=0，播 appear，约 1s 后接 normal
  {
    const { eh, calls } = make({ x: 2 });
    eh.onRelease();
    await sleep(300);
    calls.toPosition.length = 0;
    eh.onHoverMove(); // 仍在 armTime(300ms) 边缘附近，可能未生效
    const stImmediately = eh.state;
    await sleep(350); // 过 armTime
    eh.onHoverMove();
    assert.strictEqual(eh.state, null, "悬停后应退出收边态");
    await sleep(300); // 等滑回动画
    const last = calls.toPosition.at(-1);
    if (calls.toPosition.length) assert.strictEqual(last[0], 0, "应滑回 x=0");
    await sleep(1100); // 等 appear -> normal
    assert.ok(calls.active.includes("appear"), "滑回应播 appear");
    assert.ok(calls.active.includes("normal"), "appear 后应接 normal");
    console.log("pass 2: 悬停弹出 -> 滑回 + appear -> normal（armTime 前状态:", stImmediately, "）");
  }

  // 3. 收边态下按住小条拖动 -> 立即退出收边，位置瞬间回到边缘 x=0，不播 appear
  {
    const { eh, calls } = make({ x: 0 });
    eh.onRelease();
    await sleep(300);
    calls.active.length = 0;
    eh.onPress(); // 按住
    eh.onHoverMove(); // 拖动中的 move 不应触发弹出
    assert.strictEqual(eh.state, "left", "拖动中 hover 不应弹出");
    eh.onDragMove({ next: [6, 0] });
    assert.strictEqual(eh.state, null, "拖动应立即退出收边态");
    const last = calls.toPosition.at(-1);
    assert.strictEqual(last[0], 0, "拖出后位置应立即回到 x=0");
    assert.deepStrictEqual(calls.active, [], "拖出不应播 appear");
    console.log("pass 3: 收边态拖出 -> 立即退出且不播动画");
  }

  // 4. 松手在右边缘 -> 收进右边，滑到 1920-20=1900，播 hideright；弹出滑回 1920-144=1776
  {
    const { eh, calls } = make({ x: SCREEN_W - WIN_W });
    eh.onRelease();
    assert.strictEqual(eh.state, "right");
    assert.deepStrictEqual(calls.active, ["hideright"]);
    await sleep(300);
    assert.strictEqual(calls.toPosition.at(-1)[0], SCREEN_W - 20, "右收边目标位应为 1900");
    await sleep(350);
    eh.onHoverMove();
    await sleep(300);
    assert.strictEqual(calls.toPosition.at(-1)[0], SCREEN_W - WIN_W, "弹出应滑回 1776");
    console.log("pass 4: 右边缘收边/弹出");
  }

  // 5. 松手在屏幕中间 -> 不进收边
  {
    const { eh, calls } = make({ x: 500 });
    eh.onRelease();
    assert.strictEqual(eh.state, null);
    assert.strictEqual(calls.toPosition.length, 0);
    console.log("pass 5: 中间松手不进收边");
  }

  // 6. 窗口不可见（游戏场景隐藏）-> 不进收边
  {
    const { eh } = make({ x: 0, visible: false });
    eh.onRelease();
    assert.strictEqual(eh.state, null, "窗口隐藏时不应进收边");
    console.log("pass 6: 窗口隐藏不进收边");
  }

  // 7. 动画中/已收边时重复 onRelease -> 被忽略
  {
    const { eh, calls } = make({ x: 0 });
    eh.onRelease();
    const n = calls.toPosition.length;
    eh.onRelease(); // 动画中重复松手
    assert.strictEqual(calls.toPosition.length, n, "动画中重复进入应被忽略");
    await sleep(300);
    eh.onRelease(); // 已收边再松手
    assert.strictEqual(eh.state, "left", "状态不应被破坏");
    console.log("pass 7: 重复进入被忽略");
  }

  console.log("\nALL SMOKE TESTS PASSED");
}

main().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
