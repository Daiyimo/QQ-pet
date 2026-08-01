// activeRecheck.js 单元测试：打工/上学准入校验（含二次确认复检 TOCTOU 场景）
// 运行：node --test test/activeRecheck.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { canDoActive } = require("../src/windows/util/activeRecheck.js");

// 一切正常的基线状态：空闲、健康、10 级、各科学历 50
function okState(over = {}) {
  return {
    work: null,
    study: null,
    trip: null,
    ill: null,
    level: 10,
    studyValue: { chinese: 50, mathematics: 50 },
    host: "主人",
    ...over,
  };
}

const workPayload = { type: "work", need: 5, tolkName: "送报纸", education: { chinese: 10 } };
const studyPayload = { type: "study", tolkName: "语文" };

test("空闲健康达标时放行，并给出确认文案", () => {
  const r = canDoActive(workPayload, okState());
  assert.equal(r.ok, true);
  assert.equal(r.reason, "ok");
  assert.equal(r.msg, "主人~确定要去送报纸吗？");

  const s = canDoActive(studyPayload, okState());
  assert.equal(s.ok, true);
  assert.equal(s.msg, "主人~确定要学习语文吗？");
});

test("已有进行中的活动一律拒绝（work/study/trip 任一）", () => {
  for (const busy of ["work", "study", "trip"]) {
    const r = canDoActive(workPayload, okState({ [busy]: { id: 1 } }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "busy");
    assert.equal(r.msg, "主人~做什么事都要专心哦~~");
  }
});

test("生病/死亡拒绝，且文案按活动类型区分", () => {
  const ill = canDoActive(workPayload, okState({ ill: { type: "cold" } }));
  assert.equal(ill.ok, false);
  assert.equal(ill.reason, "ill");
  assert.equal(ill.msg, "主人~我生病，等我治疗好了再赚元宝吧~~");

  const illStudy = canDoActive(studyPayload, okState({ ill: { type: "cold" } }));
  assert.equal(illStudy.msg, "主人~我生病，等我治疗好了再上学吧~~");

  const dead = canDoActive(workPayload, okState({ ill: { type: "dead" } }));
  assert.equal(dead.ok, false);
  assert.equal(dead.reason, "dead");
  assert.equal(dead.msg, "您的宠物已死亡~");
});

test("打工校验等级：need 高于等级或无等级都拒绝", () => {
  assert.equal(canDoActive({ ...workPayload, need: 11 }, okState({ level: 10 })).reason, "level");
  assert.equal(canDoActive(workPayload, okState({ level: 0 })).reason, "level");
  assert.equal(canDoActive(workPayload, okState({ level: "" })).reason, "level");
  assert.equal(canDoActive(workPayload, okState({ level: undefined })).reason, "level");
  // need 恰好等于等级：放行
  assert.equal(canDoActive({ ...workPayload, need: 10 }, okState({ level: 10 })).ok, true);
});

test("打工校验学历门槛：任一科目不足即拒绝", () => {
  const p = { ...workPayload, education: { chinese: 60, mathematics: 10 } };
  const r = canDoActive(p, okState());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "education");
  assert.equal(r.msg, "主人~书到用时方恨少啊，我要努力学习~~");

  // 学历值缺失同样按不足处理
  assert.equal(canDoActive({ ...workPayload, education: { music: 1 } }, okState()).reason, "education");
  // 门槛为 0/假值的科目跳过
  assert.equal(canDoActive({ ...workPayload, education: { music: 0 } }, okState()).ok, true);
});

test("上学不校验等级与学历（与原逻辑一致）", () => {
  const r = canDoActive(studyPayload, okState({ level: 0, studyValue: {} }));
  assert.equal(r.ok, true);
});

test("TOCTOU：确认前放行、确认时状态已变则必须拒绝（同一 payload 两次调用）", () => {
  // 第一步：弹确认框时宠物健康空闲 → 放行
  const before = canDoActive(workPayload, okState());
  assert.equal(before.ok, true);

  // 第二步：用户点"确定"（activeIt=true）时宠物已生病 → 复检必须拦住
  const confirmed = { ...workPayload, activeIt: true };
  const after = canDoActive(confirmed, okState({ ill: { type: "cold" } }));
  assert.equal(after.ok, false);
  assert.equal(after.reason, "ill");

  // 中途被别的活动占用同样拦住
  assert.equal(canDoActive(confirmed, okState({ trip: { id: 9 } })).reason, "busy");
  // 中途死亡
  assert.equal(canDoActive(confirmed, okState({ ill: { type: "dead" } })).reason, "dead");
});

test("TOCTOU：复检必须发生在 activeIt 早退之前（control/main.js 压缩区调用顺序）", () => {
  // 上一条只验证纯函数本身，无法发现"复检被挪到 if(!i.activeIt) 之后"——那样二次确认路径
  // 会绕过复检，8 条纯函数断言仍全绿。这里按项目惯例（见 pinkDiamond125.test.js）对压缩
  // 产物做结构断言，把调用顺序钉死：整段连续文本必须原样存在。
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src/windows/popups/control/main.js"),
    "utf8"
  );
  for (const type of ["work", "study"]) {
    const frag =
      `if("${type}"==i.type){const _c=_canDoActive(i,_readActiveState());` +
      `if(!_c.ok)return i.activeIt&&console.warn("[control] ${type} 二次确认复检未通过，已拦截:",_c.reason),` +
      `void t.webContents.send("control_bus-html_setActiveData",{data:{msg:_c.msg},type:"err"});` +
      `if(!i.activeIt)return`;
    assert.ok(
      src.includes(frag),
      `${type} 分支必须先 _canDoActive(i,_readActiveState()) 复检并在 !ok 时 return，` +
        `再走 if(!i.activeIt) 的首次确认早退；顺序被调换或复检被删即视为回归`
    );
  }
  // 防止"顺序对了但又在别处补了一次调用"的伪修复：全文只应有 work/study 两处复检
  assert.equal(
    src.split("_canDoActive(i,_readActiveState())").length - 1,
    2,
    "_canDoActive 复检应只出现在 work / study 两个分支"
  );
});

test("入参/状态缺失时不抛异常，按拒绝或安全默认处理", () => {
  assert.equal(canDoActive(undefined, undefined).ok, false); // 无 level → level 拒绝
  assert.equal(canDoActive(undefined, undefined).reason, "level");
  assert.equal(canDoActive({ type: "study" }, undefined).ok, true); // 上学无门槛
  assert.equal(canDoActive({ type: "study" }, undefined).msg, "~确定要学习吗？");
  assert.equal(canDoActive({ type: "work" }, okState({ studyValue: null })).ok, true);
  assert.equal(canDoActive({ type: "work", education: "bad" }, okState()).ok, true);
});
