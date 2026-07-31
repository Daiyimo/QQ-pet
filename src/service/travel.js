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
      return fn ? fn() || {} : {};
    } catch (e) {
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
  }

  // 当前旅行（内存优先，档案兜底）
  _trip() {
    if (this.currentTrip) return this.currentTrip;
    const activeOption = this._getPetInfo().activeOption || {};
    return activeOption.trip || null;
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

  // 提前召回：清 trip、窗口恢复，无奖励、不收集
  cancelTravel() {
    const trip = this._trip();
    if (!trip) return { ok: false, reason: "not_traveling" };
    this._clearTimers();
    this._clearTripState();
    this._showMain();
    this._playActive("enter");
    this._openSpeak("[host]，旅行取消啦，我回来咯~");
    return { ok: true };
  }

  // 应用启动时恢复未完成的旅行（主会话在 doMain 接线时调用）。
  // 剩余时间 >0 则继续倒计时；已过期则直接 finishTravel。
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
    const remainingMs = trip.startTime + trip.duration - this._now();
    if (remainingMs > 0) {
      // 宠物还没回家：保持窗口隐藏，继续倒计时
      this._hideMain();
      this.finishTimer = this._setTimeout(() => this.finishTravel(), remainingMs);
      return { resumed: true, remainingMs };
    }
    // 关机期间旅行已结束：直接结算回家
    this.finishTravel();
    return { resumed: true, finished: true };
  }
}

// 默认单例（主进程使用）；测试用 createTravelService 注入桩
const travelService = new TravelService();

module.exports = travelService;
module.exports.TravelService = TravelService;
module.exports.PROVINCES = PROVINCES;
module.exports.createTravelService = (deps) => new TravelService(deps);
