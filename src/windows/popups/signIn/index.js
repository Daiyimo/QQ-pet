// signIn 渲染层：Vue 全局构建（vue.global.js 已由窗口工厂注入），只走 contextBridge API。
(() => {
  const app = {
    data() {
      return {
        signedToday: false,
        streak: 0,
        total: 0,
        week: [], // [{ date, label, dayNum, signed, isToday, isFuture, state }]
      };
    },
    mounted() {
      // 主进程下发的状态
      window.electronAPI.signIn_m_load((event, data) => {
        if (data) this.applyStatus(data);
      });
      // 签到结果：无论成功与否都用最新状态刷新 UI（气泡庆祝由主进程逻辑层触发）
      window.electronAPI.signIn_m_result((event, data) => {
        if (data && data.status) this.applyStatus(data.status);
      });
      // 通知主进程渲染层已就绪，请求下发状态
      window.electronAPI.signIn_h_bus({ event: "mounted" });
    },
    methods: {
      applyStatus(s) {
        this.signedToday = !!s.signedToday;
        this.streak = s.streak || 0;
        this.total = s.total || 0;
        this.week = s.week || [];
      },
      stateText(day) {
        if (day.signed) return "已签";
        if (day.isToday) return "今天";
        if (day.isFuture) return "未到";
        return "未签";
      },
      doSign() {
        if (this.signedToday) return;
        window.electronAPI.signIn_h_do({});
      },
      closeWindow() {
        window.electronAPI.signIn_h_bus({ event: "close" });
      },
    },
  };
  Vue.createApp(app).mount("#app");
})();
