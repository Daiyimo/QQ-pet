// MemoryStore 磁盘边界与读取路径测试：events.jsonl 轮转、按天索引读取、
// 增量尾部读缓存、损坏数据降级。全部走临时目录，不触碰真实 userData。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MemoryStore,
  localDayString,
  EVENTS_MAX_BYTES,
  EVENTS_ROTATE_KEEP,
} = require("../src/service/memory/store.js");

// 临时根目录 + 用后即删（不污染 cwd/memory 与真实 userData）
function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqstore-bound-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 捕获 console.warn/error：既屏蔽测试噪音，又能断言"降级必须记日志"
function captureConsole(fn) {
  const logs = { warn: [], error: [] };
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => logs.warn.push(args.map((a) => String(a)).join(" "));
  console.error = (...args) => logs.error.push(args.map((a) => String(a)).join(" "));
  try {
    fn(logs);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  return logs;
}

// 本地时间构造事件时间戳（按本地时区归日，与 store.localDayString 一致）
function localIso(year, monthIndex, day, hour = 10, minute = 0) {
  return new Date(year, monthIndex, day, hour, minute).toISOString();
}

function appendN(store, count, timestamp) {
  for (let i = 0; i < count; i++) {
    store.appendEvent({
      kind: "activity",
      text: `第 ${i} 条测试活动内容`,
      timestamp,
      metadata: { scene: "other" },
    });
  }
}

// —— 默认上限常量：只校验存在且量级合理，具体依据见 store.js 注释 ——
test("events 轮转常量为命名常量且量级合理", () => {
  assert.equal(EVENTS_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(EVENTS_ROTATE_KEEP, 2);
});

// —— 轮转 ——
test("events.jsonl 超过字节上限时轮转并只保留限定份数归档", () => {
  withTempRoot((root) => {
    // 注入极小阈值，避免测试真的写满 4 MiB
    const store = new MemoryStore(root, { eventsMaxBytes: 500, eventsRotateKeep: 2 });
    const logs = captureConsole(() => {
      appendN(store, 40, localIso(2025, 5, 10));
    });

    const archive = (n) => path.join(root, `events.${n}.jsonl`);
    assert.equal(fs.existsSync(archive(1)), true, "应产生 events.1.jsonl");
    assert.equal(fs.existsSync(archive(2)), true, "应产生 events.2.jsonl");
    assert.equal(fs.existsSync(archive(3)), false, "超出保留份数的归档必须被丢弃");
    // 现役文件始终被上限压住
    assert.ok(
      fs.statSync(store.eventsPath).size <= 500,
      `现役 events.jsonl 应 ≤500 字节，实际 ${fs.statSync(store.eventsPath).size}`
    );
    // 磁盘总占用 = 现役 + 2 份归档，有明确上界
    const total = [store.eventsPath, archive(1), archive(2)].reduce(
      (sum, p) => sum + fs.statSync(p).size,
      0
    );
    assert.ok(total <= 3 * 500 + 200, `总占用应有上界，实际 ${total}`);
    assert.ok(
      logs.warn.some((m) => m.includes("已轮转归档")),
      "轮转必须留告警日志"
    );
  });
});

test("轮转后 readEvents 只返回现役文件内容且缓存已失效", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root, { eventsMaxBytes: 400, eventsRotateKeep: 1 });
    captureConsole(() => {
      appendN(store, 5, localIso(2025, 5, 10));
      // 先读一次把缓存建起来，再触发轮转，验证缓存不会返回已归档的旧事件
      assert.ok(store.readEvents().length >= 1);
      appendN(store, 20, localIso(2025, 5, 10));
    });
    const events = store.readEvents();
    assert.ok(events.length > 0, "轮转后仍应能读到现役事件");
    assert.ok(events.length < 25, `不应返回已归档事件，实际 ${events.length}`);
    // 现役文件里的行数与 readEvents 结果一致
    const lines = fs
      .readFileSync(store.eventsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    assert.equal(events.length, lines.length);
  });
});

