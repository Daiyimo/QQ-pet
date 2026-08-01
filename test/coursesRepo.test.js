// CourseRepo 磁盘边界与降级测试：会话总数裁剪、关键帧张数/字节上限、
// transcript.md 字节上限、state.json 损坏降级。全部走临时目录，不触碰真实 userData。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CourseRepo,
  MAX_SESSION_COUNT,
  MAX_KEYFRAMES_PER_SESSION,
  FRAMES_MAX_TOTAL_BYTES,
  TRANSCRIPT_MAX_BYTES,
  STATE_FLUSH_EVERY_APPENDS,
  STATE_FLUSH_INTERVAL_MS,
  SUMMARY_CHUNK_CACHE_MAX_PARTS,
} = require("../src/service/courses/repo.js");

function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqcourses-"));
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

// 建一个已完成的会话，并写入确定的 created_at（保证裁剪顺序可断言）
function makeFinishedSession(repo, id, createdAt) {
  const state = repo.createSession({ title: `课程 ${id}`, sessionId: id });
  state.status = "complete";
  state.created_at = createdAt;
  repo.saveState(id, state);
  return state;
}

function sessionIds(repo) {
  return repo.listSessions().map((s) => s.id).sort();
}

// —— 默认上限常量 ——
test("课程磁盘上限均为命名常量且量级合理", () => {
  assert.equal(MAX_SESSION_COUNT, 20);
  assert.equal(MAX_KEYFRAMES_PER_SESSION, 40);
  assert.equal(FRAMES_MAX_TOTAL_BYTES, 24 * 1024 * 1024);
  assert.equal(TRANSCRIPT_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(STATE_FLUSH_EVERY_APPENDS, 20);
  assert.equal(STATE_FLUSH_INTERVAL_MS, 30 * 1000);
  assert.equal(SUMMARY_CHUNK_CACHE_MAX_PARTS, 80);
});

// —— 会话总数上限 ——
test("会话数超过上限时删除最旧的已结束会话", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root, { maxSessionCount: 3 });
    makeFinishedSession(repo, "s1", "2025-01-01T00:00:00.000Z");
    makeFinishedSession(repo, "s2", "2025-01-02T00:00:00.000Z");
    makeFinishedSession(repo, "s3", "2025-01-03T00:00:00.000Z");
    assert.deepEqual(sessionIds(repo), ["s1", "s2", "s3"]);

    // 第 4 个会话触发裁剪：最旧的 s1 被清理
    const logs = captureConsole(() => {
      repo.createSession({ title: "第四节课", sessionId: "s4" });
    });
    assert.deepEqual(sessionIds(repo), ["s2", "s3", "s4"]);
    assert.equal(fs.existsSync(path.join(root, "s1")), false, "最旧会话目录应被整体删除");
    assert.ok(
      logs.warn.some((m) => m.includes("已清理最旧会话 s1")),
      "裁剪必须留告警日志"
    );
  });
});

test("裁剪不会删除正在录制的会话", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root, { maxSessionCount: 2 });
    // 三个都处于 recording（默认状态），无可删对象
    repo.createSession({ title: "课1", sessionId: "r1" });
    repo.createSession({ title: "课2", sessionId: "r2" });
    const logs = captureConsole(() => {
      repo.createSession({ title: "课3", sessionId: "r3" });
    });
    assert.deepEqual(sessionIds(repo), ["r1", "r2", "r3"], "录制中的会话不能被删");
    assert.ok(
      logs.warn.some((m) => m.includes("未清理")),
      "无法裁剪时必须告知仍然超限"
    );
  });
});

test("会话数在上限内时不做任何删除", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root, { maxSessionCount: 5 });
    makeFinishedSession(repo, "k1", "2025-01-01T00:00:00.000Z");
    makeFinishedSession(repo, "k2", "2025-01-02T00:00:00.000Z");
    assert.deepEqual(sessionIds(repo), ["k1", "k2"]);
  });
});

// —— 关键帧上限 ——
test("关键帧张数达到上限后拒绝入库", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root, { maxKeyframes: 2 });
    const { id } = repo.createSession({ title: "帧数上限课" });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    repo.addKeyframe(id, { timestampMs: 0, pngBuffer: png });
    repo.addKeyframe(id, { timestampMs: 1000, pngBuffer: png });
    assert.throws(
      () => repo.addKeyframe(id, { timestampMs: 2000, pngBuffer: png }),
      /keyframe limit reached/
    );
    assert.equal(repo.getState(id).keyframes.length, 2);
    assert.equal(fs.readdirSync(repo._framesDir(id)).length, 2, "被拒的帧不应落盘");
  });
});

