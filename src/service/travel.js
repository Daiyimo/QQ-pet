// 旅游系统（环游中国收集）逻辑层：主进程服务，单例使用。
// 玩法参考原版 QQ 宠物：宠物出门旅游一段时间后回家，带回一个省份收集。
//
// 存储结构：
//   activeOption.trip = { place, provinceId, startTime, duration }  // 进行中的旅行（State.js 视为“有状态”，右键“停止状态”可终止）
//   $Store["travel_china"] = { collected: [省份id...] }             // 收集进度的权威存储（本服务自管）
//   setPetInfo({ info: { travel_china, travel_china_num } })        // 同步进宠物档案（需在 ini/pet.js 默认 info 里加这两个键后生效，见接线说明）
//
// 测试友好：createTravelService(deps) 可注入时钟 / 随机数 / 定时器 / petInfo / 主窗口等桩。
const _require = eval("require");

// 34 个省级行政区（4 直辖市 + 23 省 + 5 自治区 + 2 特别行政区）
// 与 ditu 地图素材对不上也没关系，收集以本表为准。
const PROVINCES = [
  { id: 1, name: "北京" },
  { id: 2, name: "天津" },
  { id: 3, name: "上海" },
  { id: 4, name: "重庆" },
  { id: 5, name: "河北" },
  { id: 6, name: "山西" },
  { id: 7, name: "辽宁" },
  { id: 8, name: "吉林" },
  { id: 9, name: "黑龙江" },
  { id: 10, name: "江苏" },
  { id: 11, name: "浙江" },
  { id: 12, name: "安徽" },
  { id: 13, name: "福建" },
  { id: 14, name: "江西" },
  { id: 15, name: "山东" },
  { id: 16, name: "河南" },
  { id: 17, name: "湖北" },
  { id: 18, name: "湖南" },
  { id: 19, name: "广东" },
  { id: 20, name: "海南" },
  { id: 21, name: "四川" },
  { id: 22, name: "贵州" },
  { id: 23, name: "云南" },
  { id: 24, name: "陕西" },
  { id: 25, name: "甘肃" },
  { id: 26, name: "青海" },
  { id: 27, name: "台湾" },
  { id: 28, name: "内蒙古" },
  { id: 29, name: "广西" },
  { id: 30, name: "西藏" },
  { id: 31, name: "宁夏" },
  { id: 32, name: "新疆" },
  { id: 33, name: "香港" },
  { id: 34, name: "澳门" },
];

const TRIP_MIN_MINUTES = 8; // 旅行时长下限（分钟）
const TRIP_MAX_MINUTES = 15; // 旅行时长上限（分钟）
const EXIT_ANIM_MS = 1500; // exit 动画播放时长（播完再隐藏主窗口）
const STORE_KEY = "travel_china"; // $Store 里的收集进度键
const REWARD_MOOD = 50; // 回家奖励：心情
const REWARD_YB = 15; // 回家奖励：元宝
// init() 恢复逻辑等待主窗口就绪的参数：doMain 在 main.cleate() 的异步创建完成前
// 同步调用 travel.init()（main.js 的 window 在 cleate 的 Promise 回调里才赋值），
// 窗口操作必须等窗口就绪，否则静默 no-op
const MAIN_WINDOW_POLL_MS = 500; // 轮询间隔
const MAIN_WINDOW_WAIT_MS = 30000; // 等待上限，超时后按窗口缺失降级执行
// setTimeout 的延迟上限（2^31-1 ms ≈ 24.8 天，Node 用 32 位有符号整数存延迟）：
// 超过该值 Node 会打 TimeoutOverflowWarning 并把延迟**坍缩成 1ms**（等于立即触发）。
// init() 恢复旅行时的剩余时间来自不可信存档，必须以此为硬上界，见 init() 注释。
const MAX_TIMEOUT_MS = 2147483647;

// 前置校验：状态位 -> 拒绝文案（[host] 为气泡占位符，与既有 openSpeak 习惯一致）
// 关于 die：全库没有任何代码给 activeOption.die 赋真值，死亡态实际存放在 activeOption.ill
// （其 type === "dead"，见 State.js 的病情链末端）。这里两者都拦：
//   - ill.type === "dead" 是真正生效的死亡判定（下面 DEAD_TEXT 分支）；
//   - die 保留为防御性校验，万一将来有代码开始写这个字段也不会漏判。
const BLOCKERS = [
  ["die", "[host]……先把我救活，才能去旅游呀"],
  ["ill", "[host]，我生病了，等我病好了再去旅游吧~"],
  ["work", "[host]，我正在打工呢，结束后再去吧~"],
  ["study", "[host]，我正在学习呢，结束后再去吧~"],
  ["trip", "[host]，我已经在旅途中啦~"],
];