test("轮转失败不吞事件：归档路径被占位时仍继续追加并记日志", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root, { eventsMaxBytes: 300, eventsRotateKeep: 1 });
    // 用目录占住 events.1.jsonl，使 rename 失败
    fs.mkdirSync(path.join(root, "events.1.jsonl"), { recursive: true });
    fs.writeFileSync(path.join(root, "events.1.jsonl", "占位.txt"), "x");
    const logs = captureConsole(() => {
      appendN(store, 10, localIso(2025, 5, 10));
    });
    assert.ok(
      logs.error.some((m) => m.includes("轮转失败")),
      "轮转失败必须记 error 日志（含堆栈），不能静默"
    );
    assert.equal(store.readEvents().length, 10, "轮转失败也不能丢事件");
  });
});

// —— 按天读取 ——
test("readEvents 按天返回当天事件且不受其他天影响", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root);
    const dayA = localDayString(new Date(2025, 5, 10));
    const dayB = localDayString(new Date(2025, 5, 11));
    const dayC = localDayString(new Date(2025, 5, 12));
    store.appendEvent({ kind: "activity", text: "A1", timestamp: localIso(2025, 5, 10, 9) });
    store.appendEvent({ kind: "activity", text: "A2", timestamp: localIso(2025, 5, 10, 20) });
    store.appendEvent({ kind: "activity", text: "B1", timestamp: localIso(2025, 5, 11, 9) });

    assert.deepEqual(
      store.readEvents({ day: dayA }).map((e) => e.text),
      ["A1", "A2"]
    );
    assert.deepEqual(
      store.readEvents({ day: dayB }).map((e) => e.text),
      ["B1"]
    );
    assert.deepEqual(store.readEvents({ day: dayC }), []);
    assert.deepEqual(store.readEvents({ day: "2020-01-01" }), []);
    assert.equal(store.readEvents().length, 3);
    // 非法 day 视为不过滤（与旧行为一致）
    assert.equal(store.readEvents({ day: "not-a-day" }).length, 3);
  });
});

test("readEvents 增量读取新追加的事件", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root);
    const day = localDayString(new Date(2025, 5, 10));
    store.appendEvent({ kind: "activity", text: "第一条", timestamp: localIso(2025, 5, 10, 9) });
    assert.equal(store.readEvents({ day }).length, 1); // 建立缓存
    store.appendEvent({ kind: "activity", text: "第二条", timestamp: localIso(2025, 5, 10, 10) });
    assert.deepEqual(
      store.readEvents({ day }).map((e) => e.text),
      ["第一条", "第二条"],
      "增量读取应带出新追加的事件且保持顺序"
    );
    assert.equal(store.readEvents().length, 2);
  });
});

test("readEvents 返回副本，调用方改动不影响后续读取", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root);
    const day = localDayString(new Date(2025, 5, 10));
    store.appendEvent({ kind: "activity", text: "原始", timestamp: localIso(2025, 5, 10, 9) });
    const first = store.readEvents({ day });
    first.push({ text: "外部塞进来的" });
    assert.equal(store.readEvents({ day }).length, 1);
  });
});

test("外部截断 events.jsonl 后缓存整体重建", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root);
    const day = localDayString(new Date(2025, 5, 10));
    appendN(store, 5, localIso(2025, 5, 10));
    assert.equal(store.readEvents({ day }).length, 5); // 建立缓存
    // 原地截断为一行（size 变小 → 必须重建，不能沿用旧缓存）
    const firstLine = fs.readFileSync(store.eventsPath, "utf8").split("\n")[0];
    fs.writeFileSync(store.eventsPath, firstLine + "\n");
    assert.equal(store.readEvents({ day }).length, 1);
    assert.equal(store.readEvents().length, 1);
  });
});

test("events.jsonl 被删除后 readEvents 返回空而不抛错", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root);
    appendN(store, 3, localIso(2025, 5, 10));
    assert.equal(store.readEvents().length, 3);
    fs.rmSync(store.eventsPath, { force: true });
    assert.deepEqual(store.readEvents(), []);
    assert.deepEqual(store.memoryDays(), []);
  });
});

