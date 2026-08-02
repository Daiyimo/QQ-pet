// memory 层单元测试：daily.js 时间轴压缩与覆盖校验、activity.js 清洗与记录门槛、store.js 落盘
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  compactTimeline,
  summaryCovers,
  memoryActivityCategory,
} = require("../src/service/memory/daily.js");
const {
  MemoryActivityRecorder,
  cleanActivityText,
  MAX_THROTTLE_SLOTS,
} = require("../src/service/memory/activity.js");
const { MemoryStore, localDayString } = require("../src/service/memory/store.js");

// 用本地时间构造事件（compactTimeline/summaryCovers 均按本地时区读 HH:MM）
function ev(hour, minute, text, scene = "other") {
  return {
    timestamp: new Date(2025, 5, 10, hour, minute).toISOString(),
    text,
    metadata: { scene },
  };
}

// —— memoryActivityCategory ——
test("类别归类：课程/游戏/上网/无操作/日常", () => {
  assert.equal(memoryActivityCategory(ev(9, 0, "用户在观看网课讲解数学")), "课程学习");
  assert.equal(
    memoryActivityCategory(ev(9, 0, "玩家正在移动角色探索地图", "game")),
    "玩游戏"
  );
  assert.equal(memoryActivityCategory(ev(9, 0, "浏览 bilibili 的推荐内容")), "上网浏览");
  assert.equal(memoryActivityCategory(ev(9, 0, "桌面静止，无交互")), "基本无操作");
  assert.equal(memoryActivityCategory(ev(9, 0, "打开了一个普通窗口看了看")), "日常操作");
});

test("类别归类：否定句式优先排除课程", () => {
  assert.notEqual(memoryActivityCategory(ev(9, 0, "没有课程内容的普通页面")), "课程学习");
});

// —— compactTimeline ——
test("compactTimeline：90 分钟桶，跨桶拆行", () => {
  // 09:00 与 10:29 同属一桶（540-629 分钟），10:30 进入下一桶
  const sameBucket = compactTimeline([
    ev(9, 0, "用户在观看网课讲解数学"),
    ev(10, 29, "继续观看网课讲解物理"),
  ]);
  assert.equal(sameBucket.split("\n").length, 1);

  const twoBuckets = compactTimeline([
    ev(9, 0, "用户在观看网课讲解数学"),
    ev(10, 30, "继续观看网课讲解物理"),
  ]);
  assert.equal(twoBuckets.split("\n").length, 2);
});

test("compactTimeline：抖动平滑——夹在同类别之间的短暂日常操作归并到前类", () => {
  const out = compactTimeline([
    ev(9, 0, "用户在观看网课讲解数学"),
    ev(9, 3, "打开了一个普通窗口看了看"), // 日常操作，前后都是课程且间隔 ≤10 分钟
    ev(9, 6, "继续观看网课讲解导数"),
  ]);
  assert.match(out, /\[课程学习，记录3条\]/);
});

test("compactTimeline：每桶细节数上限 4 条", () => {
  const events = [];
  for (let i = 0; i < 6; i++) {
    events.push(ev(9, i * 10, `课程内容：第${i + 1}章讲解知识点，要点各不相同${i}`));
  }
  const out = compactTimeline(events, 2800);
  assert.equal(out.split("\n").length, 1); // 同一桶
  const details = out.slice(out.indexOf("] ") + 2);
  assert.equal(details.split("；").length, 4);
});

test("compactTimeline：字符预算压缩细节长度", () => {
  // limit=200、1 桶 → 细节上限 max(36, (200-72)/4)=36 字符
  const longText = "课程内容：" + "详".repeat(500);
  const out = compactTimeline([ev(9, 0, longText)], 200);
  const details = out.slice(out.indexOf("] ") + 2);
  assert.ok(details.length <= 36, `细节应被预算截断，实际 ${details.length} 字`);
  assert.ok(details.includes("课程"));
});

// —— summaryCovers ——
const firstEvent = ev(9, 0, "开始");
const lastEvent = ev(10, 30, "结束");

test("summaryCovers：覆盖首尾时间点且句末有标点则通过", () => {
  assert.equal(summaryCovers("09:00至10:30，用户在学习课程。", firstEvent, lastEvent), true);
});

