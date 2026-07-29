// aiChat 渲染层：Vue 全局构建（vue.global.js 已由窗口工厂注入），只走 contextBridge API。
(() => {
  const app = {
    data() {
      return {
        messages: [], // [{ role: "user" | "pet", text }]
        input: "",
        withScreen: false,
        thinking: false,
      };
    },
    mounted() {
      window.electronAPI.aiChat_m_reply((event, data) => {
        if (!data) return;
        if (data.type === "cleared") {
          this.messages = [];
          this.thinking = false;
          return;
        }
        this.thinking = false;
        if (data.ok) {
          this.messages.push({ role: "pet", text: data.reply || "" });
        } else {
          this.messages.push({
            role: "pet",
            text: "呜呜，出了点问题：" + (data.error || "未知错误"),
          });
        }
        this.scrollToBottom();
      });
    },
    methods: {
      send() {
        const text = (this.input || "").trim();
        if (!text || this.thinking) return;
        this.messages.push({ role: "user", text });
        this.input = "";
        this.thinking = true;
        this.scrollToBottom();
        window.electronAPI.aiChat_h_send({
          text,
          withScreen: this.withScreen,
        });
      },
      clearChat() {
        this.messages = [];
        this.thinking = false;
        window.electronAPI.aiChat_h_clear({});
      },
      closeWindow() {
        window.electronAPI.aiChat_h_close({});
      },
      scrollToBottom() {
        this.$nextTick(() => {
          const el = this.$refs.msgList;
          if (el) el.scrollTop = el.scrollHeight;
        });
      },
    },
  };
  Vue.createApp(app).mount("#app");
})();
