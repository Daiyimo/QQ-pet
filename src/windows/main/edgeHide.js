/**
 * edgeHide.js —— 宠物主窗口"贴边隐藏"状态机（主进程侧）
 *
 * 仿经典 QQ 宠物贴边行为：
 *   1. 用户把宠物拖到屏幕左/右边缘松手 → 窗口滑出屏幕，只留一条 STRIP 宽的小条，
 *      同时播放 hideleft / hideright（躲进边缘）动画；
 *   2. 鼠标移到露出的小条上（悬停）→ 窗口滑回屏内边缘原位，播放 appear 动画后恢复 normal；
 *   3. 收边状态下直接按住小条拖动 → 立即退出收边态，恢复正常拖动（位移重新走 clamp）。
 *
 * 状态机：this.state = null | "left" | "right"
 *   null    —— 正常态
 *   "left"  —— 收进左边缘（窗口 x = -(winW - STRIP)）
 *   "right" —— 收进右边缘（窗口 x = screenW - STRIP）
 *
 * 本模块只做状态机与滑动，窗口位移统一走 main.js 的 global.doMovePosition
 * （toPosition 分支不做 clamp，因此收边后的负坐标/超屏坐标可以放行；
 *  拖动位移的 next 分支保持原有 clamp 行为不变）。
 * 状态不持久化，重启后自然回到正常显示。
 */

const EDGE = 3;           // 边缘判定阈值(px)，与渲染层 position 判定保持一致
const STRIP = 20;         // 收边后露出的小条宽度(px)
const SLIDE_STEPS = 4;    // 滑出/滑回动画步数
const SLIDE_INTERVAL = 40;// 每步间隔(ms)，总时长约 160ms
const ARM_DELAY = 300;    // 收边后悬停弹出的生效延迟(ms)，防止松手瞬间鼠标还压在条上又立刻弹出
const APPEAR_TIME = 1000; // appear 动画大约时长(ms)，播完后接回 normal

class EdgeHide {
  constructor() {
    this.state = null;       // null | "left" | "right"
    this.dragging = false;   // 主进程记录的按住状态（mousedown/mouseup 维护）
    this.movedWhileDown = false; // 本次按住期间窗口是否真的位移过（区分"单击"与"拖动松手"）
    this.animating = false;  // 滑动动画进行中（期间不响应进出收边）
    this.armTime = 0;        // 悬停弹出的生效时间戳
    this.win = null;         // 主窗口（BrowserWindow）
    this.doMovePosition = null; // main.js 的位置移动入口 global.doMovePosition
    this.getScreenSize = null;  // 返回 [screenW, screenH]
    this.playActive = null;     // 播放 SWF 动作：playActive("hideleft") 等
    this._slideTimer = null;    // 滑动动画定时器
    this._normalTimer = null;   // appear 播完接 normal 的定时器
  }

  /**
   * 初始化（main.js 的窗口 created 回调里调用一次）
   * @param {object} opts
   * @param {BrowserWindow} opts.win 主窗口
   * @param {Function} opts.doMovePosition 全局位置移动函数（支持 {toPosition:[x,y]}）
   * @param {Function} opts.getScreenSize 返回 [w,h]
   * @param {Function} opts.playActive 向渲染层发 main_bus-html_active 播放动作
   */
  init({ win, doMovePosition, getScreenSize, playActive }) {
    this.win = win;
    this.doMovePosition = doMovePosition;
    this.getScreenSize = getScreenSize;
    this.playActive = playActive;
    return this;
  }

  /** 是否处于收边态 */
  isHidden() {
    return !!this.state;
  }

  /** 窗口是否可用（游戏场景等会 hide 主窗口，此时不进收边） */
  _winAlive() {
    try {
      return this.win && !this.win.isDestroyed() && this.win.isVisible();
    } catch (e) {
      return false;
    }
  }

  /** 取当前窗口 bounds，失败返回 null */
  _bounds() {
    try {
      return this.win.getBounds();
    } catch (e) {
      return null;
    }
  }

  /** 安全播放动作 */
  _play(name) {
    try {
      this.playActive && this.playActive(name);
    } catch (e) {
      console.warn("[edgeHide] 播放动作失败:", name, e?.stack || e);
    }
  }

  /** 取消进行中的滑动与待接的 normal */
  _cancelTimers() {
    if (this._slideTimer) { clearTimeout(this._slideTimer); this._slideTimer = null; }
    if (this._normalTimer) { clearTimeout(this._normalTimer); this._normalTimer = null; }
    this.animating = false;
  }

  /**
   * 渲染层 mousedown（"which" 且 data 中无 isDown 字段）时调用
   */
  onPress() {
    this.dragging = true;
    this.movedWhileDown = false;
  }

