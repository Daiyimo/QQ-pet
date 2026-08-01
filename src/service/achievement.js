// 成就系统逻辑层（主进程）。
// 由 doMain.js require 后挂载 global.achievement；各触发点（喂食/钓鱼/签到/旅游/升级）
// 调用 achievement.check(trigger) 即可，本模块内部做幂等与庆祝气泡。
//
// 存储说明：
//   规范存储位置是 petInfo.info.achievements = { <成就id>: <解锁ISO时间> }。
//   但当前 src/ini/pet.js 的 setPetInfo 只合并默认表里已存在的 info 键，
//   achievements 不在默认表中会被静默丢弃，因此这里做双写：
//     1) setPetInfo({ info: { achievements } }) —— 按约定写入（将来 pet.js 补字段后即生效）
//     2) $Store.setItem("achievements", map)    —— 当前真正落盘的兜底存储
//   读取时两边取并集，保证将来切换存储位置不丢数据。
const { Level } = require("../windows/util/pet/level.js");

// onLineTime 单位为分钟（stateInfo 中 /60 换算成小时展示），100 小时 = 6000 分钟
const ONLINE_100_MINUTES = 100 * 60;

// 安全转数字：缺失/非数字一律按 0 处理，字段未接入时不报错
function num(v) {
  const n = +v;
  return Number.isFinite(n) ? n : 0;
}

// 取宠物等级：优先用主进程已算好的 maxInfo.level，否则按成长值换算
function getLevel(petInfo) {
  const lv = num(petInfo && petInfo.maxInfo && petInfo.maxInfo.level);
  if (lv > 0) return lv;
  const growth = num(petInfo && petInfo.info && petInfo.info.growth);
  return Level.getNowLevel(growth).level;
}

// 成就定义表。icon 为 src/assets/achievement/ 下的 svg 名（不含扩展名）或 emoji 占位。
// check(petInfo) -> bool，必须对字段缺失容错。
const ACHIEVEMENTS = [
  {
    id: "hatch",
    name: "破壳而出",
    desc: "宠物等级达到 5 级",
    icon: "🐣",
    check: (p) => getLevel(p) >= 5,
  },
  {
    id: "grow20",
    name: "茁壮成长",
    desc: "宠物等级达到 20 级",
    icon: "🌱",
    check: (p) => getLevel(p) >= 20,
  },
  {
    id: "yyds",
    name: "永远的神",
    desc: "宠物等级达到 30 级",
    icon: "yyds",
    check: (p) => getLevel(p) >= 30,
  },
  {
    id: "fishMaster",
    name: "养鱼大师",
    desc: "累计收获 1000 条鱼",
    icon: "ddw",
    check: (p) => num(p && p.fishing && p.fishing.harvestfish) >= 1000,
  },
  {
    id: "travelChina",
    name: "环游中国",
    desc: "足迹遍布全国 34 个省级行政区",
    icon: "travel",
    // info.travel_china 由旅游系统写入（去过的省份数组），未接入时按空数组处理
    check: (p) => {
      const arr = p && p.info && p.info.travel_china;
      return Array.isArray(arr) && arr.length >= 34;
    },
  },
  // 曾有「小富翁」（id: "rich"，判据 info.yb >= 10000），已移除：
  // 本项目定位是「离线 + AI 版不设资源门槛」——新档默认 yb 为 999999999（src/ini/doMain.js 的
  // 新宠物分支）、背包预置全品类道具（starterKit.js），该判据开局即达成，与定位互斥。
  // 老存档里可能残留 achievements.rich 记录：loadUnlocked 仍会把它读进并集、persist 原样写回
  // （不删，避免丢历史痕迹），而 check / getAll 只遍历本表，所以既不会渲染成未知成就，
  // 也不会影响其它成就的解锁记录与「已达成 / 总数」计数。
  {
    id: "signMaster",
    name: "签到达人",
    desc: "连续签到 7 天",
    icon: "📅",
    // 签到状态的权威存储是 sys.signin（src/service/signIn.js 头注释：info.signin 不在
    // ini/pet.js 的默认 info 表里，会被 setPetInfo 静默丢弃），所以这里读 ctx.signinStreak，
    // 由 readSigninStreak() 从 getSys("signin") 取，petInfo.info.signin 仅作前向兜底。
    check: (p, ctx) => num(ctx && ctx.signinStreak) >= 7,
  },
  {
    id: "online100",
    name: "忠实陪伴",
    desc: "累计在线 100 小时",
    icon: "⏰",
    check: (p) => num(p && p.info && p.info.onLineTime) >= ONLINE_100_MINUTES,
  },
];

// 去掉 check 函数后的可序列化定义（用于 IPC 下发与返回值）
function defView(def) {
  return { id: def.id, name: def.name, desc: def.desc, icon: def.icon };
}

