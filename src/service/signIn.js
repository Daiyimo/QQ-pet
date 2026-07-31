// signIn 每日签到逻辑层（主进程，CommonJS，无 Electron 依赖，可直接被 node --test 引用）。
//
// 状态持久化说明：
//   需求原定为 setPetInfo({ info: { signin: {...} } })，但 src/ini/pet.js 的 setPetInfo
//   只合并默认 info 中已存在的键（for key in 默认 info 表），未知键 signin 会被静默丢弃。
//   因此签到状态改存系统数据：setSys({ name: "signin", value: {...} }) / getSys("signin")，
//   该通道支持任意键并会持久化到 $Store("sys")。
//   奖励发放（元宝 yb / 成长值 growth）仍走 setPetInfo({ info: {...} })，这两个键在白名单内。
//
// 存储结构：sys.signin = { last: "YYYY-MM-DD", streak: 连续天数, total: 累计天数 }
//
// 所有全局函数（getSys/setSys/getPetInfo/setPetInfo/openSpeak）都在调用时惰性取值并做
// typeof 守卫，因此本文件在纯 node 环境（测试）中也可安全 require；测试可自行注入全局 mock。

// ---- 奖励配置 ----
const BASE_REWARD = { yb: 20, growth: 5 }; // 每次签到的基础奖励
const STREAK_CYCLE = 7; // 连续签到 7 天为一轮
const STREAK_BONUS_YB = 100; // 每轮满签（streak % 7 === 0）额外奖励的元宝

// ---- 日期工具（全部使用本地时区的 YYYY-MM-DD 字符串，字典序即可比较）----

// Date -> "YYYY-MM-DD"
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// "YYYY-MM-DD" -> 本地 Date
function parseDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// "YYYY-MM-DD" 加减 n 天，返回 "YYYY-MM-DD"
function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

// 解析"今天"：允许调用方注入日期串（测试用），缺省取本机当天
function resolveToday(todayStr) {
  return todayStr || fmtDate(new Date());
}

// ---- 状态读写 ----

// 无 setSys 环境（不应出现于正式运行）时的内存兜底
let memoryState = null;

function emptyState() {
  return { last: "", streak: 0, total: 0 };
}

// 读取签到状态，字段容错归一化
function readState() {
  try {
    if (typeof getSys === "function") {
      const s = getSys("signin");
      if (s && typeof s === "object") {
        return {
          last: typeof s.last === "string" ? s.last : "",
          streak: Number(s.streak) || 0,
          total: Number(s.total) || 0,
        };
      }
      return emptyState();
    }
  } catch (e) {
    console.error("[signIn] readState 读取失败，回退内存态:", (e && e.stack) || e);
  }
  return memoryState || emptyState();
}

function writeState(state) {
  memoryState = state;
  try {
    if (typeof setSys === "function") setSys({ name: "signin", value: state });
  } catch (e) {
    console.log("signIn writeState error", e);
  }
}

// ---- 本周视图 ----

// 生成周一到周日的 7 格状态。
// 已签区间由 streak 反推：[last - streak + 1, last] 内（且不晚于今天）的日期视为已签。
function buildWeek(state, today) {
  const dow = (parseDate(today).getDay() + 6) % 7; // 周一=0 … 周日=6
  const monday = addDays(today, -dow);
  const labels = ["一", "二", "三", "四", "五", "六", "日"];
  // 已签区间起点（streak 为 0 或无 last 时为空串，字典序比较自然不命中）
  const start = state.last && state.streak > 0 ? addDays(state.last, -(state.streak - 1)) : "";
  const week = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const isToday = date === today;
    const isFuture = date > today;
    const signed =
      !!start && date >= start && date <= state.last && date <= today;
    week.push({
      date,
      label: labels[i],
      dayNum: date.slice(8), // "DD"
      signed,
      isToday,
      isFuture,
      // 四态：signed 已签 / today 今天可签 / future 未到 / missed 未签
      state: signed ? "signed" : isToday ? "today" : isFuture ? "future" : "missed",
    });
  }
  return week;
}

// ---- 对外接口 ----

// getStatus(todayStr?) -> { signedToday, streak, total, week: [7 格] }
// streak 为"当前有效"连续天数：last 是今天或昨天才有效，否则视为已断签归 0。
function getStatus(todayStr) {
  const today = resolveToday(todayStr);
  const state = readState();
  const signedToday = state.last === today;
  const yesterday = addDays(today, -1);
  const streak =
    state.last === today || state.last === yesterday ? state.streak : 0;
  return {
    signedToday,
    streak,
    total: state.total,
    week: buildWeek(state, today),
  };
}

// doSignIn(todayStr?) ->
//   成功 { ok: true, streak, total, rewards: { yb, growth, big } }
//   今天已签 { ok: false, reason: "already" }
function doSignIn(todayStr) {
  const today = resolveToday(todayStr);
  const state = readState();
  if (state.last === today) {
    return { ok: false, reason: "already" };
  }
  const yesterday = addDays(today, -1);
  // 昨天签过则连签 +1，否则断签重置为 1
  const streak = state.last === yesterday ? state.streak + 1 : 1;
  const total = state.total + 1;
  // 奖励：基础 +20 元宝 +5 成长值；连续第 7 天（7 天一轮）额外 +100 元宝
  const big = streak % STREAK_CYCLE === 0;
  const rewards = {
    yb: BASE_REWARD.yb + (big ? STREAK_BONUS_YB : 0),
    growth: BASE_REWARD.growth,
    big,
  };
  writeState({ last: today, streak, total });
  grantRewards(rewards);
  celebrate(streak, rewards);
  return { ok: true, streak, total, rewards };
}

// 发放奖励：元宝与成长值走 setPetInfo（白名单内的键）
function grantRewards(rewards) {
  try {
    if (typeof getPetInfo !== "function" || typeof setPetInfo !== "function") return;
    const pet = getPetInfo() || {};
    const info = pet.info || {};
    setPetInfo({
      info: {
        yb: (Number(info.yb) || 0) + rewards.yb,
        growth: (Number(info.growth) || 0) + rewards.growth,
      },
    });
  } catch (e) {
    console.log("signIn grantRewards error", e);
  }
}

// 气泡庆祝（[host] 由 openSpeak 自动替换为主人名）
function celebrate(streak, rewards) {
  try {
    if (typeof openSpeak !== "function") return;
    const text = rewards.big
      ? "[host]，连续签到 " + streak + " 天啦！本轮满签大奖到手：元宝 +" + rewards.yb + "、成长值 +" + rewards.growth + "，企鹅开心到原地转圈圈~"
      : "[host]，签到成功！元宝 +" + rewards.yb + "、成长值 +" + rewards.growth + "，已连续签到 " + streak + " 天，明天也要记得来看我哦~";
    openSpeak({
      data: { type: "text", data: text, submitText: "好的" },
      active: "speak",
      nextActiveStr: "speak",
    });
  } catch (e) {
    console.error("[signIn] celebrate 气泡失败:", (e && e.stack) || e);
  }
}

module.exports = {
  BASE_REWARD,
  STREAK_CYCLE,
  STREAK_BONUS_YB,
  fmtDate,
  addDays,
  getStatus,
  doSignIn,
};
