// 新手礼包：首次创建宠物时的默认背包 —— 商店全品类道具各 10 个。
// 离线+AI版定位：元宝与道具不设门槛，用户可自由体验全部喂养/清洁/治疗内容。
// 背包数据形态见 Goods.js：getCache("store") -> { food: ["_<id>-<数量>", ...], commodity, medicine, background, toy }。
// 独立成多行模块，压缩文件 doMain.js 里只留一行接入点（项目对 webpack 压缩区的改动约定）。
const { shop } = require("./shop.js");

const STARTER_ITEM_COUNT = 10;

/**
 * 生成新手背包：shop.js 里 food / commodity / medicine / background / toy 五类商品各 count 个。
 * service / work / study / trip 不是道具（服务与课程），不进背包。
 */
function buildStarterStore(count = STARTER_ITEM_COUNT) {
  const store = { food: [], commodity: [], medicine: [], background: [], toy: [] };
  for (const category of Object.keys(store)) {
    const goods = shop[category] || {};
    for (const key of Object.keys(goods)) {
      store[category].push(`${key}-${count}`);
    }
  }
  return store;
}

module.exports = { buildStarterStore, STARTER_ITEM_COUNT };
