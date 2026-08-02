// 每日记忆：移植自 orchestrator/service.py 的
// _compact_memory_timeline / _memory_summary_covers / generate_daily_memory。
// compactTimeline / summaryCovers 为纯函数（普通 node 可 require 单测）；
// DailyMemoryService 走云端 LLM（providers.chat + buildDailySummaryPrompt）。
const _require = eval("require");
const { MemoryStore, localDayString, localTimeString, isValidDay } = _require("./store.js");

// —— 活动类别判定（_memory_activity_category 逐条对照移植）——
function memoryActivityCategory(event) {
  const text = String(event.text || "").toLowerCase();
  const scene = String((event.metadata && event.metadata.scene) || "other");

  // "无/没有/非...课程" 的否定句式优先排除课程类
  const negativeCourse = /(?:无|没有|非)[^，。；]{0,12}(?:课程|授课|教学)/.test(text);
  const courseMarkers = ["课程内容", "网课", "授课", "讲课", "教学视频", "学习笔记"];
  if (!negativeCourse && courseMarkers.some((m) => text.includes(m))) {
    return "课程学习";
  }

  const gameMarkers = ["minecraft", "我的世界", "游戏画面", "游戏场景"];
  const gameActions = ["玩家", "第一人称", "手持", "操作", "战斗", "关卡", "hud", "角色", "移动", "挖掘"];
  const activeGame =
    (scene === "game" || gameMarkers.some((m) => text.includes(m))) &&
    gameActions.some((m) => text.includes(m));
  if (activeGame) return "玩游戏";

  const mediaToolMarkers = ["视频压缩", "在线视频压缩", "视频裁剪", "裁剪器"];
  if (mediaToolMarkers.some((m) => text.includes(m))) return "媒体处理";

  const directWorkMarkers = [
    "代码", "编程", "项目", "开发", "调试", "ide", "python", "javascript",
    "c++", "visual studio", "vs code", "codex", "godex",
  ];
  const fileMarkers = ["文件资源管理器", "文件夹", "文件列表", "文件管理"];
  const fileActions = [
    "正在浏览", "浏览名为", "整理", "处理", "移动文件", "复制文件", "选中", "右键", "压缩", "裁剪",
  ];
  if (
    directWorkMarkers.some((m) => text.includes(m)) ||
    (fileMarkers.some((m) => text.includes(m)) && fileActions.some((m) => text.includes(m)))
  ) {
    return "项目工作";
  }

  const webMarkers = [
    "bilibili", "哔哩", "miaocut", "购物", "商品", "下单", "购物车", "电商",
    "搜索结果", "新闻", "推荐内容", "社交媒体",
  ];
  if (webMarkers.some((m) => text.includes(m))) return "上网浏览";

  const mediaMarkers = ["电影", "正在播放", "持续播放", "飞船", "星云", "科幻", "游戏启动"];
  if (!text.includes("视频文件") && mediaMarkers.some((m) => text.includes(m))) {
    return "观看视频或游戏画面";
  }

  const desktopMarkers = ["桌面", "锁屏"];
  const idleMarkers = ["无交互", "静止", "静态", "无动态", "无明显操作", "无明显交互", "无明显课程或游戏界面"];
  if (
    text.includes("锁屏") ||
    (desktopMarkers.some((m) => text.includes(m)) && idleMarkers.some((m) => text.includes(m)))
  ) {
    return "基本无操作";
  }
  return "日常操作";
}

// —— 细节提取（_memory_detail_markers / _memory_detail_excerpt）——
function memoryDetailMarkers(category) {
  return (
    {
      项目工作: ["项目", "代码", "python", "javascript", "c++", "codex", "godex", "minicpm", "内存", "提示词", "驱动", "压缩", "裁剪"],
      课程学习: ["课程", "网课", "讲解", "学习笔记", "知识点"],
      玩游戏: ["minecraft", "我的世界", "玩家", "挖掘", "移动", "关卡"],
      上网浏览: ["bilibili", "哔哩", "购物", "商品", "新闻", "搜索结果"],
      媒体处理: ["视频", "压缩", "裁剪", "转换", "进度"],
      观看视频或游戏画面: ["科幻", "飞船", "星云", "电影", "播放"],
    }[category] || []
  );
}