test("关键帧总字节达到上限后拒绝入库", () => {
  withTempRoot((root) => {
    // 张数上限放宽，只让字节上限生效
    const repo = new CourseRepo(root, { maxKeyframes: 40, framesMaxTotalBytes: 100 });
    const { id } = repo.createSession({ title: "帧字节上限课" });
    const png = Buffer.alloc(60, 7);
    repo.addKeyframe(id, { timestampMs: 0, pngBuffer: png });
    assert.throws(
      () => repo.addKeyframe(id, { timestampMs: 1000, pngBuffer: png }),
      /keyframe size limit reached/,
      "60 + 60 > 100，第二张必须被字节上限挡住"
    );
    assert.equal(repo.getState(id).keyframes.length, 1);
    const used = fs
      .readdirSync(repo._framesDir(id))
      .reduce((sum, name) => sum + fs.statSync(path.join(repo._framesDir(id), name)).size, 0);
    assert.ok(used <= 100, `frames/ 占用应 ≤100 字节，实际 ${used}`);
  });
});

test("关键帧正常入库时文件名与元数据符合约定", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root);
    const { id } = repo.createSession({ title: "正常帧课" });
    const item = repo.addKeyframe(id, {
      timestampMs: 1234.9,
      pngBuffer: Buffer.from([1, 2, 3]),
      note: "  黑板上的公式  ",
    });
    assert.equal(item.filename, "000001-000000001234.png");
    assert.equal(item.timestamp_ms, 1234);
    assert.equal(item.metadata.note, "黑板上的公式");
    assert.equal(fs.existsSync(path.join(repo._framesDir(id), item.filename)), true);
  });
});

// —— transcript 上限 ——
test("transcript 超过字节上限后丢弃追加并告警", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root, { transcriptMaxBytes: 80 });
    const { id } = repo.createSession({ title: "转写上限课" });
    repo.appendTranscript(id, "a".repeat(60)); // 61 字节，通过
    const before = fs.readFileSync(repo._transcriptPath(id), "utf8");
    const logs = captureConsole(() => {
      const state = repo.appendTranscript(id, "b".repeat(60)); // 会超 80，丢弃
      assert.equal(state.status, "recording", "超限只丢弃追加，不改变会话状态");
    });
    const after = fs.readFileSync(repo._transcriptPath(id), "utf8");
    assert.equal(after, before, "超限的追加不应落盘");
    assert.ok(fs.statSync(repo._transcriptPath(id)).size <= 80);
    assert.ok(
      logs.warn.some((m) => m.includes("transcript.md 已达")),
      "丢弃追加必须留告警日志，不能静默"
    );
  });
});

test("transcript 正常追加自动补换行并可回读", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root);
    const { id } = repo.createSession({ title: "正常转写课" });
    repo.appendTranscript(id, "第一段讲解");
    repo.appendTranscript(id, "第二段讲解\n");
    assert.equal(repo.readTranscript(id), "第一段讲解\n第二段讲解\n");
    assert.throws(() => {
      const state = repo.getState(id);
      state.status = "complete";
      repo.saveState(id, state);
      repo.appendTranscript(id, "结束后不能再写");
    }, /session is not recording/);
  });
});

// —— 损坏 state.json 降级 ——
test("state.json 损坏时 getState 抛出可识别错误并记 error", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root);
    const { id } = repo.createSession({ title: "损坏课" });
    fs.writeFileSync(repo._statePath(id), "{不是合法 json", "utf8");
    const logs = captureConsole(() => {
      assert.throws(() => repo.getState(id), /state\.json corrupted/);
    });
    assert.ok(
      logs.error.some((m) => m.includes("state.json 解析失败")),
      "解析失败必须记 error 日志（含堆栈）"
    );
  });
});

test("单个会话损坏不阻断 listSessions/findRecordingSession/recoverable", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root);
    repo.createSession({ title: "好会话1", sessionId: "ok1" });
    const bad = repo.createSession({ title: "坏会话", sessionId: "bad1" });
    makeFinishedSession(repo, "done1", "2025-01-01T00:00:00.000Z");
    fs.writeFileSync(repo._statePath(bad.id), "{半截 json", "utf8");
    // 再放一个缺 state.json 的空目录，模拟半途中断
    fs.mkdirSync(path.join(root, "empty1"), { recursive: true });

    const logs = captureConsole(() => {
      assert.deepEqual(sessionIds(repo), ["done1", "ok1"], "损坏会话被跳过，其余照常列出");
      assert.equal(repo.findRecordingSession().id, "ok1");
      assert.deepEqual(repo.recoverable(), []);
    });
    assert.ok(
      logs.warn.some((m) => m.includes("跳过无法读取的会话目录 bad1")),
      "跳过损坏会话必须告警，不能静默吞"
    );
    assert.ok(logs.warn.some((m) => m.includes("empty1")), "缺 state.json 的目录也要告警");
  });
});

