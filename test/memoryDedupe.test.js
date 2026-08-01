// 记忆生成的 in-flight 去重回归测试：
//   右键菜单/设置页可以在 300ms 防抖窗口之外被连点两次（人手可及），此前两次调用会并发跑
//   两次 compactTimeline + 两次 120s 的 LLM 请求（重复计费），且两次 writeDaily 后写覆盖先写。
//   现在同一天复用同一个 in-flight Promise，成功与失败后都清理（否则失败一次当天永远无法重试）。
// 全部走临时目录 + 桩替 providers.chat，不联网、不依赖 Electron。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DailyMemoryService, dedupeByKey } = require("../src/service/memory/daily.js");
const { MemoryStore, localDayString } = require("../src/service/memory/store.js");
const providers = require("../src/service/llm/providers.js");

const DAY = localDayString(new Date(2025, 5, 10));

async function withTempStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqmem-dedupe-"));
  try {
    const store = new MemoryStore(root);
    // 两条事件（09:00 / 10:00 本地）→ generateDaily 走 LLM 分支
    store.appendEvent({
      kind: "activity",
      text: "在 VS Code 里写 javascript 代码调试项目",
      timestamp: new Date(2025, 5, 10, 9, 0).toISOString(),
      metadata: { scene: "other" },
    });
    store.appendEvent({
      kind: "activity",
      text: "继续调试项目代码并整理提示词",
      timestamp: new Date(2025, 5, 10, 10, 0).toISOString(),
      metadata: { scene: "other" },
    });
    return await fn(store);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 桩替 providers.chat / getChatProvider（daily.js 每次调用时才 require，替换即生效），
// 返回能通过覆盖校验的总结文本（含 09:00 / 10:00 时间点 + 句末标点）。
// 注意 await fn(state)：fn 是异步的，必须等它跑完再还原，否则第二次调用会打到真实实现。
async function withChatStub(impl, fn) {
  const savedChat = providers.chat;
  const savedProvider = providers.getChatProvider;
  const state = { calls: 0 };
  providers.getChatProvider = () => ({ id: "stub", baseUrl: "https://stub.invalid", apiKey: "k", model: "m" });
  providers.chat = async (...args) => {
    state.calls += 1;
    return impl(state.calls, ...args);
  };
  try {
    return await fn(state);
  } finally {
    providers.chat = savedChat;
    providers.getChatProvider = savedProvider;
  }
}

const OK_SUMMARY = "09:00 开始写代码，10:00 继续调试项目。";

test("generateDaily：同一天并发两次只发一次 LLM 请求，两个调用方拿到同一个结果", async () => {
  await withTempStore(async (store) => {
    await withChatStub(
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        return OK_SUMMARY;
      },
      async (state) => {
        const service = new DailyMemoryService({ store });
        const [a, b] = await Promise.all([service.generateDaily(DAY), service.generateDaily(DAY)]);
        assert.equal(state.calls, 1, "并发两次只应发出 1 次 LLM 请求");
        assert.strictEqual(a, b, "两个调用方应拿到同一个结果对象（复用同一 Promise）");
        assert.equal(a.date, DAY);
        assert.equal(a.event_count, 2);
        assert.match(store.readDaily(DAY), /10:00 继续调试项目。/);
      }
    );
  });
});

test("generateDaily：完成后清理 in-flight，串行两次各发一次请求", async () => {
  await withTempStore(async (store) => {
    await withChatStub(
      async () => OK_SUMMARY,
      async (state) => {
        const service = new DailyMemoryService({ store });
        await service.generateDaily(DAY);
        await service.generateDaily(DAY);
        assert.equal(state.calls, 2, "上一次已结束，第二次必须真正重新生成");
      }
    );
  });
});