// 返回 {score, excerpt}：score 为命中的标记数；超长时从首个标记前 8 字截取
function memoryDetailExcerpt(event, category, limit) {
  const text = String(event.text || "").trim();
  const folded = text.toLowerCase();
  const positions = memoryDetailMarkers(category)
    .map((m) => folded.indexOf(m))
    .filter((p) => p >= 0);
  const score = positions.length;
  let start = 0;
  if (text.length > limit && positions.length) {
    start = Math.max(0, Math.min(...positions) - 8);
  }
  const excerpt = text.slice(start, start + limit).replace(/^[，。； ]+|[，。； ]+$/g, "");
  return { score, excerpt };
}

const CATEGORY_PRIORITY = {
  课程学习: 6,
  玩游戏: 6,
  上网浏览: 6,
  媒体处理: 5,
  项目工作: 4,
  观看视频或游戏画面: 3,
  基本无操作: 1,
  日常操作: 0,
};

// _compact_memory_timeline：类别规则 → 抖动平滑 → 90 分钟桶 → 每桶 ≤4 条细节，
// 总预算 limit 字符。events 为 [{timestamp(UTC ISO), text, metadata}]，需按时间有序。
function compactTimeline(events, limit = 2800) {
  // timestamp 非法（Invalid Date）的事件跳过：否则 NaN 会进分桶 key 和 prompt
  const categorized = [];
  let skippedInvalid = 0;
  for (const event of events) {
    const local = new Date(String(event.timestamp).replace("Z", "+00:00"));
    if (Number.isNaN(local.getTime())) {
      skippedInvalid += 1;
      continue;
    }
    categorized.push({ local, event, category: memoryActivityCategory(event) });
  }
  if (skippedInvalid) {
    console.warn(`[memory/daily] 跳过 ${skippedInvalid} 条 timestamp 非法的事件`);
  }

  // 抖动平滑：前后同类、自身是"日常操作/基本无操作"、且前后间隔 ≤10 分钟 → 归并到前类
  for (let i = 1; i < categorized.length - 1; i++) {
    const prev = categorized[i - 1];
    const cur = categorized[i];
    const next = categorized[i + 1];
    if (
      prev.category === next.category &&
      next.category !== cur.category &&
      (cur.category === "日常操作" || cur.category === "基本无操作") &&
      next.local.getTime() - prev.local.getTime() <= 10 * 60 * 1000
    ) {
      cur.category = prev.category;
    }
  }

  // 90 分钟桶：key = (本地日期, (时*60+分)//90)，key 变化开新桶
  const buckets = [];
  const bucketKeys = [];
  for (const item of categorized) {
    const t = item.local;
    const key = `${localDayString(t)}|${Math.floor((t.getHours() * 60 + t.getMinutes()) / 90)}`;
    if (!bucketKeys.length || bucketKeys[bucketKeys.length - 1] !== key) {
      bucketKeys.push(key);
      buckets.push([]);
    }
    buckets[buckets.length - 1].push(item);
  }

  // 细节长度预算：每桶固定开销 72 字符，每桶最多 4 条细节
  const detailsPerBucket = 4;
  const overhead = 72;
  const detailLimit = Math.max(
    36,
    Math.floor((limit - buckets.length * overhead) / Math.max(1, buckets.length * detailsPerBucket))
  );

  const lines = [];
  for (const bucket of buckets) {
    const firstTime = bucket[0].local;
    const lastTime = bucket[bucket.length - 1].local;
    const candidates = [];
    const counts = new Map(); // 插入序 = 首次出现序
    bucket.forEach((item, index) => {
      counts.set(item.category, (counts.get(item.category) || 0) + 1);
      const { score, excerpt } = memoryDetailExcerpt(item.event, item.category, detailLimit);
      candidates.push({ priority: CATEGORY_PRIORITY[item.category], score, index, category: item.category, excerpt });
    });

    // 第一轮：优先级 ≥3 的类别各选一条最佳（分数最高、最早）
    const selected = [];
    const byPriority = [...counts.keys()].sort((a, b) => CATEGORY_PRIORITY[b] - CATEGORY_PRIORITY[a]);
    for (const category of byPriority) {
      if (CATEGORY_PRIORITY[category] < 3) continue;
      let best = null;
      for (const c of candidates) {
        if (c.category !== category) continue;
        if (!best || c.score > best.score || (c.score === best.score && c.index < best.index)) {
          best = c;
        }
      }
      selected.push(best);
      if (selected.length === detailsPerBucket) break;
    }
    // 第二轮：全局按（优先级、分数、时间）补齐到 4 条，摘要去重
    const sorted = [...candidates].sort(
      (a, b) => b.priority - a.priority || b.score - a.score || a.index - b.index
    );
    for (const c of sorted) {
      if (selected.length === detailsPerBucket) break;
      if (!selected.includes(c) && !selected.some((s) => s.excerpt === c.excerpt)) {
        selected.push(c);
      }
    }

    selected.sort((a, b) => a.index - b.index);
    const details = selected.map((s) => s.excerpt).filter(Boolean).join("；");
    let categorySummary;
    if (counts.size === 1) {
      const [category, count] = [...counts.entries()][0];
      categorySummary = `${category}，记录${count}条`;
    } else {
      categorySummary = [...counts.entries()].map(([c, n]) => `${c}${n}条`).join("；");
      categorySummary += `，共${bucket.length}条`;
    }
    lines.push(`${localTimeString(firstTime)}-${localTimeString(lastTime)} [${categorySummary}] ${details}`);
  }
  return lines.join("\n");
}

