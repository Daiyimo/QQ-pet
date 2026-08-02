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

const {
  CourseManager,
  needsSummaryRerun,
  STARTUP_RECOVERY_DELAY_MS,
  MAX_RECOVERY_PER_STARTUP,
  MAX_EXPORTED_COURSES,
} = require("../src/service/courses/manager.js");
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
    autoRecover: false, // 本组只测看门狗定时链，关掉启动恢复调度（另有专测）
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
    autoRecover: false, // 恢复流程由专门的用例显式驱动 recoverPending()
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

// ===========================================================================
// 启动恢复（repo.recoverable() 原本零调用者：崩溃留下的 finalizing 会话永久滞留）、
// 多块总结的部分成功保留、桌面导出目录上界对用户可见——三项的回归测试。
// 依旧只替换 _askSummarizer / _hasSummarizer（云端调用层与配置门禁）与时钟、定时器。
// ===========================================================================

// 造一个"崩溃遗留"的会话：写好转写后把 status 直接改成目标状态（模拟进程被杀）。
// summary 是关键参数：非空 = 总结早已成功、只是导出/落盘环节失败（恢复不该再吃 LLM）；
// 空 = 总结根本没产出过（含"总结途中崩溃"这一档），恢复必须重跑总结。
function makeStrandedSession(
  repo,
  { id, status, summaryError = null, summary = "", text = "遗留的转写" }
) {
  repo.createSession({ title: `遗留课程 ${id}`, sessionId: id });
  if (text) repo.appendTranscript(id, text);
  const state = repo.getState(id);
  state.status = status;
  state.summary = summary;
  state.summary_error = summaryError;
  return repo.saveState(id, state);
}

test("启动恢复：构造时只挂 unref 延迟定时器，不在启动路径上做任何同步恢复", async () => {
  await withTempWorkspace(async (root) => {
    const repo = new CourseRepo(path.join(root, "sessions"));
    // finalizing + summary 完好 + 无 summary_error = 总结早已产出、只差导出，恢复不需要 LLM
    //（这也是本用例没有替换 _askSummarizer 的前提：真调云端必然失败）
    makeStrandedSession(repo, {
      id: "auto-strand1",
      status: "finalizing",
      summary: "### 课程概览\n崩溃前已经生成好的总结",
    });
    let recoverableCalls = 0;
    const listRecoverable = repo.recoverable.bind(repo);
    repo.recoverable = () => {
      recoverableCalls += 1;
      return listRecoverable();
    };
    const timers = [];
    const mgr = new CourseManager({
      repo,
      desktopDir: path.join(root, "desktop"),
      setTimeout: (fn, ms) => {
        const t = {
          fn,
          ms,
          unrefed: false,
          unref() {
            this.unrefed = true;
          },
        };
        timers.push(t);
        return t;
      },
    });

    assert.equal(timers.length, 1, "构造时应恰好挂一个恢复定时器");
    assert.equal(timers[0].ms, STARTUP_RECOVERY_DELAY_MS, "恢复必须延迟到启动之后");
    assert.equal(timers[0].unrefed, true, "恢复定时器必须 unref，不能拖住进程退出");
    assert.equal(recoverableCalls, 0, "启动路径上不得同步列举会话（更不能同步恢复）");
    assert.equal(repo.getState("auto-strand1").status, "finalizing", "定时器未到点前不动会话");

    const logs = await captureConsole(async () => {
      timers[0].fn(); // 定时器到点
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    });

    assert.equal(recoverableCalls, 1, "到点后恰好列举一次");
    const recovered = repo.getState("auto-strand1");
    assert.equal(recovered.status, "complete", "崩溃遗留的 finalizing 会话必须被恢复成 complete");
    assert.equal(fs.existsSync(recovered.output_path), true, "恢复应产出导出稿");
    assert.deepEqual(listRecoverable(), [], "恢复成功的会话自动离开 recoverable()");
    assert.ok(
      logs.warn.some((m) => m.includes("启动恢复完成：尝试 1 个、成功 1 个")),
      "恢复了什么必须留日志"
    );

    // 幂等：同进程再调一次既不重新列举、也不重新导出
    const again = await mgr.recoverPending();
    assert.deepEqual(again, { recovered: 0, retried: 0, skipped: 0 });
    assert.equal(recoverableCalls, 1, "幂等闸门必须在列举之前就拦住第二次恢复");
  });
});

