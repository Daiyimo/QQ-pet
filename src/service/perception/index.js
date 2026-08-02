// 感知模块汇总导出 + 便捷启停。
// startPerception()：初始化弹幕覆盖层窗口并启动感知主循环；
// stopPerception()：停止循环并销毁弹幕窗口。
const _require = eval("require");

const capture = _require("./capture");
const sceneStabilizer = _require("./sceneStabilizer");
const barrageRanker = _require("./barrageRanker");
const { PerceptionLoop, perceptionLoop } = _require("./loop");

function startPerception() {
  // 惰性初始化弹幕窗口（Electron 依赖，主会话需先 require 本模块于 app ready 后）
  _require("../../windows/barrage/main.js").ensure();
  perceptionLoop.start();
  return perceptionLoop;
}

function stopPerception() {
  perceptionLoop.stop();
  // 销毁走 loop 上的同一份实现：自动停用（loop 内部触发，不经过本文件）也要销毁弹幕窗，
  // 两处必须同口径，否则会重演"停用后窗口残留"的泄漏。
  perceptionLoop.destroyBarrageWindow();
}

module.exports = {
  PerceptionLoop,
  perceptionLoop,
  capture,
  sceneStabilizer,
  barrageRanker,
  startPerception,
  stopPerception,
};