test("summaryCovers：缺首时间点附近的时间则拒绝", () => {
  assert.equal(summaryCovers("10:20至10:30，用户在学习课程。", firstEvent, lastEvent), false);
});

test("summaryCovers：缺尾时间点附近的时间则拒绝", () => {
  assert.equal(summaryCovers("09:00至09:50，用户在学习课程。", firstEvent, lastEvent), false);
});

test("summaryCovers：缺句末标点或没有时间点则拒绝", () => {
  assert.equal(summaryCovers("09:00至10:30，用户在学习课程", firstEvent, lastEvent), false);
  assert.equal(summaryCovers("用户一整天都在学习课程。", firstEvent, lastEvent), false);
});

// —— cleanActivityText ——
test("cleanActivityText：压缩空白、丢弃过短与不确定表述、截 240 字", () => {
  assert.equal(cleanActivityText("  用户在  编写\n代码  "), "用户在 编写 代码");
  assert.equal(cleanActivityText("太短了"), "");
  assert.equal(cleanActivityText("画面内容无法判断是什么情况"), "");
  assert.equal(cleanActivityText("字".repeat(300)).length, 240);
});

// —— MemoryActivityRecorder 五道门槛（clock 注入）——
function makeRecorder() {
  const events = [];
  const state = { now: 1000 };
  const recorder = new MemoryActivityRecorder({
    store: {
      appendEvent(e) {
        events.push(e);
        return e;
      },
    },
    clock: () => state.now,
  });
  return { recorder, events, advance: (s) => (state.now += s) };
}

test("recorder：低置信度直接丢弃", () => {
  const { recorder, events } = makeRecorder();
  const result = recorder.record({
    scene: "other",
    confidence: 0.5, // < 0.6
    text: "用户在浏览普通网页内容",
  });
  assert.equal(result, null);
  assert.equal(events.length, 0);
});

test("recorder：清洗后不足 8 字直接丢弃", () => {
  const { recorder, events } = makeRecorder();
  const result = recorder.record({ scene: "other", confidence: 0.9, text: "太短了" });
  assert.equal(result, null);
  assert.equal(events.length, 0);
});

test("recorder：course 场景空描述时用课程标题兜底", () => {
  const { recorder, events } = makeRecorder();
  const result = recorder.record({
    scene: "course",
    confidence: 0.9,
    text: "",
    courseTitle: "高等数学·微积分基础",
  });
  assert.ok(result);
  assert.equal(events[0].text, "正在学习课程：高等数学·微积分基础");
});

test("recorder：同场景 120s 节流，超窗放行", () => {
  const { recorder, events, advance } = makeRecorder();
  assert.ok(recorder.record({ scene: "other", confidence: 0.9, text: "用户在编写项目代码并调试程序" }));

  advance(60); // 60s < 120s，同场景被节流
  assert.equal(
    recorder.record({ scene: "other", confidence: 0.9, text: "用户在观看在线电影片段内容" }),
    null
  );
  assert.equal(events.length, 1);

  advance(61); // 累计 121s > 120s，且文本不相似，放行
  assert.ok(
    recorder.record({ scene: "other", confidence: 0.9, text: "用户在观看在线电影片段内容" })
  );
  assert.equal(events.length, 2);
});

test("recorder：不同场景不受同场景节流限制", () => {
  const { recorder, events, advance } = makeRecorder();
  assert.ok(recorder.record({ scene: "game", confidence: 0.9, text: "玩家正在操作角色攻击怪物" }));
  advance(10);
  assert.ok(recorder.record({ scene: "other", confidence: 0.9, text: "用户在编写项目代码并调试程序" }));
  assert.equal(events.length, 2);
});

test("recorder：900s 内相似文本去重，超窗放行", () => {
  const { recorder, events, advance } = makeRecorder();
  assert.ok(recorder.record({ scene: "other", confidence: 0.9, text: "用户正在浏览哔哩哔哩视频" }));

  advance(200); // 过了 120s 节流，但 900s 内文本相似 → 去重
  assert.equal(
    recorder.record({ scene: "other", confidence: 0.9, text: "用户正在浏览哔哩哔哩的视频" }),
    null
  );
  assert.equal(events.length, 1);

  advance(801); // 累计 1001s > 900s 窗口，相似文本也放行
  assert.ok(
    recorder.record({ scene: "other", confidence: 0.9, text: "用户正在浏览哔哩哔哩的视频" })
  );
  assert.equal(events.length, 2);
});