test("非法会话 id 被拒绝（防目录穿越）", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root);
    assert.throws(() => repo.getState("../escape"), /invalid session id/);
    assert.throws(() => repo.createSession({ title: "x", sessionId: "a/b" }), /invalid session id/);
    assert.throws(() => repo.createSession({ title: "  " }), /title must be non-empty/);
  });
});

// —— 录课热路径的写盘节流（appendTranscript 的 state 缓存）——
// 计数桩：repo.js 与本文件拿到的是同一个 fs 模块对象，包一层即可统计真实系统调用次数。
// state.json 的原子写以 renameSync(tmp → state.json) 收尾，据此区分转写 fsync 与 state 落盘。
function countDiskWrites(fn) {
  const counts = { fsync: 0, stateWrites: 0 };
  const originalFsync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  fs.fsyncSync = (fd) => {
    counts.fsync += 1;
    return originalFsync(fd);
  };
  fs.renameSync = (from, to) => {
    if (String(to).endsWith("state.json")) counts.stateWrites += 1;
    return originalRename(from, to);
  };
  try {
    fn(counts);
  } finally {
    fs.fsyncSync = originalFsync;
    fs.renameSync = originalRename;
  }
  return counts;
}

test("appendTranscript 按追加次数阈值节流 state.json 落盘（fsync 次数实测下降）", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root, {
      stateFlushEveryAppends: 5,
      stateFlushIntervalMs: 60 * 60 * 1000, // 只让次数阈值生效
    });
    const { id } = repo.createSession({ title: "热路径课" });
    const counts = countDiskWrites(() => {
      for (let i = 0; i < 20; i++) repo.appendTranscript(id, `第 ${i} 段转写`);
    });
    assert.equal(counts.stateWrites, 4, "20 次追加 / 阈值 5 → state.json 只重写 4 次（改前 20 次）");
    assert.equal(counts.fsync, 24, "fsync = 20 次转写追加 + 4 次 state 落盘（改前 40 次）");
    const text = repo.readTranscript(id);
    for (let i = 0; i < 20; i++) {
      assert.match(text, new RegExp(`第 ${i} 段转写`), "节流不得丢任何一段转写");
    }
    assert.equal(repo.getState(id).status, "recording");
  });
});

test("state 落盘被节流时，转写正文仍每次追加都立即 fsync 落盘", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root, {
      stateFlushEveryAppends: 100,
      stateFlushIntervalMs: 60 * 60 * 1000,
    });
    const { id } = repo.createSession({ title: "持久性课" });
    const stateBefore = fs.readFileSync(repo._statePath(id), "utf8");
    const counts = countDiskWrites(() => {
      for (let i = 0; i < 3; i++) {
        repo.appendTranscript(id, `段落${i}`);
        assert.match(
          fs.readFileSync(repo._transcriptPath(id), "utf8"),
          new RegExp(`段落${i}`),
          "每次追加后正文必须已在磁盘上（崩溃只丢 updated_at，不丢内容）"
        );
      }
    });
    assert.equal(counts.stateWrites, 0, "未达任何阈值时一次 state.json 都不该重写");
    assert.equal(counts.fsync, 3, "只剩转写正文的 3 次 fsync");
    assert.equal(
      fs.readFileSync(repo._statePath(id), "utf8"),
      stateBefore,
      "state.json 内容原封不动（这正是被牺牲的 updated_at 精度）"
    );
  });
});

test("appendTranscript 到达时间阈值也会把 state 落盘", () => {
  withTempRoot((root) => {
    let now = 1000000;
    const repo = new CourseRepo(root, {
      stateFlushEveryAppends: 1000, // 只让时间阈值生效
      stateFlushIntervalMs: 30 * 1000,
      now: () => now,
    });
    const { id } = repo.createSession({ title: "时间阈值课" });
    const counts = countDiskWrites(() => {
      repo.appendTranscript(id, "第一段"); // 建缓存
      repo.appendTranscript(id, "第二段"); // 同一时刻，不落盘
      now += 30 * 1000;
      repo.appendTranscript(id, "第三段"); // 跨过 30 秒窗口 → 落盘
      repo.appendTranscript(id, "第四段"); // 新窗口内，不再落盘
    });
    assert.equal(counts.stateWrites, 1, "30 秒窗口内只在跨窗口那一次落盘");
    assert.equal(counts.fsync, 5, "4 次转写追加 + 1 次 state 落盘");
  });
});