  /**
   * 渲染层 mouseup（"which" 且 data 中带 isDown 字段）时调用：
   * 松手位置在屏幕左/右边缘 → 进入收边态
   *
   * @param {boolean} [isDown] 渲染层 mouseup 载荷里 isDown 的**值**（move.js 传 {isDown}）。
   *   - 省略（undefined）：保持既有行为，任何 mouseup 都按"拖动松手"判定贴边。
   *     调用方 src/windows/main/main.js 目前就是不传值的，故默认路径向后兼容。
   *   - true ：确实在宠物本体上按下过左键；此时还要求本次按住期间窗口真的位移过，
   *     否则只是"在边缘处摸一下宠物"，不应触发收边。
   *   - false：右键松手、或按下动作没落在宠物上（move.js 的 isDown 仍为 false），不触发收边。
   */
  onRelease(isDown) {
    const moved = this.movedWhileDown;
    this.dragging = false;
    this.movedWhileDown = false;
    if (this.state || this.animating) return; // 已收边或动画中不重复进入
    if (!this._winAlive()) return;            // 窗口隐藏（游戏场景等）不进收边
    if (isDown !== undefined) {
      if (isDown !== true) return; // 右键/非宠物本体上的松手
      if (!moved) return;          // 纯单击，没拖动过
    }
    const b = this._bounds();
    if (!b) return;
    const [screenW] = this.getScreenSize();
    if (b.x <= EDGE) return this.enterHide("left");
    if (b.x >= screenW - b.width - EDGE) return this.enterHide("right");
  }

  /**
   * 渲染层 mousemove（"move" 类型事件）时调用：
   * 收边态下鼠标移到露出的小条上（此时窗口只有小条在屏内，收到 move 即悬停）→ 滑回屏内
   */
  onHoverMove() {
    if (!this.state || this.dragging || this.animating) return;
    if (Date.now() < this.armTime) return; // 收边刚完成，等鼠标先离开
    this.exitHide();
  }

  /**
   * doMovePosition 收到拖动位移（next 分支）时调用：
   * 收边态下用户按住小条拖动 → 立即退出收边态，本次及后续位移恢复原有 clamp 逻辑。
   * 不拦截，返回后 doMovePosition 继续正常处理。
   *
   * 同时记录"本次按住期间是否真的位移过"，供 onRelease 区分单击与拖动松手。
   * 只在 dragging 期间记录：窗口初始定位（mounted 里的 lastX/lastY 补偿）也会走
   * next 分支且位移非零，但那不在按住区间内，不能算作拖动。
   */
  onDragMove(e) {
    const hasDelta = !!(e && e.next && (e.next[0] || e.next[1]));
    if (this.dragging && hasDelta) this.movedWhileDown = true;
    if (!this.state) return;
    if (hasDelta) {
      this.exitHide({ instant: true, quiet: true });
    }
  }

  /**
   * 进入收边态：播"躲进边缘"动画 + 窗口滑出，只留 STRIP 宽的小条
   * @param {"left"|"right"} side
   */
  enterHide(side) {
    if (this.state || this.animating) return;
    const b = this._bounds();
    if (!b) return;
    this._cancelTimers();
    this.state = side;
    this.armTime = Date.now() + ARM_DELAY;
    this._play(side === "left" ? "hideleft" : "hideright");
    const [screenW] = this.getScreenSize();
    const targetX = side === "left" ? -(b.width - STRIP) : screenW - STRIP;
    this._slideTo(targetX);
  }

  /**
   * 退出收边态：窗口滑回边缘原位（x=0 或 x=screenW-winW），滑回后播 appear，再接 normal
   * @param {object} opts
   * @param {boolean} opts.instant 立即到位（拖动拖出、右键等场景），不做滑动动画
   * @param {boolean} opts.quiet   不播放 appear/normal（拖动中由渲染层自行恢复动画）
   */
  exitHide({ instant = false, quiet = false } = {}) {
    if (!this.state) return;
    const side = this.state;
    this.state = null;
    this._cancelTimers();
    const b = this._bounds();
    const winW = b ? b.width : 0;
    const y = b ? b.y : 0;
    const [screenW] = this.getScreenSize();
    const targetX = side === "left" ? 0 : screenW - winW;
    if (instant) {
      this.doMovePosition({ toPosition: [targetX, y] });
      return;
    }
    this._slideTo(targetX, () => {
      if (quiet) return;
      this._play("appear");
      // appear 是一次性动画，播完接回常态 normal（期间若再次收边则取消）
      this._normalTimer = setTimeout(() => {
        this._normalTimer = null;
        if (!this.state) this._play("normal");
      }, APPEAR_TIME);
    });
  }

  /**
   * 分 SLIDE_STEPS 步把窗口滑到 targetX（位移走 doMovePosition 的 toPosition 分支，
   * 同时带动 tip 气泡窗 / control 窗跟随，并同步渲染层位置）
   */
  _slideTo(targetX, done) {
    this._cancelTimers();
    const b = this._bounds();
    if (!b) { this.animating = false; done && done(); return; }
    const startX = b.x;
    const y = b.y;
    let step = 0;
    this.animating = true;
    const tick = () => {
      step++;
      const x = Math.round(startX + ((targetX - startX) * step) / SLIDE_STEPS);
      try {
        this.doMovePosition({ toPosition: [x, y] });
      } catch (e) {
        // 位移失败会让贴边滑动停在中途，必须留堆栈，否则现场无任何线索
        console.warn("[edgeHide] 贴边滑动位移失败:", { x, y, step }, e?.stack || e);
      }
      if (step < SLIDE_STEPS) {
        this._slideTimer = setTimeout(tick, SLIDE_INTERVAL);
      } else {
        this._slideTimer = null;
        this.animating = false;
        done && done();
      }
    };
    tick();
  }
}

// 导出单例供 main.js 使用；同时导出类便于单元测试
module.exports = new EdgeHide();
module.exports.EdgeHide = EdgeHide;
