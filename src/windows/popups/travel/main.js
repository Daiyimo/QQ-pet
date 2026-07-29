// travel 弹窗主进程类：环游中国收集墙（单例）。
// 玩法逻辑全部走 src/service/travel.js 单例，本文件只负责窗口与 IPC 桥接。
// IPC 通道命名：<窗口名>_h_xxx_m（渲染->主）/ <窗口名>_m_xxx_h（主->渲染）。
const _require = eval("require");
const { screen } = _require("electron");
const travel = _require("../../../service/travel.js");

class mainClass {
  constructor() {
    this.window = null;
    this.show = false;
    this.name = "travel";
  }

  // opt.position 可指定窗口左上角 [x, y]；缺省放在主屏右下角
  cleate(opt = {}) {
    this.width = 360;
    this.height = 420;
    let x = 0;
    let y = 0;
    if (Array.isArray(opt.position)) {
      x = Math.trunc(opt.position[0]);
      y = Math.trunc(opt.position[1]);
    } else {
      const area = screen.getPrimaryDisplay().workAreaSize;
      x = area.width - this.width - 40;
      y = area.height - this.height - 60;
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
            // 打开时下发状态：travel_m_load_h 带 getStatus() + 省份表
            travel_h_load_m: () => {
              _this.sendLoad(vm);
            },
            travel_h_start_m: () => {
              const result = travel.startTravel();
              _this.sendStatus(vm, result);
            },
            travel_h_cancel_m: () => {
              const result = travel.cancelTravel();
              _this.sendStatus(vm, result);
            },
            travel_h_close_m: () => {
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
        // 窗口工厂会让非白名单窗口跟随桌宠透明度（可低至 0.1），收集墙强制不透明
        try {
          win && win.setOpacity && win.setOpacity(1);
        } catch (e) {}
        this.init();
      })
      .catch((err) => {
        console.log(err);
      });
  }

  init() {
    this.show = true;
  }

  _send(vm, channel, data) {
    try {
      if (vm && !vm.isDestroyed() && vm.webContents) {
        vm.webContents.send(channel, data);
      }
    } catch (e) {}
  }

  sendLoad(vm) {
    this._send(vm, "travel_m_load_h", {
      status: travel.getStatus(),
      provinces: travel.PROVINCES,
    });
  }

  sendStatus(vm, result) {
    this._send(vm, "travel_m_status_h", {
      status: travel.getStatus(),
      result: result || null,
    });
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
