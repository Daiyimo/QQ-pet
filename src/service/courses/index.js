// 课程记录模块入口：汇总导出 + global.courseManager 单例（供主会话接线）。
const _require = eval("require");
const { CourseRepo } = _require("./repo.js");
const transcript = _require("./transcript.js");
const { CourseManager } = _require("./manager.js");

const courseManager = new CourseManager();
global.courseManager = courseManager;

module.exports = { CourseRepo, CourseManager, courseManager, transcript };
