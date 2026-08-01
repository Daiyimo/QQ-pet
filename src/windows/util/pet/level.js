// 宠物等级上限（README：「等级上限 400 级」）。levels 表末尾的哨兵项不参与等级匹配。
const LEVEL_CAP = 400;

class LevelFn {
  levels = [
    0, 100, 300, 600, 1100, 1800, 2800, 4200, 5900, 8000, 10600, 13700, 17400,
    21700, 26700, 32500, 39000, 46300, 54500, 63600, 73700, 84800, 97000,
    110400, 124900, 140600, 157600, 175900, 195600, 216700, 239300, 263500,
    289200, 316500, 345500, 376200, 408700, 443000, 479200, 517400, 557500,
    599600, 643800, 690100, 738600, 789300, 842300, 897700, 955400, 1015500,
    1078100, 1143200, 1210900, 1281200, 1354200, 1430000, 1508500, 1589800,
    1674000, 1761100, 1851200, 1944300, 2040500, 2139900, 2242400, 2348100,
    2457100, 2569400, 2685100, 2804200, 2926800, 3053000, 3182700, 3316000,
    3453000, 3593700, 3738200, 3886500, 4038700, 4194900, 4355000, 4519100,
    4687300, 4859600, 5036100, 5216800, 5401800, 5591200, 5784900, 5983000,
    6185600, 6392700, 6604400, 6820700, 7041700, 7267500, 7498000, 7733300,
    7973500, 8218600, 8468700, 8723800, 8984000, 9249400, 9519900, 9795600,
    10076600, 10362900, 10654600, 10951700, 11254300, 11562500, 11876200,
    12195500, 12520500, 12851200, 13187700, 13530000, 13878200, 14232400,
    14592500, 14958600, 15330800, 15709100, 16093600, 16484300, 16881300,
    17284700, 17694400, 18110500, 18533100, 18962200, 19397900, 19840200,
    20289200, 20745000, 21207500, 21676800, 22153000, 22636100, 23126200,
    23623300, 24127500, 24638900, 25157400, 25683100, 26216100, 26756400,
    27304100, 27859200, 28421800, 28992000, 29569700, 30155000, 30748000,
    31348700, 31957200, 32573500, 33197700, 33829900, 34470000, 35118100,
    35774300, 36438600, 37111100, 37791800, 38480800, 39178200, 39883900,
    40598000, 41320600, 42051700, 42791400, 43539700, 44296700, 45062500,
    45837000, 46620300, 47412500, 48213600, 49023700, 49842800, 50671000,
    51508400, 52354900, 53210600, 54075600, 54949900, 55833600, 56726700,
    57629300, 58541500, 59463200, 60394500, 61335500, 62286200, 63246700,
    64217000, 65197200, 66187400, 67187500, 68197600, 69217800, 70248100,
    71288600, 72339300, 73400300, 74471700, 75553400, 76645500, 77748100,
    78861200, 79984900, 81119200, 82264200, 83420000, 84586500, 85763800,
    86952000, 88151100, 89361200, 90582300, 91814500, 93057900, 94312400,
    95578100, 96855100, 98143400, 99443100, 100754200, 102076800, 103411000,
    104756700, 106114000, 107483000, 108863700, 110256200, 111660500, 113076700,
    114504900, 115945000, 117397100, 118861300, 120337600, 121826100, 123326800,
    124839800, 126365200, 127902900, 129453000, 131015600, 132590700, 134178400,
    135778700, 137391700, 139017500, 140656000, 142307300, 143971500, 145648600,
    147338700, 149041800, 150758000, 152487400, 154229900, 155985600, 157754600,
    159536900, 161332600, 163141700, 164964300, 166800500, 168650200, 170513500,
    172390500, 174281200, 176185700, 178104000, 180036200, 181982400, 183942500,
    185916600, 187904800, 189907100, 191923600, 193954300, 195999300, 198058700,
    200132400, 202220500, 204323100, 206440200, 208571900, 210718200, 212879200,
    215055000, 217245500, 219450800, 221671000, 223906100, 226156200, 228421300,
    230701500, 232996900, 235307400, 237633100, 239974100, 242330400, 244702100,
    247089200, 249491800, 251910000, 254343700, 256793000, 259258000, 261738700,
    264235200, 266747500, 269275700, 271819900, 274380000, 276956100, 279548300,
    282156600, 284781100, 287421800, 290078800, 292752200, 295441900, 298148000,
    300870600, 303609700, 306365400, 309137700, 311926700, 314732500, 317555000,
    320394300, 323250500, 326123600, 329013700, 331920800, 334845000, 337786400,
    340744900, 343720600, 346713600, 349723900, 352751600, 355796700, 358859300,
    361939500, 365037200, 368152500, 371285500, 374436200, 377604700, 380791000,
    383995200, 387217400, 390457500, 393715600, 396991800, 400286100, 403598600,
    406929300, 410278300, 413645700, 417031400, 420435500, 423858100, 427299200,
    430758900, 434237200, 437734200, 441250000, 444784500, 448337800, 451910000,
    455501100, 459111200, 462740300, 466388500, 470055900, 473742400, 477448100,
    481173100, 484917400, 488681100, 492464200, 496266800, 500089000, 503930700,
    507792000, 511673000, 515573700, 519494200, 523434500, 527394700, 531374900,
    535375000, 539395200,
  ];
  level = 1;
  constructor() {}
  // 成长值 -> 等级。等级 k 对应区间 [levels[k-1], levels[k])。
  // 上限 400 级（README「等级上限 400 级」），levels 表末尾多出的哨兵项不参与匹配。
  // 注意：level 必须是局部量——本类是模块级单例（下方 const Level），若把中间结果写回
  // this.level 再读出来，未匹配分支会把上一次调用的等级泄漏给下一次调用者。
  getNowLevel(growth) {
    if (!growth || +growth != +growth)
      return {
        upGrowth: 0,
        nextGrowth: this.levels[1],
        level: 1,
      };
    growth = +growth;
    const maxLevel = Math.min(LEVEL_CAP, this.levels.length - 1);
    let result = [];
    let level = 1;
    for (let k = 1; k <= maxLevel; k++) {
      if (growth >= this.levels[k - 1] && growth < this.levels[k]) {
        result = [this.levels[k - 1], this.levels[k]];
        level = k;
        break;
      }
    }
    // 成长值已达/超过封顶阈值：显式返回顶级，不能落回默认值或上次调用的残留值
    if (result.length === 0) {
      result = [this.levels[maxLevel - 1], this.levels[maxLevel]];
      level = maxLevel;
    }
    this.level = level;
    return {
      upGrowth: result[0],
      nextGrowth: result[1],
      level,
    };
  }
}
const Level = new LevelFn();

