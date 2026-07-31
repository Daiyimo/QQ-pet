(()=>{
var e={},
sendBus=p=>{window.electronAPI.store_h_bus(p)};

/* 官方 1.2.5 商城四区：推荐/喂养（食品/日用品/药品）、功能（玩具）、装扮（背景）。
   官方另有 shopGN.nums（充值）与 shopZB.skin（皮肤）依赖在线数据，不做。 */
const MALLS = [
  {label:"推荐", value:"shopTj", cls:"shopTj"},
  {label:"喂养", value:"shopWy", cls:"shopWy"},
  {label:"功能", value:"shopGN", cls:"shopGN"},
  {label:"装扮", value:"shopZB", cls:"shopZB"}
];
const MALL_TABS = {
  shopTj: [
    {label:"食品", value:"food"},
    {label:"日用品", value:"clean"},
    {label:"药品", value:"medicine"}
  ],
  shopWy: [
    {label:"食品", value:"food"},
    {label:"日用品", value:"clean"},
    {label:"药品", value:"medicine"}
  ],
  shopGN: [
    {label:"玩具", value:"toy"}
  ],
  shopZB: [
    {label:"背景", value:"background"}
  ]
};
/* 购物车「种类」列：item.type 是 shop.js 的 category */
const TYPE_NAMES = {
  food: "食品",
  commodity: "日用品",
  medicine: "药品",
  toy: "玩具",
  background: "背景"
};
/* 左栏储物柜（官方 1.2.5 我的背包）：喂养[食品/日用品/药品]、功能[玩具]、装扮[背景]。
   官方功能区另有「属性」子 tab（nums 充值物品）与「任务」大 tab，依赖在线数据，本项目没有，不做。 */
const BAG_MALLS = [
  {label:"喂养", value:"bagWy", cls:"bagWy"},
  {label:"功能", value:"bagGN", cls:"bagGN"},
  {label:"装扮", value:"bagZB", cls:"bagZB"}
];
const BAG_TABS = {
  bagWy: [
    {label:"食品", value:"food"},
    {label:"日用品", value:"commodity"},
    {label:"药品", value:"medicine"}
  ],
  bagGN: [
    {label:"玩具", value:"toy"}
  ],
  bagZB: [
    {label:"背景", value:"background"}
  ]
};
/* 背包类目 → 所属大区（每类全窗唯一，用于回包定位缓存 key） */
const BAG_TYPE_MALL = {
  food: "bagWy",
  commodity: "bagWy",
  medicine: "bagWy",
  toy: "bagGN",
  background: "bagZB"
};

const app = {
  data: () => ({
    petInfo: {info:{yb:0}, maxInfo:{level:1}},
    malls: MALLS,
    activeMall: "shopTj",
    activeTab: "food",
    /* 每「区+类」缓存一页数据：{items,total,current,pageSize,pinkDiamond} */
    cache: {},
    items: [],
    total: 0,
    current: 1,
    pageSize: 8,
    pinkDiamond: false,
    loading: false,
    error: "",
    /* 购物车：{goodKey: {goodKey,name,type,price,pd,cartNum}}，保持加入顺序 */
    cart: {},
    showCart: false,
    /* 结算：pending>0 表示批量购买进行中，buyResult 按计数回收 */
    paying: false,
    payPending: 0,
    payFails: [],
    toast: "",
    toastType: "info",
    toastTimer: null,
    /* 左栏储物柜（官方 1.2.5 我的背包）：按「区+类」缓存整页；bagTotal 为总页数 */
    bagMalls: BAG_MALLS,
    activeBagMall: "bagWy",
    activeBagTab: "food",
    bagCache: {},
    bgNameMap: {},
    bagItems: [],
    bagTotal: 0,
    bagCurrent: 1,
    bagPageSize: 6,
    bagLoading: false,
    bagError: "",
    /* 头部展示区点选中的背包物品 */
    selGood: null
  }),
  computed: {
    petAvatar(){
      const sex = this.petInfo?.info?.sex === 'MM' ? 'Girl' : 'Boy';
      return `../assets/img_res/Tray/${sex}/deafult.ico`;
    },
    petStats(){
      const i = this.petInfo?.info || {};
      const m = this.petInfo?.maxInfo || {};
      const row = (label, val, max, color) => {
        const v = Math.round(+val || 0);
        const mx = Math.max(1, Math.round(+max || 1));
        return { label, pct: Math.min(100, Math.round((v / mx) * 100)), text: `${v}/${mx}`, color };
      };
      return [
        row('饥饿', i.hunger, m.hunger, '#f0a03c'),
        row('清洁', i.clean, m.clean, '#4aa3e0'),
        row('心情', i.mood, m.mood, '#e2779f'),
        row('健康', i.health, m.health, '#67b96a'),
        row('成长', i.growth, m.nextGrowth, '#9b7ede'),
      ];
    },
    /* 当前装备的背景（activeOption.background，null = 无背景） */
    currentBg(){
      return this.petInfo?.activeOption?.background || null;
    },
    currentBgName(){
      const k = this.currentBg;
      if(!k) return "";
      return this.bgNameMap[k] || "已装备背景";
    },
    currentBgImg(){
      const k = this.currentBg;
      if(!k) return ""; // 无背景 = 不显示任何背景图
      return `../assets/img_res/background/xfpng/${k.replace(/^_/, "")}.png`;
    },
    bagCacheKey(){
      return this.activeBagMall + "_" + this.activeBagTab;
    },
    bagTabs(){
      return BAG_TABS[this.activeBagMall] || BAG_TABS.bagWy;
    },
    cacheKey(){
      return this.activeMall + "_" + this.activeTab;
    },
    tabs(){
      return MALL_TABS[this.activeMall] || MALL_TABS.shopTj;
    },
    cartList(){
      return Object.values(this.cart);
    },
    cartCount(){
      return this.cartList.reduce((n, row) => n + row.cartNum, 0);
    },
    /* 合计：粉钻 8 折（与官方 cg_price 同口径，单价先折再乘数量） */
    cartTotal(){
      return this.cartList.reduce((n, row) => n + this.unitPrice(row) * row.cartNum, 0);
    }
  },
  mounted(){
    this.loadPage(1);
    this.loadBagPage(1);
    /* 预拉全部已拥有背景，供头部"当前背景"显示名称（非当前 tab 响应只入缓存） */
    window.electronAPI.store_h_listBag({ type: "background", current: 1, pageSize: 20 });
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
      /* 只接收当前请求的「区+类」回包，避免切区后旧响应覆盖 */
      const key = (d.mallType || this.activeMall) + "_" + (d.type || this.activeTab);
      if(key !== this.cacheKey && !d.error) {
        this.cache[key] = d;
        return;
      }
      this.loading = false;
      if(d.error){ this.error = d.error; return; }
      this.error = "";
      this.cache[key] = d;
      this.items = Array.isArray(d.items) ? d.items : [];
      this.total = +d.total || 0;
      this.current = +d.current || 1;
      this.pageSize = +d.pageSize || 8;
      this.pinkDiamond = !!d.pinkDiamond;
    });
    window.electronAPI.store_m_buyResult((e,d)=>{
      if(d.petInfo) this.petInfo = d.petInfo;
      /* 批量结算进行中：按计数回收，全部回来后统一收尾 */
      if(this.payPending > 0){
        this.payPending--;
        if(!d.ok) this.payFails.push(d.msg || "购买失败");
        if(this.payPending === 0) this.finishCheckout();
        return;
      }
      this.showToast(d.msg || (d.ok ? "购买成功" : "购买失败"), d.ok ? "ok" : "err");
    });
    window.electronAPI.store_m_bag((e,d)=>{
      /* 背包页回包：type 全窗唯一，据此定位缓存 key；非当前页只入库 */
      const key = (BAG_TYPE_MALL[d.type] || this.activeBagMall) + "_" + (d.type || this.activeBagTab);
      if(!d.error) this.bagCache[key] = d;
      /* 背景名录：任何背景回包都合并进来，供头部"当前背景"显示名称 */
      if(d.type === "background" && Array.isArray(d.result)) {
        d.result.forEach(it => { this.bgNameMap[it.keyName] = it.name; });
      }
      if(key !== this.bagCacheKey) return;
      this.bagLoading = false;
      if(d.error){ this.bagError = d.error; return; }
      this.bagError = "";
      this.bagItems = Array.isArray(d.result) ? d.result : [];
      this.bagTotal = +d.total || 0;
      this.bagCurrent = +d.current || 1;
      this.bagPageSize = +d.pageSize || 6;
      /* 使用/购买刷新后同步选中物品（同类目下用完则清除选中） */
      if(this.selGood && this.selGood.type === d.type){
        this.selGood = this.bagItems.find(it => it.keyName === this.selGood.keyName) || null;
      }
    });
    window.electronAPI.store_m_useGoodResult((e,d)=>{
      if(d.petInfo) this.petInfo = d.petInfo;
      this.showToast(d.msg || (d.ok ? "使用成功" : "使用失败"), d.ok ? "ok" : "err");
    });
    window.electronAPI.store_m_bagRefresh((e,d)=>{
      /* 购买成功后主进程广播：新购物品入柜，左栏缓存失效重拉当前页 */
      this.bagCache = {};
      this.loadBagPage(this.bagCurrent);
    });
    sendBus({event:"mounted"});
  },
  methods: {
    switchMall(value){
      if(this.activeMall === value) return;
      this.activeMall = value;
      /* 切区回到该区第一个子类（官方行为） */
      this.activeTab = this.tabs[0].value;
      this.loadPage(1);
    },
    switchTab(value){
      if(this.activeTab === value) return;
      this.activeTab = value;
      this.loadPage(1);
    },
    gotoPage(page){
      if(page < 1 || this.total < 1 || page > this.total || page === this.current) return;
      this.loadPage(page);
    },
    loadPage(page){
      /* 命中缓存且同页则直接展示，否则向主进程请求（主进程返回整页数据） */
      const hit = this.cache[this.cacheKey];
      if(hit && +hit.current === page && Array.isArray(hit.items)){
        this.items = hit.items;
        this.total = +hit.total || 0;
        this.current = page;
        this.pageSize = +hit.pageSize || 8;
        this.pinkDiamond = !!hit.pinkDiamond;
        this.error = "";
        return;
      }
      this.loading = true;
      this.error = "";
      window.electronAPI.store_h_listGoods({
        mallType: this.activeMall,
        type: this.activeTab,
        current: page
      });
    },
    onIconError(event){
      /* 图标缺失时隐藏 img（露出卡槽底图） */
      if(event?.target) event.target.style.display = "none";
    },
    /* === 左栏储物柜（官方 1.2.5 我的背包） === */
    switchBagMall(value){
      if(this.activeBagMall === value) return;
      this.activeBagMall = value;
      /* 切区回到该区第一个子类（官方行为），并清空选中展示 */
      this.activeBagTab = this.bagTabs[0].value;
      this.selGood = null;
      this.loadBagPage(1);
    },
    switchBagTab(value){
      if(this.activeBagTab === value) return;
      this.activeBagTab = value;
      this.selGood = null;
      this.loadBagPage(1);
    },
    bagGoto(page){
      if(page < 1 || this.bagTotal < 1 || page > this.bagTotal || page === this.bagCurrent) return;
      this.loadBagPage(page);
    },
    loadBagPage(page){
      /* 命中缓存且同页则直接展示，否则向主进程请求背包页（getConsumablesPage） */
      const hit = this.bagCache[this.bagCacheKey];
      if(hit && +hit.current === page && Array.isArray(hit.result)){
        this.bagItems = hit.result;
        this.bagTotal = +hit.total || 0;
        this.bagCurrent = page;
        this.bagPageSize = +hit.pageSize || 6;
        this.bagError = "";
        return;
      }
      this.bagLoading = true;
      this.bagError = "";
      window.electronAPI.store_h_listBag({
        type: this.activeBagTab,
        current: page,
        pageSize: 6
      });
    },
    selectGood(item){
      this.selGood = item;
    },
    /* 背景是否当前装备中（_b0000000 代表无背景） */
    isCurBg(keyName){
      return keyName === "_b0000000" ? !this.currentBg : this.currentBg === keyName;
    },
    /* 使用一个背包道具：整对象透传（含 keyName/num/type/属性），主进程走 Goods.useConsumables 结算 */
    useGood(item){
      if(!item?.keyName || !item?.type) return;
      window.electronAPI.store_h_useGood({...item, current: this.bagCurrent, pageSize: this.bagPageSize});
    },
    /* 价格行只显示实付价：粉钻 8 折价，非粉钻原价（购买侧折扣在 Goods.buy 内同样处理） */
    pinkPrice(item){
      return Math.round((+item?.price || 0) * 0.8);
    },
    displayPrice(item){
      return this.pinkDiamond ? this.pinkPrice(item) : (+item?.price || 0);
    },
    unitPrice(row){
      return this.pinkDiamond ? Math.round((+row.price || 0) * 0.8) : (+row.price || 0);
    },
    linePrice(row){
      return this.unitPrice(row);
    },
    typeName(type){
      return TYPE_NAMES[type] || type || "其他";
    },
    /* 悬停浮层属性行（对齐官方 DP 函数：desc / 饥饿 / 清洁 / 魅力智力武力心情） */
    floatRows(item){
      const rows = [];
      if(item?.desc) rows.push(item.desc);
      const starve = +(item?.starve ?? item?.valueList?.starve?.value) || 0;
      const clean = +(item?.clean ?? item?.valueList?.clean?.value) || 0;
      if(starve) rows.push("饥饿：" + starve);
      if(clean) rows.push("清洁：" + clean);
      let attrs = "";
      if(item?.charm) attrs += " 魅力+" + item.charm;
      if(item?.intel) attrs += " 智力+" + item.intel;
      if(item?.strong) attrs += " 武力+" + item.strong;
      if(item?.mood) attrs += " 心情+" + item.mood;
      if(attrs) rows.push(attrs.trim());
      return rows;
    },
    /* === 购物车 === */
    addToCart(item){
      if(!item?.keyName || !item?.type) return;
      const goodKey = item.type + "*" + item.keyName;
      const old = this.cart[goodKey];
      if(old) old.cartNum = Math.min(old.cartNum + 1, 99);
      else this.cart[goodKey] = {
        goodKey,
        name: item.name,
        type: item.type,
        price: +item.price || 0,
        pd: !!item.pd,
        cartNum: 1
      };
      this.showToast("已加入购物车：" + item.name, "ok");
    },
    stepCart(row, delta){
      if(!row) return;
      const next = Math.min(Math.max(row.cartNum + delta, 1), 99);
      row.cartNum = next;
    },
    openCart(){
      this.showCart = true;
    },
    buyNow(item){
      if(this.paying || !item?.keyName || !item?.type) return;
      window.electronAPI.store_h_buy({goodKey: item.type + "*" + item.keyName});
    },
    /* 结算：逐件走 store_h_buy（购买通道是单件，批量=循环调用），
       全部成功后清空购物车并通知主进程播放彩蛋台词 */
    checkout(){
      if(this.paying) return;
      const jobs = [];
      for(const row of this.cartList){
        for(let i = 0; i < row.cartNum; i++) jobs.push(row.goodKey);
      }
      if(jobs.length === 0){
        this.showToast("购物车是空的", "info");
        return;
      }
      if((+this.petInfo?.info?.yb || 0) < this.cartTotal){
        this.showToast("元宝不足，还差 " + (this.cartTotal - (+this.petInfo?.info?.yb || 0)) + " 元宝", "err");
        return;
      }
      this.paying = true;
      this.payPending = jobs.length;
      this.payFails = [];
      for(const goodKey of jobs) window.electronAPI.store_h_buy({goodKey});
    },
    finishCheckout(){
      this.paying = false;
      if(this.payFails.length === 0){
        this.cart = {};
        this.showCart = false;
        /* 官方彩蛋：谢谢[host],帮我清空了购物车~~（主进程 openSpeak 气泡） */
        sendBus({event:"cartCleared"});
        this.showToast("结算成功，已清空购物车", "ok");
      }else{
        this.showToast(this.payFails[0], "err");
      }
      this.payFails = [];
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