// 死亡态专用文案（activeOption.ill.type === "dead"）
const DEAD_TEXT = "[host]……先把我救活，才能去旅游呀";

class TravelService {
  // deps 全部可选，缺省走全局：{ now, random, setTimeout, clearTimeout, getPetInfo, setPetInfo, openSpeak, mainWindow, store, achievementService }
  constructor(deps = {}) {
    this.deps = deps;
    this.collected = []; // 已收集省份 id（权威数据，启动时从 $Store 恢复）
    this.currentTrip = null; // 进行中的旅行（与 activeOption.trip 同步）
    this.finishTimer = null; // 回家定时器
    this.hideTimer = null; // exit 动画后隐藏窗口的定时器
    this.inited = false;
    this.saveDirty = false; // 上次收集进度落盘是否失败（失败则下次结算时重试）
    // 上一次 _getPetInfo() 是否真的读到了档案。_trip() 以档案为权威，但"读失败"
    // 不能等同于"档案里没有 trip"，否则一次瞬时读失败会把进行中的旅行白白吞掉。
    this._petInfoReadable = true;
    this._epoch = 0; // 取消令牌（同 perception/loop.js 的 _epoch 模式）：旅行被取消/结算时 +1，
    // 让 init() 挂起的"等主窗口就绪"回调失效
  }