//粉钻成长值
class pinkDiamondFn {
  levels = [0, 100, 300, 600, 1100, 1800, 2800];
  // 与 LevelFn 对齐：必须有初值，否则首次以「成长值已封顶」调用时返回 undefined，
  // 会经 toChangeOtherDatas 变成 NaN 写进钓鱼次数。
  level = 1;
  constructor() {}
  // 粉钻等级 1~7：等级 k 对应 [levels[k-1], levels[k])，顶级 7 为开区间 [2800, +∞)。
  // 原实现循环到 k<=7 时要比较 levels[7]（undefined），恒不成立，导致 7 级不可达且
  // growth>=2800 时返回 this.level 的残留值/undefined。
  getNowLevel(growth) {
    if (!growth || +growth != +growth)
      return {
        upGrowth: 0,
        nextGrowth: this.levels[1],
        level: 1,
      };
    growth = +growth;
    const topLevel = this.levels.length; // 7：最高一级没有上界阈值
    let result = [];
    let level = 1;
    for (let k = 1; k < topLevel; k++) {
      if (growth >= this.levels[k - 1] && growth < this.levels[k]) {
        result = [this.levels[k - 1], this.levels[k]];
        level = k;
        break;
      }
    }
    // growth >= levels[最后一项] -> 顶级（7 级）。
    // 顶级没有下一档阈值，返回 [2800, 2800] 表示「已满级」：
    //   - upGrowth 必须是 7 级自己的下界 2800。返回 6 级的 [1800,2800) 会与 level:7
    //     自相矛盾，任何按 (growth-upGrowth)/(nextGrowth-upGrowth) 算进度的调用方都会 >100%；
    //   - nextGrowth 同样取 2800（而不是 0/undefined），否则 isExpirationDate 里
    //     `nextGrowth || 100` 的兜底会把下一档阈值错显成 100。
    if (result.length === 0) {
      result = [this.levels[topLevel - 1], this.levels[topLevel - 1]];
      level = topLevel;
    }
    this.level = level;
    return {
      upGrowth: result[0],
      nextGrowth: result[1],
      level,
    };
  }
  // 一天的毫秒数（历史命名 hour 名不副实，是一天不是一小时）
  dayMs = 1000 * 60 * 60 * 24;
  isExpirationDate(pinkDiamondOPt) {
    let opt = { growth: pinkDiamondOPt.growth || 0 };
    if (pinkDiamondOPt.pinkDiamondExpirationDate) {
      //如果有粉钻到期时间
      //计算需不需要加成长值 - 有过期时间一定保证有开始时间
      //过期时间 - 开始时间 一定是天的倍数 dayMs * n
      // 判定是否过期
      let cutTime = 0,
        nowTime = new Date().getTime();
      if (nowTime >= pinkDiamondOPt.pinkDiamondExpirationDate) {
        //过期
        opt.pinkDiamond = false;
        //按照开始和结束过了多少天算成长值
        cutTime =
          pinkDiamondOPt.pinkDiamondExpirationDate -
          pinkDiamondOPt.pinkDiamondBeginDate;
        opt.growthValue = 0;
        opt.pinkDiamondBeginDate = 0;
        opt.pinkDiamondExpirationDate = 0;
      } else {
        opt.pinkDiamond = true;
        opt.growthValue = pinkDiamondOPt.growthValue || 20;
        //按到现在的时间
        cutTime = nowTime - pinkDiamondOPt.pinkDiamondBeginDate;
      }

      let dayNum = (cutTime / this.dayMs) | 0;
      if (dayNum > 0) {
        if (nowTime < pinkDiamondOPt.pinkDiamondExpirationDate) {
          //未过期情况下 说明过了天数 把开始时间减去计算了的时间
          opt.pinkDiamondBeginDate = tool.getDayHourTime();
        }
        opt.growth = opt.growth + dayNum * (pinkDiamondOPt.growthValue || 20);
        // console.log("dayNum", dayNum);
        // 计算等级
      }
      let lev = this.getNowLevel(opt.growth);
      opt.pinkDiamondLevel = lev.level;
      opt.growthValue_next = lev.nextGrowth || 100;
    }
    return opt;
  }
  toChangeOtherDatas(pinkDiamondOPt) {
    //重置🐟
    let fishing = {};
    // 等级缺失/非数字一律按 0 计，避免 undefined*2 = NaN 写进钓鱼次数
    let level = +pinkDiamondOPt.pinkDiamondLevel;
    if (!Number.isFinite(level) || level < 0) level = 0;
    fishing.allvipcnt = level * 2;
    // 有粉钻才给可用次数，无粉钻恒为 0
    fishing.canusecnt = pinkDiamondOPt.pinkDiamond ? fishing.allvipcnt : 0;
    return { fishing };
  }
}
const pinkDiamondLevel = new pinkDiamondFn();
// 双模加载：主进程/测试是 CommonJS，渲染层是普通 script（没有 module）。
// 用 typeof 判定而不是 try/catch —— module 缺失是可预期分支，靠捕获 ReferenceError
// 再正则匹配 "module is not defined" 依赖的是 V8 的英文异常文本，不是 API 契约，
// 换引擎/换 locale 就会开始刷日志；而裸 catch 又会顺手吞掉真正的赋值异常。
// 同 src/ini/root.js 的写法。
if (typeof module !== "undefined" && module) {
  module.exports = { Level, pinkDiamondLevel };
}