test("启动恢复有上界：一次最多恢复 3 个会话，其余留待下次启动并留日志", async () => {
  await withTempWorkspace(async (root) => {
    const w = makeRealWorld(root, {
      summarize: async () => "### 课程概览\n补跑的总结\n\n### 知识点\n- 恢复成功",
    });
    w.mgr._hasSummarizer = () => true; // 只替换配置门禁，分块/落盘/导出全走真实实现
    const ids = ["auto-r1", "auto-r2", "auto-r3", "auto-r4", "auto-r5"];
    for (const id of ids) {
      makeStrandedSession(w.repo, {
        id,
        status: "complete",
        summaryError: "Error: openai HTTP 429",
      });
    }

    let result;
    const logs = await captureConsole(async () => {
      result = await w.mgr.recoverPending();
    });

    assert.equal(MAX_RECOVERY_PER_STARTUP, 3);
    assert.deepEqual(result, { recovered: 3, retried: 3, skipped: 2 });
    assert.equal(w.asks.length, 3, "上界必须真的挡住 LLM 调用：5 个会话只允许 3 次总结");
    assert.deepEqual(
      w.mgr.recoverable().map((s) => s.id),
      ["auto-r4", "auto-r5"],
      "超出上界的会话保持可恢复，留待下次启动"
    );
    assert.equal(
      logs.warn.filter((m) => m.includes("本次剩余 2 个留待下次启动")).length,
      1,
      "跳过了什么必须留且只留一条日志"
    );
    assert.equal(
      logs.warn.filter((m) => m.includes("启动恢复完成：尝试 3 个、成功 3 个")).length,
      1
    );
    for (const id of ["auto-r1", "auto-r2", "auto-r3"]) {
      assert.equal(w.repo.getState(id).summary_error, null, `${id} 的总结应已补上`);
    }
  });
});

test("未配置 LLM 提供商时：需重跑总结的会话跳过且只提示一次，只差导出的照常恢复", async () => {
  await withTempWorkspace(async (root) => {
    const w = makeRealWorld(root, {
      summarize: async () => {
        throw new Error("未配置提供商时不该发起任何 LLM 调用");
      },
    });
    w.mgr._hasSummarizer = () => false; // 等价于 providers.hasChatProvider() 为假
    makeStrandedSession(w.repo, {
      id: "auto-n1",
      status: "complete",
      summaryError: "Error: 缺少 API Key",
    });
    makeStrandedSession(w.repo, {
      id: "auto-n2",
      status: "failed",
      summaryError: "Error: 缺少 API Key",
    });
    makeStrandedSession(w.repo, {
      id: "auto-n3",
      status: "finalizing",
      summary: "### 课程概览\n总结早就写好了",
    }); // 只差导出

    let result;
    const logs = await captureConsole(async () => {
      result = await w.mgr.recoverPending();
    });

    assert.equal(w.asks.length, 0, "未配置提供商时一次 LLM 都不该打");
    assert.deepEqual(result, { recovered: 1, retried: 1, skipped: 2 });
    assert.equal(
      w.repo.getState("auto-n3").status,
      "complete",
      "只差导出的会话不吃 LLM，未配置提供商也必须恢复"
    );
    assert.equal(
      logs.warn.filter((m) => m.includes("尚未配置 LLM 提供商")).length,
      1,
      "降级提示只出现一次，不逐会话刷屏"
    );
    assert.equal(logs.error.length, 0, "未配置提供商是可预期环境问题，不该记 error");
    assert.deepEqual(
      w.mgr.recoverable().map((s) => s.id),
      ["auto-n1", "auto-n2"],
      "被跳过的会话保持可恢复"
    );
  });
});

