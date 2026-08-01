// courses/manager.js 无课程信号看门狗回归测试：
//   activity 桥（aiWiring）只在 confidence≥0.6 且 observation 非空时转发事件，
//   屏幕持续模糊时 handleNonCourse 一次都收不到，自动会话会无限拖延。
//   看门狗（SILENCE_TIMEOUT_MS 无课程信号即自动结束）不依赖任何感知事件。
// 时钟与定时器全部注入；第一组用例把 finishSession 换成桩（只测看门狗定时链），
// 第二组（文件下半部分）走真实结稿链路，专测总结失败/重试/僵尸收养。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CourseManager } = require("../src/service/courses/manager.js");
const { CourseRepo } = require("../src/service/courses/repo.js");

const SILENCE_TIMEOUT_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;

function makeRepo() {
  const states = {};
  let seq = 0;
  return {
    states,
    createSession: ({ title, sessionId }) => {
      const id = sessionId || `manual-${++seq}`;
      states[id] = {
        id,
        title,
        status: "recording",
        created_at: new Date().toISOString(),
        keyframes: [],
        summary: "",
      };
      return states[id];
    },
    getState: (id) => states[id],
    saveState: (id, s) => {
      states[id] = s;
    },
    findRecordingSession: () => null,
    appendTranscript: (id) => states[id],
    readTranscript: () => "",
  };
}

function makeWorld(opt = {}) {
  let now = opt.now || 1000000;
  const intervals = [];
  const repo = makeRepo();
  const mgr = new CourseManager({
    repo,
    now: () => now,
    setInterval: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      intervals.push(t);
      return t;
    },
    clearInterval: (t) => {
      if (t) t.cleared = true;
    },
  });
  const finishes = [];
  mgr.finishSession = async (id) => {
    finishes.push(id || (mgr.currentSession && mgr.currentSession.id));
    mgr.currentSession = null;
    mgr._disarmWatchdog();
    return null;
  };
  return {
    mgr,
    repo,
    intervals,
    finishes,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    fireIntervals: () => {
      for (const t of intervals) {
        if (!t.cleared) t.fn();
      }
    },
  };
}

test("自动会话：超过无信号超时后看门狗自动结束会话", () => {
  const w = makeWorld();
  w.mgr.startSession({ title: "测试课程" }); // manual=false（自动会话）
  assert.equal(w.intervals.length, 1, "自动会话应挂看门狗");
  assert.equal(w.intervals[0].ms, WATCHDOG_INTERVAL_MS);
  // 无信号超时内：不结束
  w.advance(SILENCE_TIMEOUT_MS - 1000);
  w.fireIntervals();
  assert.equal(w.finishes.length, 0);
  // 超过超时：自动结束
  w.advance(2000);
  w.fireIntervals();
  assert.equal(w.finishes.length, 1);
});

test("看门狗：课程感知信号会重置沉默计时", () => {
  const w = makeWorld();
  w.mgr.startSession({ title: "测试课程" });
  w.advance(SILENCE_TIMEOUT_MS - 1000);
  // 课程信号到达（空 note/transcript/keyframe 也会喂狗——perception 仍在识别 course 场景）
  w.mgr.handleCoursePerception({ course_note: "讲到了牛顿第二定律" });
  w.advance(SILENCE_TIMEOUT_MS - 1000);
  w.fireIntervals();
  assert.equal(w.finishes.length, 0, "信号活跃不应触发看门狗");
  // 再次沉默超时后结束
  w.advance(2000);
  w.fireIntervals();
  assert.equal(w.finishes.length, 1);
});

test("手动会话不挂看门狗", () => {
  const w = makeWorld();
  w.mgr.startSession({ title: "手动课程", manual: true });
  assert.equal(w.intervals.length, 0);
  w.advance(SILENCE_TIMEOUT_MS * 2);
  w.fireIntervals();
  assert.equal(w.finishes.length, 0);
});

