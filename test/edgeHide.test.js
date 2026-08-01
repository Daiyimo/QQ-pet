/**
 * edgeHide 状态机纯逻辑测试（不依赖 electron，直接 node 运行）
 * 运行：node --test test/edgeHide.test.js（或 npm test 全量）
 *
 * 历史坑（勿回退）：
 * 1. 本文件曾叫 edgeHide.smoke.js，不匹配 node --test 的 *.test.js glob 而长期从未被执行；
 * 2. 改名后整个文件是一个 async main()，21 条 assert 全塞在里面 —— node --test 只记 1 条测试，
 *    任何一条断言挂掉都只报"文件失败"，且其中「滑回 x=0」被包在 `if (calls.toPosition.length)`
 *    里（没产生位移就什么都不验）、「armTime 前不弹出」只是打日志不是断言。
 *    现在拆成 21 个独立 test()，每个场景只跑一次（惰性记忆化）后由多条测试各自断言。
 *
 * 时序去抖：armTime（收边后悬停生效时刻）不用 sleep 去"蹭"，而是直接改 eh.armTime
 * 这一公开状态字段来钉住"未到点/已过点"，避免测试依赖真实时钟抖动。
 */
const test = require("node:test");
const assert = require("assert");
const { EdgeHide } = require("../src/windows/main/edgeHide.js");

const SCREEN_W = 1920;
const WIN_W = 144;
const STRIP = 20;
const SLIDE_STEPS = 4; // 与 edgeHide.js 的 SLIDE_STEPS 一致
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 滑动动画总时长约 160ms，留足余量后动画必须已结束 */
const SLIDE_DONE = 300;

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

/** 场景只跑一次，多条测试共用快照（每条测试仍独立成败） */
function once(run) {
  let p = null;
  return () => (p || (p = run()));
}

// ---------- 场景 1：左边缘松手收边 ----------
const leftRelease = once(async () => {
  const { eh, calls } = make({ x: 0 });
  eh.onRelease();
  const state = eh.state;
  const active = [...calls.active];
  await sleep(SLIDE_DONE);
  return { state, active, lastX: calls.toPosition.at(-1)?.[0], animating: eh.animating };
});

test("左边缘松手后进入 left 收边态", async () => {
  assert.strictEqual((await leftRelease()).state, "left");
});

test("左边缘收边时播放 hideleft 动作", async () => {
  assert.deepStrictEqual((await leftRelease()).active, ["hideleft"]);
});

test("左收边滑动终点为 -(窗宽-小条宽)", async () => {
  assert.strictEqual((await leftRelease()).lastX, -(WIN_W - STRIP), "左收边目标位应为 -124");
});

test("收边滑动结束后 animating 复位", async () => {
  assert.strictEqual((await leftRelease()).animating, false, "300ms 后滑动动画应已结束");
});

// ---------- 场景 2：收边后悬停弹出 ----------
const hoverPop = once(async () => {
  const { eh, calls } = make({ x: 2 });
  eh.onRelease();
  await sleep(SLIDE_DONE);
  calls.toPosition.length = 0;

  eh.armTime = Date.now() + 60000; // 显式钉住"生效时刻未到"
  eh.onHoverMove();
  const stateBeforeArm = eh.state;

  eh.armTime = Date.now() - 1; // 生效时刻已过
  eh.onHoverMove();
  const stateAfterHover = eh.state;

  await sleep(SLIDE_DONE); // 等滑回动画
  const slideBack = calls.toPosition.map((p) => p[0]);
  await sleep(1100); // 等 appear -> normal
  return { stateBeforeArm, stateAfterHover, slideBack, active: [...calls.active] };
});

test("armTime 未到时悬停不弹出（防松手瞬间鼠标压在小条上立刻弹回）", async () => {
  assert.strictEqual((await hoverPop()).stateBeforeArm, "left", "生效时刻前应保持收边态");
});

test("armTime 之后悬停退出收边态", async () => {
  assert.strictEqual((await hoverPop()).stateAfterHover, null);
});

test("悬停弹出后从屏外滑回屏内 x=0", async () => {
  const { slideBack } = await hoverPop();
  assert.strictEqual(slideBack.length, SLIDE_STEPS, "弹出必须真的产生 4 步滑回位移");
  assert.ok(slideBack[0] < 0, "第一步应仍在屏外（从 -124 起步）");
  assert.strictEqual(slideBack.at(-1), 0, "应滑回 x=0");
});

