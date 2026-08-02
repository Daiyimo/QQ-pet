// 记忆系统汇总入口 + global.memoryService 单例。
// 接线（主会话完成）：
//   require("./service/memory/index.js");            // 主进程启动时装载，注册 global.memoryService
//   感知结果并不直接进来，中间隔着 aiWiring.js：
//     perception/loop.js 的 _dispatch 在 **confidence≥0.6 且 observation 非空** 时
//     才 emit 'activity'（低置信/空观察的帧压根不发），事件载荷里的观察字段名是 `text`；
//     aiWiring.js 监听该事件，把 text 改名成 observation 后调
//     global.memoryService.handlePerceptionActivity({scene, confidence, observation,
//     course_title, timestamp})。
//   recordActivity/handlePerceptionActivity 两个字段名都收（observation 优先，
//   缺省回落 text），所以直接拿 loop 的原始载荷调用也能工作。
//   注意：loop 的门槛之外，activity.js 内部还有一层节流/去重门槛。
const _require = eval("require");
const { MemoryStore, localDayString } = _require("./store.js");
const { MemoryActivityRecorder } = _require("./activity.js");
const { DailyMemoryService, dedupeByKey } = _require("./daily.js");
const imageGen = _require("./imageGen.js");

const store = new MemoryStore();
const recorder = new MemoryActivityRecorder({ store });
const dailyService = new DailyMemoryService({ store });
// key = "YYYY-MM-DD" → 该天正在进行的配图生成 Promise（去重语义见 daily.js 的 dedupeByKey）
const imageInflight = new Map();

const memoryService = {
  store,
  recorder,
  dailyService,
  ImageGenerationClient: imageGen.ImageGenerationClient,

  // 感知活动落记忆（confidence/清洗/节流/去重门槛见 activity.js）。
  // 返回事件对象；被拦截返回 null。
  recordActivity(payload) {
    const p = payload || {};
    return recorder.record({
      scene: p.scene,
      confidence: p.confidence,
      text: p.observation != null ? p.observation : p.text,
      courseTitle: p.course_title != null ? p.course_title : p.courseTitle,
      timestamp: p.timestamp,
    });
  },

  // 感知模块 'activity' 事件对接入口（签名与 recordActivity 相同）
  handlePerceptionActivity(payload) {
    return this.recordActivity(payload);
  },

  // 生成并落盘某一天（"YYYY-MM-DD"，缺省今天）的记忆 Markdown。
  // 同一天的并发调用在 DailyMemoryService.generateDaily 内已按天去重（in-flight Promise），
  // 菜单/设置页连点两次只会发一次 LLM 请求，两个调用方拿到同一个结果。
  generateDaily(day) {
    return dailyService.generateDaily(day || localDayString(new Date()));
  },

  // 生成日程信息图（参考图/图像提供商均来自 sys 配置，未配置时返回 {ok:false, reason}）。
  // opts.signal（AbortSignal）：可选，功能关闭/会话结束时掐断在途生成请求。
  // 已知边界：目前唯一生产调用方（设置页 genDailyImage 菜单，setup/main.js）是手动触发、
  // 未传 signal；在途生成靠 imageGen 内部的 300s 超时兜底，收益不足以在压缩代码里接线。
  // 同一天并发调用复用同一个 in-flight Promise（图像生成既慢又计费，重复跑纯浪费）；
  // 复用时沿用首个调用方的 signal——后到的调用方 abort 不会掐断已在途的那次。
  generateDailyImage(day, opts = {}) {
    const target = day || localDayString(new Date());
    return dedupeByKey(imageInflight, target, () =>
      imageGen.generateDailyImage({
        store,
        dailyService,
        day: target,
        signal: opts.signal,
      })
    );
  },
};

global.memoryService = memoryService;

module.exports = {
  memoryService,
  MemoryStore,
  MemoryActivityRecorder,
  DailyMemoryService,
  ImageGenerationClient: imageGen.ImageGenerationClient,
  compactTimeline: _require("./daily.js").compactTimeline,
  summaryCovers: _require("./daily.js").summaryCovers,
  textsAreSimilar: _require("./activity.js").textsAreSimilar,
};
