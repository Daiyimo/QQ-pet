// travel 渲染层：Vue 全局构建（vue.global.js 已由窗口工厂注入），只走 contextBridge API。
// 倒计时为渲染层本地倒计时：旅游中每秒刷新，归零后重新向主进程拉取状态。
(() => {
  const REFUSE_TEXT = {
    die: "先把我救活，才能去旅游呀",
    ill: "我生病了，等我病好了再去旅游吧~",
    work: "我正在打工呢，结束后再去吧~",
    study: "我正在学习呢，结束后再去吧~",
    trip: "我已经在旅途中啦~",
  };

  const app = {
    data() {
      return {
        status: { traveling: false, collected: [], total: 34 },
        provinces: [],
        tipText: "",
        remainMs: 0, // 本地倒计时剩余毫秒
        endAt: 0, // 预计回家时间戳
        timer: null,
      };
    },
    computed: {
      remainText() {
        const totalSec = Math.max(0, Math.ceil(this.remainMs / 1000));
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return m + "分" + (s < 10 ? "0" : "") + s + "秒";
      },
    },
    mounted() {
      window.electronAPI.travel_m_load((event, data) => {
        if (!data) return;
        if (Array.isArray(data.provinces)) this.provinces = data.provinces;
        this.applyStatus(data.status);
        seeApp();
      });
      window.electronAPI.travel_m_status((event, data) => {
        if (!data) return;
        this.applyStatus(data.status);
        const r = data.result;
        if (r && !r.ok && r.reason) {
          this.tipText = REFUSE_TEXT[r.reason] || "现在还不能去旅游哦~";
        } else if (r && r.ok && r.province) {
          this.tipText = "";
        }
      });
      // 打开时请求下发 getStatus()
      window.electronAPI.travel_h_load({});
    },
    beforeUnmount() {
      this.stopTimer();
    },
    methods: {
      isCollected(id) {
        return this.status.collected.indexOf(id) >= 0;
      },
      applyStatus(status) {
        if (!status) return;
        this.status = status;
        if (status.traveling && typeof status.remainingMs === "number") {
          this.endAt = Date.now() + status.remainingMs;
          this.remainMs = status.remainingMs;
          this.startTimer();
        } else {
          this.stopTimer();
          this.remainMs = 0;
        }
      },
      startTimer() {
        this.stopTimer();
        this.timer = setInterval(() => {
          this.remainMs = Math.max(0, this.endAt - Date.now());
          if (this.remainMs <= 0) {
            // 倒计时归零：主进程到点会 finishTravel，重新拉取状态刷新界面
            this.stopTimer();
            window.electronAPI.travel_h_load({});
          }
        }, 1000);
      },
      stopTimer() {
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
      },
      startTravel() {
        this.tipText = "";
        window.electronAPI.travel_h_start({});
      },
      cancelTravel() {
        window.electronAPI.travel_h_cancel({});
      },
      closeWindow() {
        this.stopTimer();
        window.electronAPI.travel_h_close({});
      },
    },
  };
  Vue.createApp(app).mount("#app");
})();
