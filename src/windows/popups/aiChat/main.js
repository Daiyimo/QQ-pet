// aiChat 弹窗主进程类：多轮 AI 对话窗（单例）。
// 对话逻辑全部走 global.petChat（src/service/llm/chat.js），本文件只负责窗口与 IPC 桥接。
const _require = eval("require");
const { desktopCapturer, screen } = _require("electron");

// 气泡播报的回复截断长度（气泡不适合放长文，完整回复在聊天窗里看）
const SPEAK_REPLY_LIMIT = 120;

class mainClass {
  constructor() {
    this.window = null;
    this.show = false;
    this.name = "aiChat";
    this.sending = false; // 渲染层已有限流，这里再兜一层
  }

  // opt.position 可指定窗口左上角 [x, y]；缺省放在主屏右下角
  cleate(opt = {}) {
    this.width = 360;
    this.height = 480;
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
            aiChat_h_send_m: (event, msg) => {
              _this.onSend(vm, msg);
            },
            aiChat_h_clear_m: (event) => {
              try {
                global.petChat && global.petChat.clearHistory();
              } catch (e) {}
              _this.sendReply(vm, { ok: true, type: "cleared" });
            },
            aiChat_h_close_m: () => {
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
          _this.sending = false;
        },
      })
      .then((win) => {
        this.window = win;
        // 窗口工厂会让非白名单窗口跟随桌宠透明度（可低至 0.1），聊天窗强制不透明
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

  sendReply(vm, data) {
    try {
      if (vm && !vm.isDestroyed() && vm.webContents) {
        vm.webContents.send("aiChat_m_reply_h", data);
      }
    } catch (e) {}
  }

  // 截主屏，返回 PNG Buffer；失败返回 null
  async captureScreen() {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1280, height: 720 },
      });
      if (!sources || !sources.length) return null;
      const png = sources[0].thumbnail.toPNG();
      return png && png.length ? png : null;
    } catch (e) {
      console.log("aiChat captureScreen error", e);
      return null;
    }
  }

  async onSend(vm, msg) {
    const text = String((msg && msg.text) || "").trim();
    const withScreen = !!(msg && msg.withScreen);
    if (!text) {
      this.sendReply(vm, { ok: false, error: "消息不能为空" });
      return;
    }
    if (this.sending) {
      this.sendReply(vm, { ok: false, error: "企鹅正在思考中，请稍等片刻再发~" });
      return;
    }
    if (!global.petChat) {
      this.sendReply(vm, { ok: false, error: "对话服务未就绪" });
      return;
    }
    this.sending = true;
    try {
      let screenshot = null;
      if (withScreen) {
        screenshot = await this.captureScreen();
        if (!screenshot) {
          this.sendReply(vm, { ok: false, error: "截屏失败，请取消“附带屏幕”后再试" });
          return;
        }
      }
      const reply = await global.petChat.sendMessage(text, {
        withScreen,
        screenshot,
      });
      this.sendReply(vm, { ok: true, reply });
      // 同时让桌宠气泡播报回复（截断到合适长度）
      try {
        if (typeof global.openSpeak === "function") {
          global.openSpeak({
            data: {
              type: "text",
              data: reply.slice(0, SPEAK_REPLY_LIMIT),
              submitText: "好的",
            },
            active: "speak",
            nextActiveStr: "speak",
          });
        }
      } catch (e) {}
    } catch (err) {
      this.sendReply(vm, {
        ok: false,
        error: String((err && err.message) || err || "未知错误"),
      });
    } finally {
      this.sending = false;
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