test("generateDaily：失败后 in-flight 被清理，同一天可以重试成功", async () => {
  await withTempStore(async (store) => {
    await withChatStub(
      async (call) => {
        if (call === 1) throw new Error("模拟云端失败");
        return OK_SUMMARY;
      },
      async (state) => {
        const service = new DailyMemoryService({ store });
        const first = service.generateDaily(DAY);
        const second = service.generateDaily(DAY);
        await assert.rejects(first, /模拟云端失败/);
        await assert.rejects(second, /模拟云端失败/, "并发的第二个调用方拿到同一个失败");
        assert.equal(state.calls, 1, "失败路径同样只发一次请求");

        const retry = await service.generateDaily(DAY);
        assert.equal(state.calls, 2, "失败后必须允许重试（in-flight 已清理）");
        assert.equal(retry.date, DAY);
      }
    );
  });
});

test("generateDaily：不同天各自独立，不会被互相去重", async () => {
  await withTempStore(async (store) => {
    await withChatStub(
      async () => OK_SUMMARY,
      async (state) => {
        const service = new DailyMemoryService({ store });
        const other = localDayString(new Date(2025, 5, 11));
        const [a, b] = await Promise.all([
          service.generateDaily(DAY),
          service.generateDaily(other),
        ]);
        assert.equal(state.calls, 1, "另一天没有事件，走不到 LLM 分支");
        assert.equal(a.event_count, 2);
        assert.equal(b.event_count, 0);
        assert.notStrictEqual(a, b, "不同天不能复用同一个 Promise");
      }
    );
  });
});

// —— memoryService.generateDailyImage 的接线（index.js）——
// 需要在临时 cwd 下 require：非 Electron 环境 MemoryStore 会落到 cwd/memory
test("generateDailyImage：同一天并发两次只真正生成一次，完成后可再次生成", async () => {
  const cwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqmem-index-"));
  const imageGen = require("../src/service/memory/imageGen.js");
  const savedGen = imageGen.generateDailyImage;
  let memoryService;
  try {
    process.chdir(root);
    memoryService = require("../src/service/memory/index.js").memoryService;
    let calls = 0;
    imageGen.generateDailyImage = async ({ day }) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, metadata: { date: day, call: calls } };
    };
    const [a, b] = await Promise.all([
      memoryService.generateDailyImage(DAY),
      memoryService.generateDailyImage(DAY),
    ]);
    assert.equal(calls, 1, "并发两次只应真正生成一次（图像生成慢且计费）");
    assert.strictEqual(a, b, "两个调用方应拿到同一个结果对象");
    assert.deepEqual(a, { ok: true, metadata: { date: DAY, call: 1 } });

    const again = await memoryService.generateDailyImage(DAY);
    assert.equal(calls, 2, "完成后 in-flight 必须清理，允许再次生成");
    assert.notStrictEqual(again, a);

    // 失败也要清理
    imageGen.generateDailyImage = async () => {
      calls += 1;
      throw new Error("模拟图像生成失败");
    };
    await assert.rejects(memoryService.generateDailyImage(DAY), /模拟图像生成失败/);
    await assert.rejects(memoryService.generateDailyImage(DAY), /模拟图像生成失败/);
    assert.equal(calls, 4, "失败后同一天仍可重试，两次各真正调用一次");
  } finally {
    imageGen.generateDailyImage = savedGen;
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// —— 去重原语本身 ——
test("dedupeByKey：同 key 复用、异 key 独立、工厂同步抛错不占用槽位", async () => {
  const map = new Map();
  let calls = 0;
  const slow = () =>
    dedupeByKey(map, "k", async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    });
  const [a, b] = await Promise.all([slow(), slow()]);
  assert.equal(calls, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(map.size, 0, "结算后必须从 in-flight 表移除");

  await assert.rejects(
    dedupeByKey(map, "k2", () => {
      throw new Error("同步校验失败");
    }),
    /同步校验失败/
  );
  assert.equal(map.size, 0, "同步抛错不应留下 in-flight 条目");
});
