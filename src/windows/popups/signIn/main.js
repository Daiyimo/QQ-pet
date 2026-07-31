// signIn 弹窗主进程类：每日签到窗（单例）。
// 签到逻辑全部在 src/service/signIn.js，本文件只负责窗口与 IPC 桥接。
const _require = eval("require");
const { screen } = _require("electron");
const signInService = _require("../../../service/signIn.js");

class mainClass {
  constructor() {
    this.window = null;
    this.show = false;
    this.name = "signIn";
  }

  // opt.position 可指定窗口左上角 [x, y]；缺省放在主屏中央
  cleate(opt = {}) {
    this.width = 320;
    this.height = 360;
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
            // 渲染层事件总线：mounted 时下发状态，close 时关窗（参照 tip）
            signIn_h_bus_m: (event, msg) => {
              if (msg && msg.event === "mounted") {
                _this.sendStatus(vm);
              } else if (msg && msg.event === "close") {
                _this.doClose();
              }
            },
            // 点击"立即签到"
            signIn_h_do_m: (event) => {
              const res = signInService.doSignIn();
              _this.sendResult(vm, res);
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
        // 窗口工厂会让非白名单窗口跟随桌宠透明度（可低至 0.1），签到窗强制不透明
        try {
          win && win.setOpacity && win.setOpacity(1);
        } catch (e) {
          console.warn("[signIn] 设置窗口不透明失败:", e?.stack || e);
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

  // 下发最新签到状态
  sendStatus(vm) {
    try {
      if (vm && !vm.isDestroyed() && vm.webContents) {
        vm.webContents.send("signIn_m_load_h", signInService.getStatus());
      }
    } catch (e) {
      console.warn("[signIn] 下发签到状态失败:", e?.stack || e);
    }
  }

  // 回发签到结果 + 最新状态（成功时的气泡庆祝已在逻辑层触发）
  sendResult(vm, res) {
    try {
      if (vm && !vm.isDestroyed() && vm.webContents) {
        vm.webContents.send("signIn_m_result_h", {
          ...res,
          status: signInService.getStatus(),
        });
      }
    } catch (e) {
      console.warn("[signIn] 回发签到结果失败:", e?.stack || e);
    }
  }

  doClose() {
    if (this.window) this.window.close();
    this.show = false;
  }
}

const main = new mainClass();
module.exports = main;
