(()=>{
var e={},
sendBus=p=>{window.electronAPI.store_h_bus(p)};

const ICON_MAP = {
  food: "🍖",
  commodity: "🧴",
  medicine: "💊",
  background: "🖼️"
};

const app = {
  data: () => ({
    petInfo: {info:{yb:0}, maxInfo:{level:1}},
    tabs: [
      {label:"食品", value:"food"},
      {label:"日用品", value:"commodity"},
      {label:"药品", value:"medicine"}
    ],
    activeTab: "food",
    cache: {food:[], commodity:[], medicine:[]},
    loading: false,
    error: "",
    toast: "",
    toastType: "info",
    toastTimer: null
  }),
  computed: {
    filteredItems(){
      const list = this.cache[this.activeTab] || [];
      return list
        .filter(it => it && +it.price > 0)
        .sort((a,b) => (+a.price) - (+b.price));
    }
  },
  mounted(){
    this.switchTab(this.activeTab);
    window.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.shiftKey) {
        if (event.key === "3" || event.code === "Digit3" || event.code === "Numpad3") {
          sendBus({ event: "shortcut", key: "Ctrl+Shift+3" });
        } else if (event.key === "4" || event.code === "Digit4" || event.code === "Numpad4") {
          sendBus({ event: "shortcut", key: "Ctrl+Shift+4" });
        } else if (event.key === "1" || event.code === "Digit1" || event.code === "Numpad1") {
          sendBus({ event: "shortcut", key: "Ctrl+Shift+1" });
        } else if (event.key === "2" || event.code === "Digit2" || event.code === "Numpad2") {
          sendBus({ event: "shortcut", key: "Ctrl+Shift+2" });
        } else if (event.key === "/" || event.code === "NumpadDivide") {
          sendBus({ event: "shortcut", key: "Ctrl+Shift+numdiv" });
        } else if (event.key === "*" || event.code === "NumpadMultiply") {
          sendBus({ event: "shortcut", key: "Ctrl+Shift+nummult" });
        } else if (event.key === "-" || event.code === "NumpadSubtract") {
          sendBus({ event: "shortcut", key: "Ctrl+Shift+numsub" });
        } else if (event.key === "+" || event.code === "NumpadAdd") {
          sendBus({ event: "shortcut", key: "Ctrl+Shift+numadd" });
        }
      }
    });
    window.electronAPI.store_m_bus((e,d)=>{
      if(d.type === "load"){
        this.petInfo = d.data || this.petInfo;
        seeApp();
      }
    });
    window.electronAPI.store_m_petInfo((e,d)=>{
      if(d.type === "info") this.petInfo = d.data || this.petInfo;
    });
    window.electronAPI.store_m_goods((e,d)=>{
      this.loading = false;
      if(d.error){ this.error = d.error; return; }
      this.error = "";
      this.cache[d.type] = d.items || [];
    });
    window.electronAPI.store_m_buyResult((e,d)=>{
      if(d.petInfo) this.petInfo = d.petInfo;
      this.showToast(d.msg || (d.ok ? "购买成功" : "购买失败"), d.ok ? "ok" : "err");
    });
    sendBus({event:"mounted"});
  },
  methods: {
    switchTab(value){
      this.activeTab = value;
      if(this.cache[value] && this.cache[value].length > 0) return;
      this.loading = true;
      this.error = "";
      window.electronAPI.store_h_listGoods({type: value});
    },
    iconFor(item){
      return ICON_MAP[item?.type] || "📦";
    },
    buy(item){
      if(!item?.keyName || !item?.type) return;
      const goodKey = item.type + "*" + item.keyName;
      window.electronAPI.store_h_buy({goodKey});
    },
    showToast(msg, type){
      this.toast = msg;
      this.toastType = type === "ok" ? "ok" : (type === "err" ? "err" : "info");
      if(this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(()=>{ this.toast = ""; }, 2400);
    },
    closeWindow(){
      sendBus({event:"close"});
    }
  }
};

Vue.createApp(app).mount("#app");

var w=window;
for(var k in e) w[k]=e[k];
e.__esModule && Object.defineProperty(w,"__esModule",{value:!0});
})();