// —— 覆盖校验（_memory_summary_covers）——
// 1–28 个 HH:MM 时间点、句末标点、最早 ≤ 首事件+10min、最晚 ≥ 末事件-10min
// 返回 null 表示通过，否则返回失败原因（便于诊断 LLM 输出问题）
function summaryCoversReason(summary, firstEvent, lastEvent) {
  const text = String(summary || "");
  const times = [];
  const re = /(?<!\d)([01]\d|2[0-3]):([0-5]\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    times.push(Number(m[1]) * 60 + Number(m[2]));
  }
  if (!times.length) return "总结中没有任何 HH:MM 时间点";
  if (times.length > 28) return `时间点过多（${times.length} 个，上限 28）`;
  if (!/[。！？.!?]\s*$/.test(text)) return "总结未以句末标点结尾";
  const first = new Date(String(firstEvent.timestamp).replace("Z", "+00:00"));
  const last = new Date(String(lastEvent.timestamp).replace("Z", "+00:00"));
  const firstMinutes = first.getHours() * 60 + first.getMinutes();
  const lastMinutes = last.getHours() * 60 + last.getMinutes();
  if (Math.min(...times) > firstMinutes + 10) return "未覆盖首条事件时段";
  if (Math.max(...times) < lastMinutes - 10) return "未覆盖末条事件时段";
  return null;
}

function summaryCovers(summary, firstEvent, lastEvent) {
  return summaryCoversReason(summary, firstEvent, lastEvent) === null;
}

// —— 每日总结服务：LLM 相关依赖惰性 require，保证纯函数部分可独立单测 ——
function llmDeps() {
  return {
    providers: _require("../llm/providers.js"),
    prompts: _require("../llm/prompts.js"),
  };
}