test("列举可恢复会话失败时启动恢复只记 error 不抛错（不阻断启动）", async () => {
  await withTempWorkspace(async (root) => {
    const w = makeRealWorld(root, { summarize: async () => "不该被调用" });
    w.repo.recoverable = () => {
      throw new Error("EACCES: permission denied, scandir sessions");
    };
    let result;
    const logs = await captureConsole(async () => {
      result = await w.mgr.recoverPending();
    });
    assert.deepEqual(result, { recovered: 0, retried: 0, skipped: 0 });
    assert.equal(w.asks.length, 0);
    const errors = logs.error.filter((m) => m.includes("列举可恢复会话失败"));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /\n\s+at /, "意外异常必须带堆栈");
  });
});

// —— P1：总结途中崩溃遗留的会话（finalizing + 空 summary + summary_error=null）——
// finishSession 先置 finalizing 再跑总结，所以这三项同时成立时是"总结途中被杀"，
// 而不是"只差导出"。按 summary_error 判会直接导出一份没有总结的稿子并置 complete，
// 此后 recoverable() 再也不列出它 —— 总结永久丢失且不可重试。

test("崩溃遗留的 finalizing 会话（summary 为空、summary_error 为 null）恢复时必须重跑总结", async () => {
  await withTempWorkspace(async (root) => {
    const w = makeRealWorld(root, {
      summarize: async () => "### 课程概览\n补跑出来的总结\n\n### 知识点\n- 崩溃前没来得及总结",
    });
    w.mgr._hasSummarizer = () => true;
    const stranded = makeStrandedSession(w.repo, {
      id: "auto-crash1",
      status: "finalizing",
      text: "崩溃前记下的转写内容",
    });
    assert.equal(stranded.summary, "", "前提：总结途中被杀，summary 还是空的");
    assert.equal(stranded.summary_error, null, "前提：崩溃来不及写 summary_error");

    let result;
    await captureConsole(async () => {
      result = await w.mgr.recoverPending();
    });

    assert.equal(w.asks.length, 1, "总结缺失的会话恢复时必须重跑总结（桩 LLM 应被调用）");
    assert.deepEqual(result, { recovered: 1, retried: 1, skipped: 0 });
    const state = w.repo.getState("auto-crash1");
    assert.equal(state.status, "complete");
    assert.equal(state.summary_error, null);
    assert.match(state.summary, /补跑出来的总结/);
    const readme = fs.readFileSync(state.output_path, "utf8");
    assert.match(readme, /## 课程总结\n\n### 课程概览/, "导出稿必须含总结小节");
    assert.match(readme, /崩溃前没来得及总结/);
    assert.deepEqual(w.mgr.recoverable(), [], "补上总结后不再是待重试会话");
  });
});

test("崩溃遗留会话重跑总结仍失败：写 summary_error 且保持可恢复（不焊死恢复入口）", async () => {
  await withTempWorkspace(async (root) => {
    const w = makeRealWorld(root, {
      summarize: async () => {
        throw new Error("openai HTTP 429: rate limited");
      },
    });
    w.mgr._hasSummarizer = () => true;
    makeStrandedSession(w.repo, {
      id: "auto-crash2",
      status: "finalizing",
      text: "崩溃前记下的转写内容",
    });

    let result;
    const logs = await captureConsole(async () => {
      result = await w.mgr.recoverPending();
    });

    assert.equal(w.asks.length, 1, "重跑了一次总结");
    assert.deepEqual(result, { recovered: 0, retried: 1, skipped: 0 });
    const state = w.repo.getState("auto-crash2");
    assert.match(state.summary_error, /HTTP 429/, "重跑仍失败必须留痕");
    assert.equal(state.summary, "", "失败时不得凭空产出总结");
    assert.deepEqual(
      w.mgr.recoverable().map((s) => s.id),
      ["auto-crash2"],
      "重跑失败的会话必须仍被 recoverable() 列出，恢复入口不能被 complete 焊死"
    );
    const readme = fs.readFileSync(state.output_path, "utf8");
    assert.match(readme, /总结生成失败：Error: openai HTTP 429/, "导出稿必须写明总结缺失与原因");
    assert.equal(
      logs.warn.filter((m) => m.includes("生成课程总结失败")).length,
      1,
      "失败必须留且只留一条 warn"
    );
  });
});

test("summary 完好、只是导出失败的会话恢复时不重跑 LLM（防止修过头白花钱）", async () => {
  await withTempWorkspace(async (root) => {
    const w = makeRealWorld(root, {
      summarize: async () => {
        throw new Error("summary 完好的会话不该再打 LLM");
      },
    });
    // 提供商可用也不该调用：判据是"有没有产出过 summary"，不是"能不能调 LLM"
    w.mgr._hasSummarizer = () => true;
    makeStrandedSession(w.repo, {
      id: "auto-export1",
      status: "failed",
      summary: "### 课程概览\n上次已经总结好的内容\n\n### 知识点\n- 只是写盘失败",
      text: "导出失败会话的转写",
    });

    let result;
    await captureConsole(async () => {
      result = await w.mgr.recoverPending();
    });

    assert.equal(w.asks.length, 0, "summary 完好只差导出的会话绝不能重跑总结（白花钱）");
    assert.deepEqual(result, { recovered: 1, retried: 1, skipped: 0 });
    const state = w.repo.getState("auto-export1");
    assert.equal(state.status, "complete");
    assert.equal(state.summary_error, null);
    assert.match(state.summary, /上次已经总结好的内容/, "沿用已有 summary，不得被覆盖");
    assert.match(
      fs.readFileSync(state.output_path, "utf8"),
      /## 课程总结\n\n### 课程概览\n上次已经总结好的内容/,
      "重导出的稿子直接用已有总结"
    );
  });
});

test("needsSummaryRerun：判据是产出过 summary，而不是有没有 summary_error", () => {
  // 崩溃遗留的三件套：finalizing + 空 summary + summary_error=null
  assert.equal(needsSummaryRerun({ status: "finalizing", summary: "", summary_error: null }), true);
  assert.equal(needsSummaryRerun({ status: "recording", summary: "", summary_error: null }), true);
  assert.equal(needsSummaryRerun({ status: "failed", summary: "   ", summary_error: null }), true);
  // 总结失败留痕的会话：重试
  assert.equal(
    needsSummaryRerun({ status: "complete", summary: "有总结", summary_error: "Error: HTTP 429" }),
    true
  );
  // summary 完好、只是导出/落盘失败：不重跑
  assert.equal(needsSummaryRerun({ status: "failed", summary: "有总结", summary_error: null }), false);
  assert.equal(
    needsSummaryRerun({ status: "finalizing", summary: "有总结", summary_error: null }),
    false
  );
});

// —— 多块总结的部分成功保留 ——
const CHUNK_A_LINE = "甲".repeat(2000); // 每行 2000 字符 → splitTranscript(limit=3200) 切成两块
const CHUNK_B_LINE = "乙".repeat(2000);

test("多块总结：第 2 块失败后重试跳过已成功的第 1 块，成功后块缓存被清理", async () => {
  await withTempWorkspace(async (root) => {
    let failChunkB = true;
    const w = makeRealWorld(root, {
      summarize: async (instruction) => {
        if (instruction.includes("甲甲甲")) return "第一块的提取结果";
        if (instruction.includes("乙乙乙")) {
          if (failChunkB) throw new Error("openai HTTP 429: rate limited");
          return "第二块的提取结果";
        }
        return "### 课程概览\n拼接终稿\n\n### 知识点\n- 两块都在";
      },
    });
    const started = w.mgr.startSession({ title: "两块课程", manual: true });
    w.repo.appendTranscript(started.id, CHUNK_A_LINE);
    w.repo.appendTranscript(started.id, CHUNK_B_LINE);
    const cachePath = path.join(root, "sessions", started.id, "summary-chunks.json");

    await captureConsole(() => w.mgr.finishSession());

    assert.equal(w.asks.length, 2, "第一次：第 1 块成功 + 第 2 块失败即中止，共两次调用");
    assert.match(w.repo.getState(started.id).summary_error, /HTTP 429/);
    assert.equal(fs.existsSync(cachePath), true, "已成功的块必须落盘暂存，不能随失败一起丢掉");
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.deepEqual(Object.keys(cached.parts), ["0"], "只缓存已成功的第 1 块");
    assert.equal(cached.parts["0"].text, "第一块的提取结果");

    failChunkB = false;
    const retryLogs = await captureConsole(() => w.mgr.finishSession(started.id));

    assert.equal(w.asks.length, 4, "重试只补跑第 2 块与终稿（2 + 2），不重跑第 1 块");
    assert.equal(
      w.asks.filter((a) => a.includes("甲甲甲")).length,
      1,
      "第 1 块的 LLM 调用全程只发生一次（部分成功真的被保留）"
    );
    assert.equal(
      retryLogs.warn.filter((m) => m.includes("复用了 1/2 块")).length,
      1,
      "复用了几块必须留日志"
    );
    const state = w.repo.getState(started.id);
    assert.equal(state.summary_error, null);
    assert.match(state.summary, /拼接终稿/);
    assert.equal(fs.existsSync(cachePath), false, "总结成功后块缓存必须被清理，不留第 4 个增长点");
    assert.match(fs.readFileSync(state.output_path, "utf8"), /### 知识点/);
  });
});

// —— 桌面导出目录上界对用户可见 ——
test("桌面导出目录超限：气泡对用户提示一次，且绝不删除桌面文件", async () => {
  await withTempWorkspace(async (root) => {
    const w = makeRealWorld(root, {
      summarize: async () => "### 课程概览\n短课\n\n### 知识点\n- 一个点",
    });
    fs.mkdirSync(w.coursesRoot, { recursive: true });
    for (let i = 0; i < MAX_EXPORTED_COURSES; i++) {
      fs.mkdirSync(path.join(w.coursesRoot, `old-${i}`));
    }
    const bubbles = [];
    const prevSpeak = global.openSpeak;
    global.openSpeak = (opt) => bubbles.push(opt && opt.data && opt.data.data);
    try {
      const first = w.mgr.startSession({ title: "第一节", manual: true });
      w.repo.appendTranscript(first.id, "第一节的转写");
      const logs = await captureConsole(() => w.mgr.finishSession());

      assert.equal(bubbles.length, 1, "超过上限必须对用户可见一次，而不是只写日志");
      assert.match(bubbles[0], /QQ-Courses/);
      assert.match(bubbles[0], /清理/);
      assert.equal(logs.warn.filter((m) => m.includes("超过提示上限")).length, 1);

      const second = w.mgr.startSession({ title: "第二节", manual: true });
      w.repo.appendTranscript(second.id, "第二节的转写");
      await captureConsole(() => w.mgr.finishSession());
      assert.equal(bubbles.length, 1, "同一进程内不得每次导出都弹");

      assert.equal(
        fs.readdirSync(w.coursesRoot).length,
        MAX_EXPORTED_COURSES + 2,
        "桌面导出目录一个都不许自动删除"
      );
    } finally {
      if (prevSpeak === undefined) delete global.openSpeak;
      else global.openSpeak = prevSpeak;
    }
  });
});