test("收养滞留 recording 会话（zombie）也会挂看门狗", () => {
  const w = makeWorld();
  const zombie = {
    id: "auto-zombie",
    title: "滞留会话",
    status: "recording",
    created_at: new Date().toISOString(),
    keyframes: [],
    summary: "",
  };
  w.repo.states[zombie.id] = zombie;
  w.repo.findRecordingSession = () => zombie;
  w.mgr.handleCoursePerception({ course_note: "继续记笔记" });
  assert.ok(w.mgr.currentSession, "应收养 zombie 会话");
  assert.equal(w.intervals.length, 1, "zombie 会话也应挂看门狗");
  w.advance(SILENCE_TIMEOUT_MS + 1000);
  w.fireIntervals();
  assert.equal(w.finishes.length, 1);
});

test("会话结束后看门狗被拆除", () => {
  const w = makeWorld();
  w.mgr.startSession({ title: "测试课程" });
  w.advance(SILENCE_TIMEOUT_MS + 1000);
  w.fireIntervals(); // 看门狗触发 finishSession（桩内拆狗）
  assert.equal(w.finishes.length, 1);
  assert.ok(w.intervals[0].cleared, "看门狗定时器应被清除");
  // 再触发也不应重复结束
  w.advance(SILENCE_TIMEOUT_MS * 2);
  w.fireIntervals();
  assert.equal(w.finishes.length, 1);
});

// ===========================================================================
// 终稿总结失败链路的回归测试（P0）
//
// 上面那组用例把 finishSession 整体换成了桩，_generateFinalSummary 根本不可达 ——
// 两个 P0 就是这样潜伏的：
//   ① 总结失败只 emit("summary-failed")，全仓零监听者、零日志 → 失败静默；
//   ② 失败后照常置 complete，而 complete 直接 return → 总结永久不可重试；
//   ③ status 直到 await 之后才置 finalizing → 结稿期间会话被"僵尸收养"。
// 因此下面这组用例走**真实的** finishSession / _generateFinalSummary / _exportMarkdown /
// CourseRepo（临时目录），只替换 _askSummarizer（唯一的云端调用层）与时钟/定时器。
// ===========================================================================