// —— in-flight 去重（同一 key 的并发调用复用同一个 Promise）——
// 场景：连点两次"生成今日记忆"。两个入口的闸门强度不一样，这一层要兜住更弱的那个：
//   · 设置页（setup/main.js 的 buts 分支）有一道 300ms 的重入闸门，只挡住手抖双击；
//   · 右键菜单（rightMenu/main.js 的 genDailyMemory 分支）**没有任何闸门**，
//     点完菜单就关，重开再点即可立刻发起第二次。
// 裸 async 会并发跑两次 compactTimeline + 两次 120s 的 LLM 调用（重复计费，
// 且两次 writeDaily 后写覆盖先写）。成功与失败都要清理，否则一次失败后当天再也无法重试。
function dedupeByKey(map, key, factory) {
  const pending = map.get(key);
  if (pending) return pending;
  let promise;
  try {
    promise = Promise.resolve(factory());
  } catch (e) {
    // factory 同步抛错（参数校验等）：不该占用 in-flight 槽位，直接把错误交回调用方
    return Promise.reject(e);
  }
  map.set(key, promise);
  const release = () => {
    if (map.get(key) === promise) map.delete(key);
  };
  // 两条分支都挂 release：拒绝分支同时消化了"无人 await 时的 unhandled rejection"，
  // 真正的错误仍从返回的原始 promise 抛给每个调用方
  promise.then(release, release);
  return promise;
}

class DailyMemoryService {
  constructor({ store } = {}) {
    this.store = store || new MemoryStore();
    // key = "YYYY-MM-DD" → 该天正在进行的 generateDaily Promise（见 dedupeByKey）
    this._dailyInflight = new Map();
  }

  // 生成并落盘某一天的记忆 Markdown，返回 {date, event_count, generated, content}。
  // 同一天的并发调用复用同一个 Promise（含 imageGen 内部"没有当日记忆则先生成"这条路径）。
  generateDaily(day) {
    return dedupeByKey(this._dailyInflight, String(day), () => this._generateDaily(day));
  }

  async _generateDaily(day) {
    if (!isValidDay(day)) throw new Error(`invalid day: ${day}`);
    const { providers, prompts } = llmDeps();
    const events = this.store.readEvents({ day });
    const now = new Date();
    let summary;
    if (events.length) {
      const source = compactTimeline(events);
      // 当天截止到现在；历史天截止到 23:59
      const cutoff = day === localDayString(now) ? localTimeString(now) : "23:59";
      const firstTime = localTimeString(new Date(events[0].timestamp));
      const lastTime = localTimeString(new Date(events[events.length - 1].timestamp));
      const prompt = prompts.buildDailySummaryPrompt({ day, cutoff, firstTime, lastTime, source });
      let text = await providers.chat({
        providerCfg: providers.getChatProvider(),
        messages: [{ role: "user", content: prompt }],
        timeoutMs: 120000,
      });
      // 剥代码围栏、压缩空白、截 1800 字（对齐 jarvis limit）
      text = String(text || "")
        .trim()
        .replace(/^```(?:markdown|text)?\s*|\s*```$/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1800);
      if (!text) throw new Error("memory summary response is empty");
      const coverReason = summaryCoversReason(text, events[0], events[events.length - 1]);
      if (coverReason) {
        console.warn("[memory/daily] 总结未通过覆盖校验（" + coverReason + "），已拒绝:", text);
        throw new Error(`每日记忆总结未通过覆盖校验：${coverReason}`);
      }
      summary = text;
    } else {
      summary = "今天暂时没有记录到可归纳的活动。";
    }
    const generatedAt = `${localDayString(now)} ${localTimeString(now)}`;
    const content =
      `# ${day} 的记忆\n\n` +
      `> 由云端模型总结于 ${generatedAt}。\n\n` +
      `## 今日回顾\n\n${summary.trim()}\n`;
    this.store.writeDaily(day, content);
    return { date: day, event_count: events.length, generated: true, content };
  }
}

module.exports = {
  DailyMemoryService,
  dedupeByKey,
  compactTimeline,
  summaryCovers,
  summaryCoversReason,
  memoryActivityCategory,
  memoryDetailExcerpt,
  CATEGORY_PRIORITY,
};
