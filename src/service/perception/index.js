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
  if (global.barrageWindow && typeof global.barrageWindow.destroy === "function") {
    global.barrageWindow.destroy();
  }
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
