// achievement 渲染层：Vue 全局构建（vue.global.js 已由窗口工厂注入），只走 contextBridge API。
(() => {
  // icon 为 svg 名（src/assets/achievement/ 下）或 emoji 占位
  const SVG_ICONS = ["yyds", "ddw", "travel"];

  const app = {
    data() {
      return {
        list: [], // [{ id, name, desc, icon, unlocked, unlockedAt }]
      };
    },
    computed: {
      unlockedCount() {
        return this.list.filter((item) => item.unlocked).length;
      },
    },
    mounted() {
      window.electronAPI.achievement_m_load((event, data) => {
        if (!data || !data.ok) return;
        this.list = data.list || [];
      });
      window.electronAPI.achievement_h_load({});
    },
    methods: {
      isSvg(item) {
        return SVG_ICONS.includes(item.icon);
      },
      iconSrc(item) {
        return "../assets/achievement/" + item.icon + ".svg";
      },
      // ISO 时间 -> YYYY-MM-DD
      fmtDate(iso) {
        return iso ? String(iso).slice(0, 10) : "";
      },
      closeWindow() {
        window.electronAPI.achievement_h_close({});
      },
    },
  };
  Vue.createApp(app).mount("#app");
})();
