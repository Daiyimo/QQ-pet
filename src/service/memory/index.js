// 记忆系统汇总入口 + global.memoryService 单例。
// 接线（主会话完成）：
//   require("./service/memory/index.js");            // 主进程启动时装载，注册 global.memoryService
//   感知模块每次产出结果后发 'activity' 事件：
//   global.memoryService.handlePerceptionActivity(result);
//   其中 result = {scene, confidence, observation, course_title, timestamp?}
const _require = eval("require");
const { MemoryStore, localDayString } = _require("./store.js");
const { MemoryActivityRecorder } = _require("./activity.js");
const { DailyMemoryService } = _require("./daily.js");
const imageGen = _require("./imageGen.js");

const store = new MemoryStore();
const recorder = new MemoryActivityRecorder({ store });
const dailyService = new DailyMemoryService({ store });

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

  // 生成并落盘某一天（"YYYY-MM-DD"，缺省今天）的记忆 Markdown
  generateDaily(day) {
    return dailyService.generateDaily(day || localDayString(new Date()));
  },

  // 生成日程信息图（参考图/图像提供商均来自 sys 配置，未配置时返回 {ok:false, reason}）
  generateDailyImage(day) {
    return imageGen.generateDailyImage({
      store,
      dailyService,
      day: day || localDayString(new Date()),
    });
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
