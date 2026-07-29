// 临时调试注入 v2：真实 app 内验证拖动与 clamp（精简，避免窗口重叠）
const fs = require("fs");
const path = require("path");
const LOG = path.join(__dirname, "app_pos.log");
const log = (m) => fs.appendFileSync(LOG, m + "\n");

module.exports = function startInject() {
  fs.writeFileSync(LOG, "inject start " + new Date().toISOString() + "\n");
  setTimeout(() => {
    try {
      const si = require("../src/windows/popups/stateInfo/main.js");
      si.cleate({ nowPosition: [700, 700], msg: null });
      log("stateInfo cleated -> expect (605,410)");
    } catch (e) { log("stateInfo err " + e.message); }
    try {
      windowsMain.open({ name: "clampTest", loadFile: "popups/stateInfo", default: { width: 190, height: 290, x: 2500, y: 1380, notChangeSize: true } });
      log("clampTest opened@2500,1380");
    } catch (e) { log("clampTest err " + e.message); }
    // 诊断：stateInfo 窗口内各点的命中元素与 app-region
    setTimeout(() => {
      try {
        const w = windowsMain.wins.stateInfo && windowsMain.wins.stateInfo.win;
        if (!w) return log("diag: no stateInfo win");
        w.webContents.executeJavaScript(`
          (() => {
            const probe = (x, y) => {
              const el = document.elementFromPoint(x, y);
              if (!el) return x + ',' + y + ':null';
              const cs = getComputedStyle(el);
              return x + ',' + y + ':' + el.className + ' ar=' + cs.getPropertyValue('-webkit-app-region');
            };
            const cm = document.querySelector('.content_main');
            const hd = document.querySelector('.head');
            const r = (el) => { if (!el) return 'MISSING'; const b = el.getBoundingClientRect();
              return [b.x|0,b.y|0,b.width|0,b.height|0].join(',') + ' ar=' + getComputedStyle(el).getPropertyValue('-webkit-app-region'); };
            return 'content_main=' + r(cm) + ' | head=' + r(hd)
              + ' || ' + [probe(60,15), probe(60,40), probe(60,60), probe(60,90), probe(60,120), probe(60,200), probe(60,270)].join(' ; ');
          })()
        `).then((r) => log("diag stateInfo: " + r)).catch((e) => log("diag err " + e.message));
      } catch (e) { log("diag err " + e.message); }
    }, 3000);
    setTimeout(() => {
      try {
        const control = require("../src/windows/popups/control/main.js");
        control.setPosition({ position: [2450, 1300], maxSize: [144, 144] });
        control.useInState({ type: "active", opt: { value: "food" } });
        log("control setPosition@edge + food panel");
      } catch (e) { log("control err " + e.message); }
    }, 4000);
    setInterval(() => {
      try {
        const wm = global.windowsMain;
        if (!wm || !wm.wins) return;
        for (const name in wm.wins) {
          const w = wm.wins[name] && wm.wins[name].win;
          if (w && !w.isDestroyed()) {
            log(name + " pos=" + JSON.stringify(w.getPosition()) + " size=" + JSON.stringify(w.getSize()) + " visible=" + w.isVisible() + " opacity=" + w.getOpacity());
          }
        }
      } catch (e) {}
    }, 500);
  }, 10000);
};