test("saveState 会让 recording 缓存失效：结稿中的会话不被缓存写回 recording", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root, {
      stateFlushEveryAppends: 100,
      stateFlushIntervalMs: 60 * 60 * 1000,
    });
    const { id } = repo.createSession({ title: "结稿并发课" });
    repo.appendTranscript(id, "结稿前的转写"); // 进缓存，state 尚未落盘
    const state = repo.getState(id);
    state.status = "finalizing";
    repo.saveState(id, state); // finalizing 原子落盘 → 缓存失效
    assert.throws(
      () => repo.appendTranscript(id, "结稿期间的转写"),
      /session is not recording/,
      "缓存不得让已结稿的会话继续被追加"
    );
    assert.equal(
      repo.getState(id).status,
      "finalizing",
      "磁盘上的 finalizing 不得被缓存里的 recording 覆盖回去"
    );
    assert.equal(repo.readTranscript(id), "结稿前的转写\n", "被拒的追加不应落盘");
  });
});

test("多会话交替追加时缓存只服务当前会话，转写互不串", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root, {
      stateFlushEveryAppends: 100,
      stateFlushIntervalMs: 60 * 60 * 1000,
    });
    const a = repo.createSession({ title: "课A", sessionId: "sa" });
    const b = repo.createSession({ title: "课B", sessionId: "sb" });
    repo.appendTranscript(a.id, "A1");
    repo.appendTranscript(b.id, "B1");
    repo.appendTranscript(a.id, "A2");
    assert.equal(repo.readTranscript(a.id), "A1\nA2\n");
    assert.equal(repo.readTranscript(b.id), "B1\n");
  });
});

// —— 块级总结缓存（多块总结的部分成功保留）——
test("块级总结缓存：命中、指纹失配、越界与缺文件（老会话）都按无缓存降级", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root);
    const { id } = repo.createSession({ title: "块缓存课" });
    const cachePath = path.join(root, id, "summary-chunks.json");

    // 老会话：没有 summary-chunks.json，必须按"无缓存"降级而不是抛错
    const fresh = repo.readSummaryChunkCache(id, 2);
    assert.deepEqual(fresh.parts, {});
    assert.equal(repo.cachedChunkSummary(fresh, 0, "块一"), null);

    repo.saveSummaryChunk(fresh, id, 0, "块一", "块一的提取结果");
    assert.equal(fs.existsSync(cachePath), true, "块结果必须落盘（走原子写）");
    const reloaded = repo.readSummaryChunkCache(id, 2);
    assert.equal(repo.cachedChunkSummary(reloaded, 0, "块一"), "块一的提取结果");
    assert.equal(
      repo.cachedChunkSummary(reloaded, 0, "块一的内容被改了"),
      null,
      "块内容变化后不得复用旧结果"
    );
    assert.equal(repo.cachedChunkSummary(reloaded, 1, "块二"), null, "未缓存的块必须未命中");
    assert.deepEqual(
      Object.keys(repo.readSummaryChunkCache(id, 0).parts),
      [],
      "转写变短后越界的旧块必须作废"
    );

    repo.clearSummaryChunkCache(id);
    assert.equal(fs.existsSync(cachePath), false, "清理必须真的删掉缓存文件");
    repo.clearSummaryChunkCache(id); // 再删一次（幂等，不抛错）

    fs.writeFileSync(cachePath, "{半截 json", "utf8");
    const logs = captureConsole(() => {
      assert.deepEqual(repo.readSummaryChunkCache(id, 2).parts, {}, "损坏缓存按无缓存降级");
    });
    assert.ok(
      logs.warn.some((m) => m.includes("块级总结缓存损坏")),
      "损坏缓存必须告警，不能静默"
    );
  });
});

test("块级总结缓存有块数上界，超限只告警一次且不再缓存新块", () => {
  withTempRoot((root) => {
    const repo = new CourseRepo(root, { summaryChunkCacheMaxParts: 2 });
    const { id } = repo.createSession({ title: "块上限课" });
    const cache = repo.readSummaryChunkCache(id, 5);
    const logs = captureConsole(() => {
      for (let i = 0; i < 5; i++) repo.saveSummaryChunk(cache, id, i, `块${i}`, `结果${i}`);
    });
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, id, "summary-chunks.json"), "utf8")
    );
    assert.deepEqual(Object.keys(persisted.parts), ["0", "1"], "超过上界的块不再缓存");
    assert.deepEqual(
      Object.keys(persisted).sort(),
      ["parts", "version"],
      "只落 version/parts，运行期标记不得进磁盘"
    );
    assert.equal(
      logs.warn.filter((m) => m.includes("块级总结缓存已达")).length,
      1,
      "超限只告警一次，不逐块刷屏"
    );
  });
});