// —— 节流按场景分槽（回归：单槽实现下场景交替会让两道闸门同时失效）——
// sceneStabilizer 只需连续 2 帧就翻面，"看游戏实况视频"会让 scene 在 game/other 之间反复
// 抖动。单槽实现里节流与去重都带"与上一次场景相同"的前置条件，交替时每次 record 都直落
// store.appendEvent（主进程同步 fsync），事件量暴涨 10 倍以上，把 store.js 的轮转窗口从
// ~42 天压到几天 —— 回补历史天的记忆会因为源数据被轮转掉而静默丢失。
test("recorder：场景在 game/other 之间交替时，各自的 120s 节流仍然生效（不被穿透）", () => {
  const { recorder, events, advance } = makeRecorder();
  // 首轮两个场景各记一条（各自开窗）
  assert.ok(recorder.record({ scene: "game", confidence: 0.9, text: "玩家正在操作角色攻击怪物" }));
  advance(10);
  assert.ok(recorder.record({ scene: "other", confidence: 0.9, text: "用户在编写项目代码并调试程序" }));
  assert.equal(events.length, 2);

  // 之后交替喂 5 轮（每轮 game/other 各一次、各间隔 10s，全部落在两个槽各自的 120s 窗口内）：
  // 单槽实现下这 10 次会全部落库（每次 scene 都 ≠ 上一次，两道闸门同时被跳过）
  for (let i = 0; i < 5; i++) {
    advance(10);
    assert.equal(
      recorder.record({ scene: "game", confidence: 0.9, text: `玩家正在操作角色释放技能第${i}次` }),
      null,
      "game 槽仍在 120s 节流窗口内，必须被拦下"
    );
    advance(10);
    assert.equal(
      recorder.record({ scene: "other", confidence: 0.9, text: `用户在编写项目代码修改模块${i}` }),
      null,
      "other 槽仍在 120s 节流窗口内，必须被拦下"
    );
  }
  assert.equal(events.length, 2, "场景交替不得穿透节流（单槽实现这里会是 12）");
});

test("recorder：分槽后同场景节流依旧生效，且一个场景的记录不重置另一个场景的窗口", () => {
  const { recorder, events, advance } = makeRecorder();
  assert.ok(recorder.record({ scene: "game", confidence: 0.9, text: "玩家正在操作角色攻击怪物" }));

  advance(130); // game 已过 120s；先让 other 记一条，不能因此重置 game 的计时
  assert.ok(recorder.record({ scene: "other", confidence: 0.9, text: "用户在编写项目代码并调试程序" }));
  assert.ok(
    recorder.record({ scene: "game", confidence: 0.9, text: "玩家正在驾驶载具穿越城市街道" }),
    "game 槽自己的窗口已过期，必须放行"
  );
  assert.equal(events.length, 3);

  advance(60); // game 槽刚记录过，60s < 120s
  assert.equal(
    recorder.record({ scene: "game", confidence: 0.9, text: "玩家正在整理背包里的道具装备" }),
    null,
    "同场景节流不得因为改成 Map 而失灵"
  );
  assert.equal(events.length, 3);
});

test("recorder：场景值异常增长时槽位有上限，不会无限占用内存", () => {
  const { recorder, advance } = makeRecorder();
  for (let i = 0; i < 50; i++) {
    advance(1);
    recorder.record({ scene: `weird-${i}`, confidence: 0.9, text: `外部传入的异常场景值第${i}次` });
  }
  assert.ok(
    recorder.lastByScene.size <= MAX_THROTTLE_SLOTS,
    `槽位数必须钉在 ${MAX_THROTTLE_SLOTS} 以内，实际 ${recorder.lastByScene.size}`
  );
});

