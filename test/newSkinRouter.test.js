/**
 * newSkinRouter 单元测试（node --test）
 * 覆盖：Config.xml 解析、GB2312 解码、概率加权、缺失文件过滤、动作名映射与回退链。
 * 运行：cd qq_local && node --test test/newSkinRouter.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");
const { NewSkinRouter } = require("../src/windows/util/pet/newSkinRouter.js");

const SKINS_DIR = path.join(__dirname, "../src/assets/ActionNew");

function loadSkin(skin) {
  const dir = path.join(SKINS_DIR, skin);
  const xmlText = iconv.decode(fs.readFileSync(path.join(dir, "config.xml")), "gb2312");
  return new NewSkinRouter({
    skin,
    basePath: `../../assets/ActionNew/${skin}`,
    xmlText,
    exists: (rel) => fs.existsSync(path.join(dir, rel)),
  });
}

test("GB2312 解码 + Config.xml 解析出六个分组", () => {
  const r = loadSkin("10200003");
  for (const g of ["stand", "motion", "play", "walk", "turn", "lead"]) {
    assert.ok(Array.isArray(r.groups[g]), `缺少分组 ${g}`);
    assert.ok(r.groups[g].length > 0, `分组 ${g} 为空`);
  }
  // 中文 name 字段正确解码（GB2312）：stand/normal 的 name 属性为中文
  const stand = r.groups.stand.find((a) => a.path === "001.swf");
  assert.ok(stand, "stand 组缺少 001.swf");
  assert.strictEqual(stand.name, "在壳里跳");
  // motion 组 trigger 属性解析
  assert.ok(r.groups.motion.some((a) => a.trigger === "drag"), "motion 组缺少 drag trigger");
  assert.ok(r.groups.motion.some((a) => a.trigger === "hitLeft"), "motion 组缺少 hitLeft trigger");
});

test("概率加权：随机值落在各权重区间时选中对应项，probability=0 永不命中", () => {
  // 原实现用真 Math.random 做 2000 次采样并断言「低权重项至少命中一次」，
  // 但 low 的单次命中概率仅 1/1000，全不中的概率为 0.999^2000 ≈ 13.5% —— 约每 7 次跑
  // 就会假失败。改为注入确定性随机源，直接覆盖权重区间边界，断言比统计写法更强。
  const xml = `<Config><Package name="main"><Package name="play">
    <Action probability="0" path="zero.swf">零</Action>
    <Action probability="1" path="low.swf">低</Action>
    <Action probability="999" path="high.swf">高</Action>
  </Package></Package></Config>`;

  // probability=0 的项在选取前即被过滤，剩余 total=1000：
  // rng()*1000 落在 (0,1] 选 low，落在 (1,1000] 选 high
  const pickWith = (value) => {
    const r = new NewSkinRouter({
      skin: "t", basePath: "b", xmlText: xml,
      exists: () => true, rng: () => value,
    });
    return path.basename(r.pickSwf("play"));
  };

  for (const v of [0, 0.0005, 0.001]) {
    assert.strictEqual(pickWith(v), "low.swf", `rng=${v} 应落在低权重区间`);
  }
  for (const v of [0.0011, 0.002, 0.5, 0.9999, 1]) {
    assert.strictEqual(pickWith(v), "high.swf", `rng=${v} 应落在高权重区间`);
  }
  // probability=0 的项在任何随机值下都不可被选中
  for (let i = 0; i <= 100; i++) {
    assert.notStrictEqual(pickWith(i / 100), "zero.swf", `rng=${i / 100} 命中了 probability=0 的项`);
  }
});

test("缺失文件过滤：不存在的 SWF 不会被选中", () => {
  const xml = `<Config><Package name="main"><Package name="play">
    <Action probability="50" path="gone.swf">缺</Action>
    <Action probability="50" path="here.swf">在</Action>
  </Package></Package></Config>`;
  const r = new NewSkinRouter({
    skin: "t", basePath: "b", xmlText: xml,
    exists: (rel) => rel.endsWith("here.swf"),
  });
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(r.pickSwf("play"), "main/play/here.swf");
  }
});

test("真实素材：pickSwf 只返回磁盘上存在的文件", () => {
  for (const skin of ["10200003", "10200004"]) {
    const r = loadSkin(skin);
    const dir = path.join(SKINS_DIR, skin);
    for (const g of ["stand", "play", "motion", "walk", "turn", "lead"]) {
      for (let i = 0; i < 20; i++) {
        const rel = r.pickSwf(g);
        if (rel === null) continue; // 该组素材全缺失是允许的
        assert.ok(fs.existsSync(path.join(dir, rel)), `${skin}/${g} 返回了不存在的 ${rel}`);
      }
    }
  }
});

test("映射：normal/speak→stand，play→play，walk/turn/lead→同名组", () => {
  const r = loadSkin("10200003");
  for (const [name, prefix] of [
    ["normal", "main/stand/normal/"],
    ["speak", "main/stand/normal/"],
    ["play", "main/play/"],
    ["walk", "main/walk/"],
    ["turn", "main/turn/"],
    ["lead", "main/lead/"],
  ]) {
    const res = r.resolve(name);
    assert.ok(res.src && res.rel.startsWith(prefix), `${name} 映射错误: ${res.rel}`);
    assert.strictEqual(res.name, name);
    assert.ok(res.src.startsWith("../../assets/ActionNew/10200003/"), "src 前缀错误");
  }
});

test("映射：无新版动画的动作名回退 play 组", () => {
  const r = loadSkin("10200003");
  for (const name of ["enter", "exit", "eat", "clean", "sick", "cure", "game", "levUp",
    "dying", "die", "revival", "bury", "first", "etoj", "jtoc", "changeState", "appear", "hide"]) {
    const res = r.resolve(name);
    assert.ok(res.src, `${name} 无回退结果`);
    assert.ok(res.rel.startsWith("main/play/"), `${name} 未回退到 play 组: ${res.rel}`);
  }
});

test("贴边：10200003 hide 命中 motion 组 hide 文件；10200004 缺失回退 stand", () => {
  const r3 = loadSkin("10200003");
  assert.ok(/hide_left/.test(r3.resolve("hideleft").rel), "hideleft 未命中 hide_left 文件");
  assert.ok(/hide_right/.test(r3.resolve("hideright").rel), "hideright 未命中 hide_right 文件");
  const r4 = loadSkin("10200004");
  for (const name of ["hideleft", "hideright"]) {
    const res = r4.resolve(name);
    assert.ok(res.rel.startsWith("main/stand/normal/"), `10200004 ${name} 未回退 stand: ${res.rel}`);
  }
  // drag：两个皮肤都有 drag 文件
  for (const r of [r3, r4]) {
    const res = r.resolve("drag");
    assert.ok(/^main\/stand\/motion\/drag/.test(res.rel), `drag 映射错误: ${res.rel}`);
  }
});

test("Config 引用但磁盘缺失的文件在 resolve 中同样被过滤（10200004 motion）", () => {
  // 10200004 的 config.xml 引用 mouseDown 001~025.swf，但磁盘只有 drag 文件
  const r4 = loadSkin("10200004");
  for (let i = 0; i < 50; i++) {
    const rel = r4.pickSwf("motion");
    if (rel === null) break;
    assert.ok(/^drag/.test(path.basename(rel)), `10200004 motion 返回了不存在的 ${rel}`);
  }
});

test("素材全缺时 resolve 回退老路由（src 为 null）", () => {
  const xml = `<Config><Package name="main"><Package name="play">
    <Action probability="50" path="gone.swf">缺</Action></Package></Package></Config>`;
  const r = new NewSkinRouter({ skin: "t", basePath: "b", xmlText: xml, exists: () => false });
  const res = r.resolve("play");
  assert.strictEqual(res.src, null);
  assert.strictEqual(res.rel, null);
  assert.strictEqual(res.name, "play");
});