// 捕获 console.warn/error：既屏蔽噪音，又能断言"失败必须留日志"
async function captureConsole(fn) {
  const logs = { warn: [], error: [] };
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => logs.warn.push(args.map((a) => String(a)).join(" "));
  console.error = (...args) => logs.error.push(args.map((a) => String(a)).join(" "));
  try {
    await fn(logs);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  return logs;
}

async function withTempWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqcourses-mgr-"));
  try {
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 真实 repo + 真实结稿链路；desktopDir 注入到临时目录，绝不写用户真实桌面
function makeRealWorld(root, { summarize } = {}) {
  let now = 1000000;
  const intervals = [];
  const repo = new CourseRepo(path.join(root, "sessions"));
  const mgr = new CourseManager({
    repo,
    desktopDir: path.join(root, "desktop"),
    now: () => now,
    setInterval: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      intervals.push(t);
      return t;
    },
    clearInterval: (t) => {
      if (t) t.cleared = true;
    },
  });
  const asks = [];
  // 只替换"调云端模型"这一层：分块、拼接、失败处理、state 落盘、导出全部走真实实现
  mgr._askSummarizer = async (instruction) => {
    asks.push(instruction);
    return summarize(instruction, asks.length);
  };
  return {
    mgr,
    repo,
    intervals,
    asks,
    coursesRoot: path.join(root, "desktop", "QQ-Courses"),
    advance: (ms) => {
      now += ms;
    },
    fireIntervals: () => {
      for (const t of intervals) {
        if (!t.cleared) t.fn();
      }
    },
    // 让看门狗里 finishSession().catch(...) 的整条 promise 链跑完
    flush: async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

test("总结失败（HTTP 4xx）会留 warn 日志、state 记下 summary_error、导出稿写明总结生成失败", async () => {
  await withTempWorkspace(async (root) => {
    const w = makeRealWorld(root, {
      summarize: async () => {
        throw new Error("openai HTTP 429: {\"error\":\"rate limited\"}");
      },
    });
    const started = w.mgr.startSession({ title: "牛顿力学", manual: true });
    w.repo.appendTranscript(started.id, "老师讲了牛顿第二定律 F=ma");

    const logs = await captureConsole(() => w.mgr.finishSession());

    assert.equal(w.asks.length, 1, "单块转写只调一次终稿总结——证明真的走进了 _generateFinalSummary");
    assert.equal(
      logs.warn.filter((m) => m.includes("生成课程总结失败") && m.includes("HTTP 429")).length,
      1,
      "可预期失败必须留且只留一条 warn（含原因）"
    );
    assert.equal(logs.error.length, 0, "HTTP 4xx 是可预期业务错误，不该按意外异常记 error");

    const state = w.repo.getState(started.id);
    assert.equal(state.summary, "", "总结失败时 summary 仍为空");
    assert.match(state.summary_error, /HTTP 429/, "失败事实必须落进 state.summary_error");

    const readme = fs.readFileSync(state.output_path, "utf8");
    assert.match(readme, /## 课程总结/, "总结小节不能被静默省略");
    assert.match(readme, /总结生成失败：Error: openai HTTP 429/, "导出稿必须写明总结生成失败");
  });
});

test("总结遇意外异常时按 error 记完整堆栈", async () => {
  await withTempWorkspace(async (root) => {
    const w = makeRealWorld(root, {
      summarize: async () => {
        throw new TypeError("summary is not a function");
      },
    });
    const started = w.mgr.startSession({ title: "意外异常课", manual: true });
    w.repo.appendTranscript(started.id, "一些转写内容");

    const logs = await captureConsole(() => w.mgr.finishSession());

    assert.equal(logs.warn.length, 0, "意外异常不该只记 warn");
    const errors = logs.error.filter((m) => m.includes("生成课程总结时发生意外异常"));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /TypeError: summary is not a function/);
    assert.match(errors[0], /\n\s+at /, "意外异常必须带堆栈（e?.stack），不能只有 message");
    assert.match(w.repo.getState(started.id).summary_error, /^TypeError: /);
  });
});

test("总结缺失的 complete 会话可以重跑总结并补上课程总结小节", async () => {
  await withTempWorkspace(async (root) => {
    let failNext = true;
    const w = makeRealWorld(root, {
      summarize: async () => {
        if (failNext) throw new Error("尚未配置 LLM 提供商，请先在设置中添加");
        return "### 课程概览\n本节讲力学\n\n### 知识点\n- 牛顿第二定律 F=ma";
      },
    });
    const started = w.mgr.startSession({ title: "可重试课程", manual: true });
    w.repo.appendTranscript(started.id, "老师讲了牛顿第二定律 F=ma");

    await captureConsole(() => w.mgr.finishSession());
    const failedState = w.repo.getState(started.id);
    assert.equal(failedState.status, "complete");
    assert.ok(failedState.summary_error, "第一次结稿：总结失败已留痕");
    assert.deepEqual(
      w.mgr.recoverable().map((s) => s.id),
      [started.id],
      "总结缺失的 complete 会话必须被 recoverable() 列为待重试"
    );

    // 修好配置后重跑：显式传 id（此时 currentSession 已为 null）
    failNext = false;
    const retryLogs = await captureConsole(() => w.mgr.finishSession(started.id));
    assert.deepEqual(retryLogs, { warn: [], error: [] }, "重试成功不该再有失败日志");

    const state = w.repo.getState(started.id);
    assert.equal(w.asks.length, 2, "一次失败 + 一次重试，共两次总结调用");
    assert.equal(state.status, "complete");
    assert.equal(state.summary_error, null, "重试成功必须清掉失败标记");
    assert.match(state.summary, /牛顿第二定律 F=ma/);
    assert.deepEqual(w.mgr.recoverable(), [], "补上总结后不再是待重试会话");

    const readme = fs.readFileSync(state.output_path, "utf8");
    assert.match(readme, /## 课程总结\n\n### 课程概览/);
    assert.doesNotMatch(readme, /总结生成失败/, "重导出的稿子里失败提示必须消失");
  });
});

test("结稿期间的课程感知不再收养正在总结的会话（僵尸收养已阻止）", async () => {
  await withTempWorkspace(async (root) => {
    let statusDuringSummary = null;
    let recordingDuringSummary = "未取样";
    let w;
    w = makeRealWorld(root, {
      // 模拟"总结耗时 30~120s 期间用户切回课程"这一刻
      summarize: async () => {
        statusDuringSummary = w.repo.getState(finished.id).status;
        recordingDuringSummary = w.repo.findRecordingSession();
        w.mgr.handleCoursePerception({ course_note: "结稿期间又来了一轮课程转写" });
        return "### 课程概览\n讲完了\n\n### 知识点\n- 结稿前的内容";
      },
    });
    const finished = w.mgr.startSession({ title: "正在结稿的课", manual: true });
    w.repo.appendTranscript(finished.id, "结稿前记录的转写");

    await captureConsole(() => w.mgr.finishSession());

    assert.equal(statusDuringSummary, "finalizing", "进入 await 前 status 必须已是 finalizing");
    assert.equal(recordingDuringSummary, null, "findRecordingSession 不得返回正在结稿的会话");

    const sessions = w.repo.listSessions();
    assert.equal(sessions.length, 2, "结稿期间的课程感知应落到新会话");
    const adopted = sessions.find((s) => s.id !== finished.id);
    assert.equal(adopted.status, "recording");
    assert.match(w.repo.readTranscript(adopted.id), /结稿期间又来了一轮课程转写/);
    assert.equal(
      w.repo.readTranscript(finished.id),
      "结稿前记录的转写\n",
      "正在结稿的 transcript.md 不能再被写入（否则新内容进不了导出稿）"
    );
    const done = w.repo.getState(finished.id);
    assert.equal(done.status, "complete");
    assert.match(fs.readFileSync(done.output_path, "utf8"), /### 知识点/);
  });
});

test("看门狗触发的结稿即使总结失败也不会形成重试风暴", async () => {
  await withTempWorkspace(async (root) => {
    let disarmedDuringSummary = null;
    let currentDuringSummary = "未取样";
    let w;
    w = makeRealWorld(root, {
      summarize: async () => {
        // 总结进行中（已在 await 里）：看门狗必须早已拆除、currentSession 早已清空
        disarmedDuringSummary = w.intervals[0].cleared;
        currentDuringSummary = w.mgr.currentSession;
        throw new Error("openai HTTP 429: rate limited");
      },
    });
    const started = w.mgr.startSession({ title: "自动网课" }); // manual=false → 挂看门狗
    w.repo.appendTranscript(started.id, "自动会话的转写");
    assert.equal(w.intervals.length, 1);

    await captureConsole(async () => {
      w.advance(SILENCE_TIMEOUT_MS + 1000);
      w.fireIntervals(); // 看门狗触发真实 finishSession
      await w.flush();
      // 再推进三个超时窗口：看门狗已拆，不该有第二次结稿
      for (let i = 0; i < 3; i++) {
        w.advance(SILENCE_TIMEOUT_MS + 1000);
        w.fireIntervals();
        await w.flush();
      }
    });

    assert.equal(disarmedDuringSummary, true, "拆狗必须发生在 await 之前");
    assert.equal(currentDuringSummary, null, "currentSession 必须在 await 之前清空");
    assert.equal(w.asks.length, 1, "总结失败不得被看门狗反复重试（只应调用一次）");
    assert.equal(w.repo.getState(started.id).status, "complete", "总结失败仍完成导出");
    assert.equal(w.mgr.currentSession, null);
  });
});