// —— 损坏数据降级 ——
test("损坏的事件行被跳过并记告警，其余事件照常返回", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root);
    const day = localDayString(new Date(2025, 5, 10));
    store.appendEvent({ kind: "activity", text: "好行1", timestamp: localIso(2025, 5, 10, 9) });
    assert.equal(store.readEvents({ day }).length, 1); // 先建缓存，覆盖增量解析路径

    const logs = captureConsole(() => {
      fs.appendFileSync(store.eventsPath, '{"id":"broken","timestamp":\n', "utf8");
      fs.appendFileSync(store.eventsPath, "不是 JSON 的一行\n", "utf8");
      store.appendEvent({ kind: "activity", text: "好行2", timestamp: localIso(2025, 5, 10, 11) });
      assert.deepEqual(
        store.readEvents({ day }).map((e) => e.text),
        ["好行1", "好行2"],
        "损坏行必须跳过而不是整文件失败"
      );
    });
    assert.ok(
      logs.warn.filter((m) => m.includes("跳过损坏的事件行")).length >= 2,
      "每个损坏行都要留告警"
    );
  });
});

test("半行与多字节字符切断在补齐后能正确解析", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root);
    const day = localDayString(new Date(2025, 5, 10));
    store.appendEvent({ kind: "activity", text: "已有事件", timestamp: localIso(2025, 5, 10, 9) });
    assert.equal(store.readEvents({ day }).length, 1);

    const line = Buffer.from(
      JSON.stringify({
        id: "half01",
        timestamp: localIso(2025, 5, 10, 12),
        kind: "activity",
        text: "中文补齐事件",
        metadata: {},
      }) + "\n",
      "utf8"
    );
    // 故意切在"中"字的多字节编码中间，模拟断电半行 + 增量读边界
    const cut = line.indexOf(Buffer.from("中", "utf8")) + 1;
    fs.appendFileSync(store.eventsPath, line.subarray(0, cut));
    const logs = captureConsole(() => {
      assert.equal(store.readEvents({ day }).length, 1, "未等到换行的半行不应产出事件");
    });
    assert.deepEqual(logs.warn, [], "半行未闭合时不应误报损坏");

    fs.appendFileSync(store.eventsPath, line.subarray(cut));
    assert.deepEqual(
      store.readEvents({ day }).map((e) => e.text),
      ["已有事件", "中文补齐事件"]
    );
  });
});

test("时间戳无法归日的事件不进按天索引但仍在全量结果中", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root);
    const day = localDayString(new Date(2025, 5, 10));
    store.appendEvent({ kind: "activity", text: "正常", timestamp: localIso(2025, 5, 10, 9) });
    const logs = captureConsole(() => {
      fs.appendFileSync(
        store.eventsPath,
        JSON.stringify({ id: "bad-ts", timestamp: "不是时间", kind: "activity", text: "坏时间" }) +
          "\n",
        "utf8"
      );
      assert.equal(store.readEvents({ day }).length, 1);
      assert.equal(store.readEvents().length, 2);
    });
    assert.ok(logs.warn.some((m) => m.includes("无法归日")), "无法归日必须告警");
  });
});

test("summary.json 损坏时 readSummary 降级为 null 并记 error", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root);
    store.writeSummary("正常的总结文本。", "eid1");
    assert.equal(store.readSummary(), "正常的总结文本。");
    fs.writeFileSync(store.summaryPath, "{半截的 json", "utf8");
    const logs = captureConsole(() => {
      assert.equal(store.readSummary(), null, "损坏的 summary.json 不能抛错阻断链路");
    });
    assert.ok(
      logs.error.some((m) => m.includes("summary.json 解析失败")),
      "损坏降级必须记 error 日志"
    );
  });
});

// —— memoryDays 走按天索引 ——
test("memoryDays 合并事件天与 daily/daily-images 并倒序返回", () => {
  withTempRoot((root) => {
    const store = new MemoryStore(root);
    const eventDay = localDayString(new Date(2025, 5, 10));
    store.appendEvent({ kind: "activity", text: "某天活动", timestamp: localIso(2025, 5, 10, 9) });
    store.writeDaily("2025-06-01", "# 2025-06-01 的记忆\n\n正文");
    store.writeDailyImage("2025-06-02", "plan.png", Buffer.from([1, 2, 3]), { note: "x" });

    const days = store.memoryDays();
    assert.ok(days.includes(eventDay));
    assert.ok(days.includes("2025-06-01"));
    assert.ok(days.includes("2025-06-02"));
    assert.deepEqual([...days].sort().reverse(), days, "应为倒序");
    assert.equal(new Set(days).size, days.length, "不应有重复天");
  });
});
