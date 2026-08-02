// 成就系统逻辑层（主进程）。
// 由 doMain.js require 后挂载 global.achievement；调用 achievement.check(trigger)
// 即可，本模块内部做幂等与庆祝气泡。
//
// 现役调用点只有两个（全仓 grep 可复核，别照着"喂食/钓鱼/签到都会调"去排查）：
//   1) aiWiring.js 的 60s 定时巡检 —— check("timer")，覆盖喂食/钓鱼/升级/元宝/在线时长
//      等所有散落在 webpack 压缩产物里、没法插桩的触发点；
//   2) travel.js 的 finishTravel —— check("travel")。
// 签到（signIn.js）没有任何 achievement 调用，签到类成就同样靠 timer 巡检兜住：
// 判定读的是存档里的连续签到数（readSigninStreak），最坏延迟一分钟解锁。
//
// 存储说明（已核对 src/ini/pet.js 的默认 info 表与 setPetInfo 实现后订正；
// 本段旧版本称 achievements 会被静默丢弃，那个前提已经不成立，别再照抄）：
//   规范存储位置是 petInfo.info.achievements = { <成就id>: <解锁ISO时间> }。
//   setPetInfo 只遍历默认 info 表里已有的键，而 pet.js 的默认表**现在已经包含**
//   achievements:{}；它的写入判据是 `l[t] == e.info[t]` —— 对象走引用比较，
//   loadUnlocked 每次都新建一份 map，引用恒不相等，所以这一路**确实写得进去**：
//   内存 info.achievements 被替换，并随 $Store.setItem("pet", ...) 一起落盘。
//   仍然保留双写，但两路现在都是真实存储：
//     1) setPetInfo({ info: { achievements } }) —— 规范位置，随 pet 存档落盘
//     2) $Store.setItem("achievements", map)    —— 独立键的兜底存储（老存档数据在这里）
//   读取时两边取并集，兼容只有其中一路有数据的存档。
//   注意：$Store.getItem 读失败会上抛（src/ini/store.js），"读不到" 不等于 "没解锁"，
//   见 readStore / check 的降级处理。
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

  // 读兜底存储。$Store.getItem 现在读失败会上抛（src/ini/store.js），而本模块被
  // aiWiring.js 的 60 秒定时器周期调用 —— 一次瞬时读失败绝不能被当成「一条都没解锁」。
  // 返回 { ok, map, error }，由调用方各自决定降级行为并留日志（这里不打日志，避免
  // 同一次失败被记两遍）。
  function readStore() {
    try {
      const m = store.get();
      return { ok: true, map: m && typeof m === "object" ? m : {} };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // 读取已解锁表：$Store 兜底存储 与 petInfo.info.achievements 取并集。
  // 返回 { ok, map, error }：ok 为 false 表示兜底存储读失败、解锁状态未知。
  function loadUnlocked(petInfo) {
    const r = readStore();
    if (!r.ok) return r;
    const map = {};
    Object.assign(map, r.map);
    const fromInfo = petInfo && petInfo.info && petInfo.info.achievements;
    if (fromInfo && typeof fromInfo === "object") Object.assign(map, fromInfo);
    return { ok: true, map };
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
  // trigger 为触发来源标识，仅作日志语义，不过滤定义。现役取值只有 "timer"
  // （aiWiring 的 60s 巡检）与 "travel"（travel.finishTravel），见文件头注释。
  // 幂等：已解锁的成就不会重复写入、不会重复庆祝。
  // 返回本次新解锁数组 [{ id, name, desc, icon, unlockedAt }]
  function check(trigger) {
    const petInfo = getPetInfoFn() || {};
    const loaded = loadUnlocked(petInfo);
    // 解锁记录读不到 -> 跳过本轮巡检。若退化成空表继续判定，所有早已达成的成就都会
    // 被当成「新解锁」：60 秒巡检会每分钟刷一批庆祝气泡，persist 还会把这份残缺表
    // 写回两路存储、污染存档。宁可这一分钟不判，下一轮读成功自然补上（check 幂等）。
    if (!loaded.ok) {
      console.error(
        `[service/achievement] 读取已解锁成就记录失败，跳过本轮巡检（trigger=${trigger}，不判定、不庆祝、不落盘，下一轮读成功后自动补上）:`,
        (loaded.error && loaded.error.stack) || loaded.error
      );
      return [];
    }
    const unlockedMap = loaded.map;
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
  // 兜底存储读失败时不上抛（上层 popups/achievement/main.js 的 sendList 只有 catch +
  // console.warn，抛出去等于面板永远空白），降级为只用 petInfo.info.achievements 渲染。
  // 这条路径纯展示：不写存储、不弹气泡，最坏结果是少显示几条已解锁记录。
  function getAll() {
    const petInfo = getPetInfoFn() || {};
    const loaded = loadUnlocked(petInfo);
    let unlockedMap = loaded.map;
    if (!loaded.ok) {
      console.error(
        "[service/achievement] 读取已解锁成就记录失败，成就面板改用 petInfo.info.achievements 单路渲染，可能少显示部分已解锁记录:",
        (loaded.error && loaded.error.stack) || loaded.error
      );
      const fromInfo = petInfo.info && petInfo.info.achievements;
      unlockedMap = fromInfo && typeof fromInfo === "object" ? fromInfo : {};
    }
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
