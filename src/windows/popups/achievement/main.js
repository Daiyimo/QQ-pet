// achievement 弹窗主进程类：成就徽章墙（单例）。
// 数据全部来自 global.achievement（src/service/achievement.js），本文件只负责窗口与 IPC 桥接。
const _require = eval("require");
const { screen } = _require("electron");

class mainClass {
  constructor() {
    this.window = null;
    this.show = false;
    this.name = "achievement";
  }

  // opt.position 可指定窗口左上角 [x, y]；缺省放在主屏中央
  cleate(opt = {}) {
    this.width = 340;
    this.height = 400;
    let x = 0;
    let y = 0;
    if (Array.isArray(opt.position)) {
      x = Math.trunc(opt.position[0]);
      y = Math.trunc(opt.position[1]);
    } else {
      const area = screen.getPrimaryDisplay().workAreaSize;
      x = Math.trunc((area.width - this.width) / 2);
      y = Math.trunc((area.height - this.height) / 2);
    }
    const _this = this;
    windowsMain
      .open({
        name: this.name,
        loadFile: "popups/" + this.name,
        default: {
          width: this.width,
          height: this.height,
          x,
          y,
          notChangeSize: true,
        },
        created(e) {
          const { vm, preloads } = e;
          preloads({
            // 渲染层 mounted 后拉取成就列表
            achievement_h_load_m: () => {
              _this.sendList(vm);
            },
            achievement_h_close_m: () => {
              _this.doClose();
            },
          });
        },
        onload() {
          console.log("onload ", _this.name);
          _this.show = true;
        },
        onshow(win) {
          console.log("onshow ", _this.name);
          _this.window = win;
          _this.show = true;
        },
        onhide() {
          console.log("onhide ", _this.name);
          _this.show = false;
        },
        onclose() {
          console.log("onclose ", _this.name);
          _this.window = null;
          _this.show = false;
        },
      })
      .then((win) => {
        this.window = win;
        // 窗口工厂会让非白名单窗口跟随桌宠透明度，成就窗强制不透明
        try {
          win && win.setOpacity && win.setOpacity(1);
        } catch (e) {
          console.warn("[achievement] 设置窗口不透明失败:", e?.stack || e);
        }
        this.init();
      })
      .catch((err) => {
        console.log(err);
      });
  }

  init() {
    this.show = true;
  }

  // 下发成就列表：achievement_m_load_h
  sendList(vm) {
    try {
      const list =
        globalThis.achievement && globalThis.achievement.getAll
          ? globalThis.achievement.getAll()
          : [];
      if (vm && !vm.isDestroyed() && vm.webContents) {
        vm.webContents.send("achievement_m_load_h", { ok: true, list });
      }
    } catch (e) {
      console.warn("[achievement] 下发成就列表失败:", e?.stack || e);
    }
  }

  doHide() {
    if (this.window) this.window.hide();
    this.show = false;
  }

  doClose() {
    if (this.window) this.window.close();
    this.show = false;
  }
}

const main = new mainClass();
module.exports = main;