  // ---- 依赖解析（注入优先，否则取全局）----
  // 统一的异常留痕：本服务的依赖大多是可选全局（Electron 主窗口 / $Store / openSpeak），
  // 缺失时降级是预期行为，但**异常必须留完整堆栈**，不能裸吞（规范铁律 3）。
  _warn(where, e) {
    console.error(`[travel] ${where} 失败:`, (e && e.stack) || e);
  }
  _now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }
  _random() {
    return this.deps.random ? this.deps.random() : Math.random();
  }
  _setTimeout(fn, ms) {
    return (this.deps.setTimeout || setTimeout)(fn, ms);
  }
  _clearTimeout(t) {
    (this.deps.clearTimeout || clearTimeout)(t);
  }
  _getPetInfo() {
    const fn = this.deps.getPetInfo || global.getPetInfo;
    try {
      const info = fn ? fn() || {} : {};
      this._petInfoReadable = !!fn;
      return info;
    } catch (e) {
      this._petInfoReadable = false;
      this._warn("_getPetInfo", e);
      return {};
    }
  }
  _setPetInfo(payload) {
    const fn = this.deps.setPetInfo || global.setPetInfo;
    if (fn)
      try {
        fn(payload);
      } catch (e) {
        this._warn("_setPetInfo", e);
      }
  }
  _openSpeak(text) {
    const fn = this.deps.openSpeak || global.openSpeak;
    if (fn)
      try {
        fn({
          data: { type: "text", data: text },
          active: "speak",
          nextActiveStr: "speak",
        });
      } catch (e) {
        this._warn("_openSpeak", e);
      }
  }
  _store() {
    return this.deps.store !== undefined ? this.deps.store : global.$Store;
  }
  // 主窗口单例（src/windows/main/main.js），懒加载避免测试/启动顺序问题
  _mainWindow() {
    if (this.deps.mainWindow) return this.deps.mainWindow;
    try {
      return _require("../windows/main/main.js");
    } catch (e) {
      this._warn("_mainWindow 加载", e);
      return null;
    }
  }

  // ---- 主窗口与动画 ----
  // 播放宠物动画动作（enter/exit 等，经主窗口 renderer 的 main_bus-html_active 路由）
  _playActive(active) {
    try {
      const mw = this._mainWindow();
      if (mw && mw.window && mw.window.webContents) {
        mw.window.webContents.send("main_bus-html_active", { active });
      }
    } catch (e) {
      this._warn("_playActive", e);
    }
  }
  _hideMain() {
    try {
      const mw = this._mainWindow();
      if (mw && mw.window) {
        mw.window.hide();
        mw.show = false;
      }
    } catch (e) {
      this._warn("_hideMain", e);
    }
  }
  _showMain() {
    try {
      const mw = this._mainWindow();
      if (mw && mw.window) {
        mw.window.show();
        mw.show = true;
      }
    } catch (e) {
      this._warn("_showMain", e);
    }
  }

  // ---- 主窗口显隐的统一入口（含仲裁）----
  // 主窗口可见性此前有两个主人且互不知情：旅游走 _hideMain/_showMain（**同时**维护
  // mw.show 标志），而感知的 pet-hide/pet-show 在 aiWiring 里直接 window.hide()/show()
  // 且不改 mw.show。于是"旅游中 → 感知判定进入 game 场景 → 用户关掉屏幕感知
  //（stop() → _restoreFromGame() → pet-show）"会把还在旅游的宠物放回桌面，而 mw.show
  // 仍是 false（isStop / 托盘 / 贴边逻辑继续按隐藏处理）。
  // 仲裁规则：**旅游态优先**——旅游期间任何来源的"显示"请求都被拒绝，直到结算/召回；
  // 显隐一律经此入口，show 标志与窗口真实状态同进同退。
  // 返回是否真的执行了请求（false = 被仲裁拒绝，或窗口不可用）。
  setMainWindowVisible(visible, reason = "") {
    try {
      const mw = this._mainWindow();
      const win = mw && mw.window;
      if (!win || (win.isDestroyed && win.isDestroyed())) return false;
      if (!visible) {
        this._hideMain();
        return true;
      }
      if (this._trip()) {
        console.warn(
          "[travel] 旅游期间拒绝显示主窗口（旅游态优先于感知场景恢复），宠物保持在外:",
          reason || "unknown"
        );
        return false;
      }
      this._showMain();
      return true;
    } catch (e) {
      this._warn(`setMainWindowVisible(visible=${visible})`, e);
      return false;
    }
  }

  // ---- 主窗口就绪等待（init 恢复逻辑专用）----
  // doMain 在 main.cleate() 异步完成前同步调用 init()，此时 mw.window 还是 null，
  // _hideMain/_showMain/_playActive 会静默 no-op：恢复中的旅行期间宠物仍显示在桌面；
  // 关机期间结束的旅行丢失 enter 动画与回家气泡。就绪前轮询，带超时兜底与 epoch 取消令牌。
  _mainWindowReady() {
    const mw = this._mainWindow();
    return !!(mw && mw.window);
  }

  // 窗口已就绪则同步执行 fn；否则每 MAIN_WINDOW_POLL_MS 轮询，直到就绪、
  // 旅行结束（epoch 变化）或超过 MAIN_WINDOW_WAIT_MS（降级执行 fn——窗口操作
  // 会安全 no-op，但结算/隐藏语义不能永远搁置）。
  _whenMainWindowReady(fn, label) {
    if (this._mainWindowReady()) {
      fn();
      return;
    }
    const epoch = this._epoch;
    const deadline = this._now() + MAIN_WINDOW_WAIT_MS;
    const poll = () => {
      if (epoch !== this._epoch) return; // 旅行已被取消/结算，恢复意图作废
      if (this._mainWindowReady()) {
        fn();
        return;
      }
      if (this._now() >= deadline) {
        console.error(
          `[travel] ${label}：等待主窗口就绪超过 ${MAIN_WINDOW_WAIT_MS}ms，按窗口缺失降级执行:`,
          new Error("main window not ready")
        );
        fn();
        return;
      }
      this._setTimeout(poll, MAIN_WINDOW_POLL_MS);
    };
    this._setTimeout(poll, MAIN_WINDOW_POLL_MS);
  }

  // ---- 收集进度持久化 ----
  _loadCollected() {
    // 优先 $Store；宠物档案 info.travel_china 作为兜底（档案模型扩展后）
    const valid = (list) => list.filter((id) => PROVINCES.some((p) => p.id === id));
    let storeList = null;
    try {
      const store = this._store();
      const data = store && store.getItem ? store.getItem(STORE_KEY) : null;
      const list = Array.isArray(data)
        ? data
        : data && Array.isArray(data.collected)
          ? data.collected
          : null;
      if (list) storeList = valid(list);
    } catch (e) {
      this._warn("_loadCollected 读 $Store", e);
    }
    let infoList = null;
    try {
      const info = this._getPetInfo().info || {};
      if (Array.isArray(info.travel_china)) infoList = valid(info.travel_china);
    } catch (e) {
      this._warn("_loadCollected 读宠物档案", e);
    }
    this.collected = storeList || infoList || [];
    // 启动补偿：上次 _saveCollected 写 $Store 失败（saveDirty）时，新进度只同步进了
    // 宠物档案，$Store 里是旧值，重启后 dirty 标志已随内存丢失。collected 只增不减，
    // 两源不一致时取并集并重写 $Store，即完成对那次失败写入的重试。
    if (storeList && infoList) {
      const missing = infoList.filter((id) => !storeList.includes(id));
      if (missing.length) {
        console.error(
          `[travel] 启动补偿：宠物档案比 $Store 多 ${missing.length} 条收集进度，按并集重写落盘`
        );
        this.collected = [...storeList, ...missing];
        this._saveCollected();
      }
    }
  }
  // 落盘收集进度。返回是否成功写入权威存储（$Store）——失败时**不能当成功处理**，
  // 置 dirty 标志供下次 finishTravel 重试，且必须留堆栈（收集进度静默丢失会让
  // 「环游中国」成就永远不解锁且无任何线索）。
  _saveCollected() {
    let ok = false;
    try {
      const store = this._store();
      if (store && store.setItem) {
        store.setItem(STORE_KEY, { collected: this.collected.slice() });
        ok = true;
      } else {
        console.error("[travel] _saveCollected 失败: $Store 不可用，收集进度未落盘");
      }
    } catch (e) {
      this._warn("_saveCollected 写 $Store", e);
    }
    this.saveDirty = !ok;
    // 同步进宠物档案（info.travel_china / travel_china_num 已在 ini/pet.js 默认表内）
    this._setPetInfo({
      info: {
        travel_china: this.collected.slice(),
        travel_china_num: this.collected.length,
      },
    });
    return ok;
  }

  _clearTimers() {
    if (this.finishTimer) {
      this._clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (this.hideTimer) {
      this._clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  _clearTripState() {
    const activeOption = this._getPetInfo().activeOption || {};
    this._setPetInfo({ activeOption: { ...activeOption, trip: null } });
    this.currentTrip = null;
    this._epoch += 1; // 旅行结束：作废 init() 挂起的窗口就绪回调
  }

  // 当前旅行。**档案 activeOption.trip 是唯一权威，内存 currentTrip 只是缓存。**
  // 依据：activeOption 由多方写入——State.js 的病情/死亡分支（doActive 的 ill 分支）
  // 会在生病时把 trip 清空并播"我不能旅游了~"。原先内存优先，于是那次取消被撤销：
  // finishTimer 到点仍从内存拿到 currentTrip，照样收集省份 + mood/yb 奖励（可刷）。
  // 档案里没有 trip 而内存里有 → 旅行已被外部终止：清回家/隐藏定时器、作废缓存与
  // init() 挂起的窗口就绪回调。两者都在但不一致时，同样以档案为准（缓存对齐）。
  _trip() {
    const petInfo = this._getPetInfo();
    // 档案读不到（getPetInfo 抛错 / 环境里没有 getPetInfo）时不做"已被取消"判定
    if (!this._petInfoReadable) return this.currentTrip || null;
    const stored = (petInfo.activeOption || {}).trip || null;
    if (!stored) {
      if (this.currentTrip) {
        console.warn(
          "[travel] 档案里的 activeOption.trip 已被外部清除（生病/死亡/停止状态），" +
            "按旅行终止处理：清理回家定时器、不收集省份、不发放奖励:",
          `place=${this.currentTrip.place}`
        );
        this._clearTimers();
        this.currentTrip = null;
        this._epoch += 1; // 作废 init() 挂起的窗口就绪回调
      }
      return null;
    }
    this.currentTrip = stored;
    return stored;
  }

  _provinceOf(trip) {
    return (
      PROVINCES.find((p) => p.id === trip.provinceId) || {
        id: trip.provinceId,
        name: trip.place || "远方",
      }
    );
  }

  // ---- 对外 API ----

  // 开始旅游。返回 { ok, province?, duration?, reason? }
  startTravel() {
    // 先清残留定时器：上一趟旅行若被非 travelService 的路径终止（State.js 生病清 trip、
    // 或档案被外部改动），finishTimer/hideTimer 可能还挂着。不清就直接覆盖字段会丢掉
    // 句柄：旧 finishTimer 一到点就结算**新**行程 → 秒完成、白拿省份与元宝，且可循环。
    this._clearTimers();
    const petInfo = this._getPetInfo();
    const activeOption = petInfo.activeOption || {};
    // 前置校验：有 ill/work/study/trip 任一状态则拒绝。死亡态存放在 activeOption.ill
    // （type === "dead"），单独给文案。
    for (const [key, text] of BLOCKERS) {
      if (activeOption[key]) {
        const dead = key === "ill" && activeOption.ill && activeOption.ill.type === "dead";
        this._openSpeak(dead ? DEAD_TEXT : text);
        return { ok: false, reason: dead ? "die" : key };
      }
    }
    // 随机选一个未收集的省份；全收集后随机任意省份
    const rest = PROVINCES.filter((p) => !this.collected.includes(p.id));
    const candidates = rest.length ? rest : PROVINCES;
    const province =
      candidates[Math.floor(this._random() * candidates.length)];
    // 时长随机 8~15 分钟
    const minutes =
      TRIP_MIN_MINUTES +
      Math.floor(this._random() * (TRIP_MAX_MINUTES - TRIP_MIN_MINUTES + 1));
    const duration = minutes * 60 * 1000;
    const trip = {
      place: province.name,
      provinceId: province.id,
      startTime: this._now(),
      duration,
    };
    this._setPetInfo({ activeOption: { ...activeOption, trip } });
    this.currentTrip = trip;
    // 宠物播 exit 动画后隐藏主窗口（旅游期间桌面看不到宠物）
    this._playActive("exit");
    this.hideTimer = this._setTimeout(() => this._hideMain(), EXIT_ANIM_MS);
    // 到点自动回家
    this.finishTimer = this._setTimeout(() => this.finishTravel(), duration);
    this._openSpeak("[host]，我去" + province.name + "旅游啦，等我回来~");
    return { ok: true, province, duration };
  }

  // 旅行结束（定时器到期自动触发，也可手动调用）。
  // 回家 -> 收集 -> 清状态 -> 气泡播报 -> 奖励 -> 成就联动。
  finishTravel() {
    const trip = this._trip();
    if (!trip) return { ok: false, reason: "not_traveling" };
    this._clearTimers();
    const province = this._provinceOf(trip);
    // 窗口恢复 + enter 动画
    this._showMain();
    this._playActive("enter");
    // 收集写入（去重）
    if (!this.collected.includes(province.id)) {
      this.collected.push(province.id);
    }
    this._saveCollected();
    // 落盘失败不静默：进度只在内存里，重启会丢，必须让用户/日志看得到
    if (this.saveDirty) {
      this._openSpeak("[host]，我回来了，但纪念品好像没收好……（收集进度保存失败）");
    }
    // 清除 activeOption.trip
    this._clearTripState();
    // 奖励：mood +50（上限按 maxInfo.mood，缺省 1000）、yb +15
    const info = this._getPetInfo().info || {};
    const maxInfo = this._getPetInfo().maxInfo || {};
    const moodMax = +maxInfo.mood > 0 ? +maxInfo.mood : 1000;
    this._setPetInfo({
      info: {
        mood: Math.min(moodMax, (+info.mood || 0) + REWARD_MOOD),
        yb: (+info.yb || 0) + REWARD_YB,
      },
    });
    // 带回文案
    this._openSpeak(
      "[host]，我从" + province.name + "回来啦，给你带了纪念品~",
    );
    // 成就系统联动（判空调用）
    // 全局名兼容：规范挂载是 global.achievement（src/service/achievement.js），
    // achievementService 作为别名兜底，两者都没有则跳过
    const ach =
      this.deps.achievementService !== undefined
        ? this.deps.achievementService
        : global.achievementService || global.achievement;
    if (ach && typeof ach.check === "function") {
      try {
        ach.check("travel");
      } catch (e) {
        this._warn("成就联动 check(travel)", e);
      }
    }
    return { ok: true, province, collected: this.collected.length };
  }

  // 查询状态：{ traveling, province?, remainingMs?, collected, total }
  getStatus() {
    const trip = this._trip();
    const status = {
      traveling: !!trip,
      collected: this.collected.slice(),
      total: PROVINCES.length,
    };
    if (trip) {
      status.province = this._provinceOf(trip);
      status.remainingMs = Math.max(
        0,
        (trip.startTime || 0) + (trip.duration || 0) - this._now(),
      );
    }
    return status;
  }

  // 提前召回：清 trip、窗口恢复，无奖励、不收集。
  // silent=true 时不播"旅行取消啦"气泡——供 State.js 的生病/死亡分支调用：那边紧接着
  // 会播"我生病了，我不能旅游了~"，两条气泡互相覆盖，只留后者语义更清楚。
  cancelTravel({ silent = false } = {}) {
    const trip = this._trip();
    if (!trip) return { ok: false, reason: "not_traveling" };
    this._clearTimers();
    this._clearTripState();
    this._showMain();
    this._playActive("enter");
    if (!silent) this._openSpeak("[host]，旅行取消啦，我回来咯~");
    return { ok: true };
  }

  // 应用启动时恢复未完成的旅行（主会话在 doMain 接线时调用）。
  // 剩余时间 >0 则继续倒计时；已过期则直接 finishTravel。
  // 注意 doMain 在主窗口异步创建完成前同步调用本方法，涉及窗口的操作
  //（隐藏窗口 / enter 动画 / 回家气泡）一律经 _whenMainWindowReady 等窗口就绪。
  init() {
    // 幂等：重复调用会再挂一个 finishTimer 导致重复结算
    if (this.inited) return { resumed: false, reason: "already_inited" };
    this._loadCollected();
    this.inited = true;
    const trip = (this._getPetInfo().activeOption || {}).trip;
    if (!trip || !trip.startTime || !trip.duration) {
      return { resumed: false };
    }
    this.currentTrip = trip;
    const now = this._now();
    // startTime / duration 都来自不可信的历史存档（系统时钟被回拨、NTP 纠偏跑偏的机器、
    // 用户手改日期、存档被手改），剩余时间必须钳制，否则有两种真实故障：
    //   ① 时间回拨 1 天 → remainingMs≈24h：主窗口保持隐藏、行程 24 小时不结束，
    //      用户看不到宠物，只会以为程序坏了；
    //   ② 回拨超过 MAX_TIMEOUT_MS（≈24.8 天）→ Node 打 TimeoutOverflowWarning 并把
    //      延迟坍缩成 1ms → 立即结算，白拿省份 + 元宝，且可反复。
    // 规则：startTime 晚于当前时间即存档异常，按"旅行已结束"立即结算（不能傻等一个
    // 永远追不上的未来时刻）；否则剩余时间钳在 [0, min(duration, MAX_TIMEOUT_MS)]——
    // 剩余时间不可能超过行程自身的总时长，而总时长本身也可能被改坏，故再套一层硬上界。
    const clockAnomaly = trip.startTime > now;
    if (clockAnomaly) {
      console.warn(
        "[travel] 存档里的旅行开始时间晚于当前时间（系统时钟被回拨或存档被改），" +
          "按旅行已结束立即结算，不再等待:",
        `startTime=${trip.startTime} now=${now} duration=${trip.duration}`
      );
    }
    const cap = Math.min(Math.max(0, +trip.duration || 0), MAX_TIMEOUT_MS);
    const remainingMs = clockAnomaly
      ? 0
      : Math.min(Math.max(0, trip.startTime + trip.duration - now), cap);
    if (remainingMs > 0) {
      // 宠物还没回家：保持窗口隐藏（等主窗口就绪后执行），继续倒计时
      this._whenMainWindowReady(() => this._hideMain(), "恢复旅行隐藏主窗口");
      this.finishTimer = this._setTimeout(() => this.finishTravel(), remainingMs);
      return { resumed: true, remainingMs };
    }
    // 关机期间旅行已结束：等主窗口就绪后结算（enter 动画/回家气泡依赖窗口）；
    // 窗口已就绪（含测试注入的桩）时同步执行，行为与原来一致
    const ready = this._mainWindowReady();
    this._whenMainWindowReady(() => {
      if (this._trip()) this.finishTravel(); // 等待期间可能被手动召回，结算前再确认
    }, "关机期间结束的旅行结算");
    return ready
      ? { resumed: true, finished: true }
      : { resumed: true, finished: false, deferred: true };
  }
}

// 默认单例（主进程使用）；测试用 createTravelService 注入桩
const travelService = new TravelService();
// 挂 global：State.js（webpack 压缩产物，无 require 通道）的病情/死亡分支要在清 trip 前
// 通知本服务真正终止旅行，同 loop.js 的 global.perceptionLoop 做法。
global.travelService = travelService;

module.exports = travelService;
module.exports.TravelService = TravelService;
module.exports.PROVINCES = PROVINCES;
module.exports.MAIN_WINDOW_POLL_MS = MAIN_WINDOW_POLL_MS;
module.exports.MAIN_WINDOW_WAIT_MS = MAIN_WINDOW_WAIT_MS;
module.exports.MAX_TIMEOUT_MS = MAX_TIMEOUT_MS;
// 主窗口显隐的统一入口（供 aiWiring 的 pet-hide/pet-show 使用，旅游态优先仲裁）
module.exports.requestMainWindowVisible = (visible, reason) =>
  travelService.setMainWindowVisible(visible, reason);
module.exports.createTravelService = (deps) => new TravelService(deps);