test("悬停弹出的动作序列为 hideleft -> appear -> normal", async () => {
  assert.deepStrictEqual((await hoverPop()).active, ["hideleft", "appear", "normal"]);
});

// ---------- 场景 3：收边态下按住小条拖出 ----------
const dragOut = once(async () => {
  const { eh, calls } = make({ x: 0 });
  eh.onRelease();
  await sleep(SLIDE_DONE);
  calls.active.length = 0;
  eh.armTime = Date.now() - 1; // 排除 armTime 干扰，只考察 dragging 守卫
  eh.onPress(); // 按住
  eh.onHoverMove(); // 拖动中的 move 不应触发弹出
  const stateWhileDrag = eh.state;
  eh.onDragMove({ next: [6, 0] });
  return {
    stateWhileDrag,
    stateAfterDrag: eh.state,
    lastX: calls.toPosition.at(-1)?.[0],
    active: [...calls.active],
  };
});

test("按住拖动期间的 hover 不触发弹出", async () => {
  assert.strictEqual((await dragOut()).stateWhileDrag, "left");
});

test("收边态下拖动立即退出收边态", async () => {
  assert.strictEqual((await dragOut()).stateAfterDrag, null);
});

test("拖出后窗口位置立即回到屏内边缘 x=0", async () => {
  assert.strictEqual((await dragOut()).lastX, 0);
});

test("拖出不播 appear 动画（由渲染层自行恢复）", async () => {
  assert.deepStrictEqual((await dragOut()).active, []);
});

// ---------- 场景 4：右边缘收边与弹出 ----------
const rightRelease = once(async () => {
  const { eh, calls } = make({ x: SCREEN_W - WIN_W });
  eh.onRelease();
  const state = eh.state;
  const active = [...calls.active];
  await sleep(SLIDE_DONE);
  const enterLastX = calls.toPosition.at(-1)?.[0];
  eh.armTime = Date.now() - 1;
  eh.onHoverMove();
  await sleep(SLIDE_DONE);
  return { state, active, enterLastX, exitLastX: calls.toPosition.at(-1)?.[0] };
});

test("右边缘松手后进入 right 收边态", async () => {
  assert.strictEqual((await rightRelease()).state, "right");
});

test("右边缘收边时播放 hideright 动作", async () => {
  assert.deepStrictEqual((await rightRelease()).active, ["hideright"]);
});

test("右收边滑动终点为 屏宽-小条宽", async () => {
  assert.strictEqual((await rightRelease()).enterLastX, SCREEN_W - STRIP, "右收边目标位应为 1900");
});

test("右侧悬停弹出滑回 屏宽-窗宽", async () => {
  assert.strictEqual((await rightRelease()).exitLastX, SCREEN_W - WIN_W, "弹出应滑回 1776");
});

// ---------- 场景 5/6：不进收边的两种情形 ----------
const middleRelease = once(async () => {
  const { eh, calls } = make({ x: 500 });
  eh.onRelease();
  return { state: eh.state, moves: calls.toPosition.length };
});

test("屏幕中间松手不进收边态", async () => {
  assert.strictEqual((await middleRelease()).state, null);
});

test("屏幕中间松手不产生任何位移", async () => {
  assert.strictEqual((await middleRelease()).moves, 0);
});

test("窗口不可见（游戏场景隐藏）时松手不进收边", async () => {
  const { eh } = make({ x: 0, visible: false });
  eh.onRelease();
  assert.strictEqual(eh.state, null);
});

// ---------- 场景 7：重复 onRelease ----------
const repeatRelease = once(async () => {
  const { eh, calls } = make({ x: 0 });
  eh.onRelease();
  const movesAfterFirst = calls.toPosition.length;
  eh.onRelease(); // 动画中重复松手
  const movesAfterSecond = calls.toPosition.length;
  await sleep(SLIDE_DONE);
  eh.onRelease(); // 已收边再松手
  return { movesAfterFirst, movesAfterSecond, state: eh.state };
});

test("滑动动画进行中重复松手不追加新的收边位移", async () => {
  const r = await repeatRelease();
  assert.strictEqual(r.movesAfterFirst, 1, "首次松手应同步走出第一步滑动");
  assert.strictEqual(r.movesAfterSecond, 1, "动画中重复进入应被忽略");
});

test("已收边后再次松手不破坏收边状态", async () => {
  assert.strictEqual((await repeatRelease()).state, "left");
});
