"use strict";

// 移植自 jarvis desktop/src/ui/barrage.js：5 泳道、每道 1500ms 冷却。
// 主进程通过 executeJavaScript 调 window.qqBarrage.show(text)。
(function () {
  const layer = document.querySelector("#barrage-layer");
  const lanes = [0, 0, 0, 0, 0];

  function show(text) {
    if (!text) return;
    const now = Date.now();
    let lane = lanes.findIndex((available) => available <= now);
    if (lane < 0) lane = lanes.indexOf(Math.min(...lanes));
    lanes[lane] = now + 1500;
    const item = document.createElement("div");
    item.className = "barrage-line";
    item.style.top = `${8 + lane * 9}%`;
    item.textContent = text;
    layer.appendChild(item);
    item.addEventListener("animationend", () => item.remove(), { once: true });
  }

  window.qqBarrage = { show };
})();