test("recorder：系统时钟被回拨时事件不被静默丢弃（放行并留日志）", () => {
  const { recorder, events, advance } = makeRecorder();
  assert.ok(recorder.record({ scene: "other", confidence: 0.9, text: "用户在编写项目代码并调试程序" }));

  advance(-3600); // NTP 大步长校正 / 用户手动改时间：回拨一小时
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.map((a) => String(a)).join(" "));
  let result;
  try {
    result = recorder.record({ scene: "other", confidence: 0.9, text: "用户在观看在线电影片段内容" });
  } finally {
    console.warn = origWarn;
  }
  assert.ok(result, "时钟回拨期间的记忆事件绝不能被静默吞掉");
  assert.equal(events.length, 2);
  assert.equal(warns.length, 1, "回拨必须留下一条可检索的日志");
  assert.match(warns[0], /\[memory\/activity\] .*时钟回拨/);

  // 放行时已用新的 now 重新计时：紧接着的同场景写入照旧被节流，不会变成"每次都放行"
  advance(30);
  assert.equal(
    recorder.record({ scene: "other", confidence: 0.9, text: "用户在整理硬盘里的照片文件" }),
    null,
    "回拨放行后必须以新时钟重新开窗"
  );
  assert.equal(events.length, 2);
});

// —— MemoryStore（临时目录）——
test("MemoryStore：appendEvent/readEvents 往返与按天过滤", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqstore-"));
  try {
    const store = new MemoryStore(root);
    const dayA = localDayString(new Date(2025, 5, 10, 10, 0));
    const dayB = localDayString(new Date(2025, 5, 11, 10, 0));
    const e1 = store.appendEvent({
      kind: "activity",
      text: "第一天的活动",
      timestamp: new Date(2025, 5, 10, 10, 0).toISOString(),
      metadata: { scene: "other" },
    });
    store.appendEvent({
      kind: "activity",
      text: "第二天的活动",
      timestamp: new Date(2025, 5, 11, 10, 0).toISOString(),
    });
    assert.ok(e1.id && e1.timestamp.endsWith("Z"));

    assert.equal(store.readEvents().length, 2);
    const onlyA = store.readEvents({ day: dayA });
    assert.equal(onlyA.length, 1);
    assert.equal(onlyA[0].text, "第一天的活动");
    assert.equal(store.readEvents({ day: dayB }).length, 1);
    assert.equal(store.readEvents({ day: "2020-01-01" }).length, 0);

    assert.throws(() => store.appendEvent({ kind: "", text: "x" }));
    assert.throws(() => store.appendEvent({ kind: "activity", text: " " }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MemoryStore：writeDaily/readDaily 与 memoryDays 聚合", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqstore-"));
  try {
    const store = new MemoryStore(root);
    store.appendEvent({
      kind: "activity",
      text: "某天的活动",
      timestamp: new Date(2025, 5, 10, 10, 0).toISOString(),
    });
    const eventDay = localDayString(new Date(2025, 5, 10, 10, 0));

    store.writeDaily("2025-06-11", "# 2025-06-11 的记忆\n\n正文");
    assert.match(store.readDaily("2025-06-11"), /正文/);
    assert.equal(store.readDaily("2025-06-12"), null);

    const days = store.memoryDays();
    assert.ok(days.includes(eventDay));
    assert.ok(days.includes("2025-06-11"));
    assert.deepEqual([...days].sort().reverse(), days); // 倒序
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MemoryStore：writeDaily 为原子写，目录不留 .tmp 残留", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqstore-"));
  try {
    const store = new MemoryStore(root);
    store.writeDaily("2025-06-10", "第一版");
    store.writeDaily("2025-06-10", "第二版覆盖");
    assert.match(store.readDaily("2025-06-10"), /第二版覆盖/);
    const leftovers = fs
      .readdirSync(path.join(root, "daily"))
      .filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MemoryStore：writeSummary/readSummary 往返（原子 JSON 写）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqstore-"));
  try {
    const store = new MemoryStore(root);
    assert.equal(store.readSummary(), null);
    store.writeSummary("用户一整天主要在写代码。", "abc123");
    assert.equal(store.readSummary(), "用户一整天主要在写代码。");
    const summary = JSON.parse(fs.readFileSync(store.summaryPath, "utf8"));
    assert.equal(summary.through_event_id, "abc123");
    assert.ok(summary.updated_at.endsWith("Z"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