// 创建成就服务实例。deps 全部可注入，方便 node --test 单测：
//   getPetInfo() -> petInfo
//   setPetInfo(data)
//   openSpeak(opt)            庆祝气泡
//   getSys(name) -> value     系统数据（签到状态存这里，见 signIn.js）
//   store: { get() -> map, set(map) }   兜底持久化（默认走 global.$Store）
function createAchievementService(deps = {}) {
  const getPetInfoFn =
    deps.getPetInfo ||
    (() => (typeof globalThis.getPetInfo === "function" ? globalThis.getPetInfo() : {}));
  const setPetInfoFn =
    deps.setPetInfo ||
    ((d) => {
      if (typeof globalThis.setPetInfo === "function") globalThis.setPetInfo(d);
    });
  const getSysFn =
    deps.getSys ||
    ((name) => (typeof globalThis.getSys === "function" ? globalThis.getSys(name) : undefined));
  const speakFn =
    deps.openSpeak ||
    ((opt) => {
      if (typeof globalThis.openSpeak === "function") globalThis.openSpeak(opt);
    });
  const store = deps.store || {
    get: () => (globalThis.$Store ? globalThis.$Store.getItem("achievements") : {}) || {},
    set: (map) => {
      if (globalThis.$Store) globalThis.$Store.setItem("achievements", map);
    },
  };

  // 读取已解锁表：$Store 兜底存储 与 petInfo.info.achievements 取并集
  function loadUnlocked(petInfo) {
    const map = {};
    const fromStore = store.get();
    if (fromStore && typeof fromStore === "object") Object.assign(map, fromStore);
    const fromInfo = petInfo && petInfo.info && petInfo.info.achievements;
    if (fromInfo && typeof fromInfo === "object") Object.assign(map, fromInfo);
    return map;
  }

  // 持久化已解锁表（双写，见文件头说明）。两路都失败时成就会在下次 check 重新解锁并重复庆祝，
  // 所以失败必须留完整堆栈。
  function persist(map) {
    try {
      setPetInfoFn({ info: { achievements: map } });
    } catch (e) {
      console.error("[achievement] 写入 petInfo.info.achievements 失败:", (e && e.stack) || e);
    }
    try {
      store.set(map);
    } catch (e) {
      console.error("[achievement] 写入 $Store.achievements 失败:", (e && e.stack) || e);
    }
  }

  // 庆祝气泡：成就达成：xxx
  function celebrate(def) {
    try {
      speakFn({
        data: {
          type: "text",
          data: "成就达成：" + def.name + "！",
          submitText: "太棒了",
        },
        active: "speak",
        nextActiveStr: "speak",
      });
    } catch (e) {
      console.error("[achievement] 庆祝气泡失败:", (e && e.stack) || e);
    }
  }

  // 读取连续签到天数：权威来源是 sys.signin.streak（signIn.js 的 writeState）；
  // 若将来 ini/pet.js 把 signin 加进默认 info 表，petInfo.info.signin 作为兜底也能用。
  function readSigninStreak(petInfo) {
    let streak = 0;
    try {
      const s = getSysFn("signin");
      if (s && typeof s === "object") streak = num(s.streak);
    } catch (e) {
      console.error("[achievement] 读取 sys.signin 失败:", (e && e.stack) || e);
    }
    const fromInfo = petInfo && petInfo.info && petInfo.info.signin;
    if (fromInfo && typeof fromInfo === "object") {
      streak = Math.max(streak, num(fromInfo.streak));
    }
    return streak;
  }

  // 判定上下文：petInfo 之外的数据源（目前只有签到状态）统一从这里取，
  // 保证 check / getAll 两条路径口径一致。
  function buildContext(petInfo) {
    return { signinStreak: readSigninStreak(petInfo) };
  }

  // 遍历全部定义，对新达成的成就执行解锁（写存储 + 庆祝气泡）。
  // trigger 为触发来源标识（如 "feed" / "fishing" / "signin"），仅作日志语义，不过滤定义。
  // 幂等：已解锁的成就不会重复写入、不会重复庆祝。
  // 返回本次新解锁数组 [{ id, name, desc, icon, unlockedAt }]
  function check(trigger) {
    const petInfo = getPetInfoFn() || {};
    const unlockedMap = loadUnlocked(petInfo);
    const ctx = buildContext(petInfo);
    const newly = [];
    for (const def of ACHIEVEMENTS) {
      if (unlockedMap[def.id]) continue; // 已解锁，跳过（幂等）
      let ok = false;
      try {
        ok = !!def.check(petInfo, ctx);
      } catch (e) {
        // 单个判定异常不影响其它成就，但必须留完整堆栈
        console.error(`[achievement] 成就 ${def.id} 判定异常:`, (e && e.stack) || e);
        ok = false;
      }
      if (!ok) continue;
      const at = new Date().toISOString();
      unlockedMap[def.id] = at;
      newly.push({ ...defView(def), unlockedAt: at });
      celebrate(def);
    }
    if (newly.length) persist(unlockedMap);
    return newly;
  }

  // 全量成就视图，供成就窗口展示：
  // [{ id, name, desc, icon, unlocked, unlockedAt }]
  function getAll() {
    const petInfo = getPetInfoFn() || {};
    const unlockedMap = loadUnlocked(petInfo);
    return ACHIEVEMENTS.map((def) => ({
      ...defView(def),
      unlocked: !!unlockedMap[def.id],
      unlockedAt: unlockedMap[def.id] || null,
    }));
  }

  return { check, getAll };
}

const achievement = createAchievementService();
// 挂全局单例，与项目其它服务（global.petChat 等）同一模式
globalThis.achievement = achievement;

module.exports = {
  ACHIEVEMENTS,
  createAchievementService,
  achievement,
  check: achievement.check,
  getAll: achievement.getAll,
};
