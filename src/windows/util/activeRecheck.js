/**
 * activeRecheck.js —— 打工/上学的准入校验（纯 node，无 electron / 无第三方依赖）
 *
 * 背景：popups/control 的 useActiveData 分两步走：
 *   第一步 activeIt 为假 → 跑一遍校验并弹「确定要去 xxx 吗？」
 *   第二步 activeIt 为真 → 直接执行 activeWork / activeStudy
 * 第二步不复检，中间窗口里宠物可能已经生病/死亡/开始了别的活动（TOCTOU），
 * 于是「生病中还能去打工」这类越权成立。把校验抽成纯函数，两步都跑同一套。
 *
 * state 由调用方从 getPetInfoOne 读取，本模块不碰任何全局。
 */

/** 活动类型 → 生病时的提示后半句 */
const ILL_TAIL = {
  work: "~我生病，等我治疗好了再赚元宝吧~~",
  study: "~我生病，等我治疗好了再上学吧~~",
};

/**
 * @typedef {object} ActiveState
 * @property {*} work 进行中的打工（真值表示忙）
 * @property {*} study 进行中的学习
 * @property {*} trip 进行中的旅行
 * @property {*} ill 生病/死亡状态对象（含 type）
 * @property {*} level 当前等级
 * @property {object} studyValue 各科学历值
 * @property {string} host 主人称呼
 */

/**
 * 打工/上学准入校验。
 * @param {object} payload 渲染层 payload（type/need/education/tolkName/activeIt...）
 * @param {ActiveState} state 主进程侧读到的当前宠物状态
 * @returns {{ok:boolean,msg:string,reason:string}}
 */
function canDoActive(payload, state) {
  const p = payload && typeof payload === "object" ? payload : {};
  const s = state && typeof state === "object" ? state : {};
  const host = typeof s.host === "string" ? s.host : "";
  const type = p.type === "study" ? "study" : "work";

  if (s.work || s.study || s.trip) {
    return { ok: false, reason: "busy", msg: host + "~做什么事都要专心哦~~" };
  }

  if (s.ill) {
    const dead = s.ill && s.ill.type === "dead";
    return {
      ok: false,
      reason: dead ? "dead" : "ill",
      msg: dead ? "您的宠物已死亡~" : host + ILL_TAIL[type],
    };
  }

  if (type === "work") {
    const level = Number(s.level);
    const need = Number(p.need);
    if (!Number.isFinite(level) || level <= 0 || (Number.isFinite(need) && need > level)) {
      return { ok: false, reason: "level", msg: host + "~我的等级不够哦，陪我长大再试试吧~~" };
    }
    const own = s.studyValue && typeof s.studyValue === "object" ? s.studyValue : {};
    const need2 = p.education && typeof p.education === "object" ? p.education : {};
    for (const subject in need2) {
      const want = Number(need2[subject]);
      if (!want) continue;
      const has = Number(own[subject]);
      if (!Number.isFinite(has) || has < want) {
        return { ok: false, reason: "education", msg: host + "~书到用时方恨少啊，我要努力学习~~" };
      }
    }
    return { ok: true, reason: "ok", msg: host + "~确定要去" + (p.tolkName || "") + "吗？" };
  }

  return { ok: true, reason: "ok", msg: host + "~确定要学习" + (p.tolkName || "") + "吗？" };
}

module.exports = { canDoActive, ILL_TAIL };
