/**
 * pathGuard 单元测试（node --test）
 * 覆盖：正常皮肤名、`..` 穿越、绝对路径覆盖、Windows 反斜杠、大小写差异、空值/非法值。
 * 运行：cd qq_local && node --test test/pathGuard.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const { SKIN_ASSETS_ROOT_REL, isInsideDir, resolveInsideDir } = require("../src/windows/util/pathGuard.js");

// 用真实的皮肤根目录做 root，保证测试贴近 preload 的实际调用形态
const ROOT = path.resolve(__dirname, "../src/windows/main", SKIN_ASSETS_ROOT_REL);

test("常量指向真实的 assets/ActionNew 目录", () => {
  assert.strictEqual(SKIN_ASSETS_ROOT_REL, "../../assets/ActionNew");
  assert.ok(ROOT.endsWith(path.join("src", "assets", "ActionNew")), `ROOT 解析异常: ${ROOT}`);
});

test("正常皮肤名通过，返回 root 下的绝对路径", () => {
  for (const skin of ["classic", "10200003", "10200004"]) {
    const got = resolveInsideDir(ROOT, [skin]);
    assert.strictEqual(got, path.join(ROOT, skin), `皮肤名被误拒: ${skin}`);
  }
  // 多段：皮肤名 + Config.xml 里的相对文件名
  assert.strictEqual(resolveInsideDir(ROOT, ["10200003", "001.swf"]), path.join(ROOT, "10200003", "001.swf"));
  assert.strictEqual(
    resolveInsideDir(ROOT, ["10200003", "main/stand/001.swf"]),
    path.join(ROOT, "10200003", "main", "stand", "001.swf")
  );
  // root 自身视为在界内
  assert.ok(isInsideDir(ROOT, ROOT));
  assert.ok(isInsideDir(ROOT, ROOT + path.sep));
});

test("`..` 穿越一律拒绝（含混在中段与多层）", () => {
  const evil = [
    "..",
    "../..",
    "../../../..",
    "../../../../../../Windows/win.ini",
    "10200003/../../../../etc/passwd",
    "./../../assets",
    "..\\..\\..\\..",
    "10200003\\..\\..\\..\\secret.txt",
  ];
  for (const s of evil) {
    assert.strictEqual(resolveInsideDir(ROOT, [s]), null, `穿越未被拦截: ${s}`);
  }
  // 第二段穿越（模拟恶意 Config.xml 的 path 属性）
  assert.strictEqual(resolveInsideDir(ROOT, ["10200003", "../../../../boot.ini"]), null, "第二段穿越未被拦截");
});

test("绝对路径片段会覆盖 root，必须被拒绝", () => {
  const abs =
    process.platform === "win32"
      ? ["C:\\Windows\\win.ini", "C:/Windows/System32/drivers/etc/hosts", "\\\\evil-host\\share\\x.txt"]
      : ["/etc/passwd", "/tmp"];
  for (const s of abs) {
    assert.strictEqual(resolveInsideDir(ROOT, [s]), null, `绝对路径未被拦截: ${s}`);
  }
});

test("Windows 反斜杠的合法相对路径仍然通过", () => {
  const got = resolveInsideDir(ROOT, ["10200003", "main\\stand\\001.swf"]);
  if (process.platform === "win32") {
    assert.strictEqual(got, path.join(ROOT, "10200003", "main", "stand", "001.swf"));
  } else {
    // 非 win32 上反斜杠是普通文件名字符，仍应落在 root 内（不越界即算通过）
    assert.ok(got !== null && got.startsWith(ROOT), `非 win32 下被误拒: ${got}`);
  }
});

test("大小写差异：不敏感模式放行，敏感模式拒绝", () => {
  const rootUpper = ROOT.replace(/ActionNew$/, "ACTIONNEW");
  const target = path.join(ROOT, "10200003");
  assert.ok(isInsideDir(rootUpper, target, { caseInsensitive: true }), "不敏感模式误拒了仅大小写不同的路径");
  assert.strictEqual(isInsideDir(rootUpper, target, { caseInsensitive: false }), false, "敏感模式应拒绝");
  // 显式不敏感时，皮肤名大小写变化不影响界内判定
  assert.ok(isInsideDir(ROOT, path.join(ROOT, "Classic"), { caseInsensitive: true }));
});

test("兄弟目录前缀混淆（ActionNewEvil）必须拒绝", () => {
  const sibling = ROOT + "Evil";
  assert.strictEqual(isInsideDir(ROOT, sibling), false, "同前缀兄弟目录被误判为界内");
  assert.strictEqual(isInsideDir(ROOT, path.join(sibling, "x.swf")), false, "同前缀兄弟目录子文件被误判为界内");
});

test("空值 / 非字符串 / NUL 字节一律拒绝", () => {
  for (const bad of [undefined, null, "", 0, 1, {}, [], true, "a\0b"]) {
    assert.strictEqual(resolveInsideDir(ROOT, [bad]), null, `非法输入未被拦截: ${String(bad)}`);
    assert.strictEqual(isInsideDir(ROOT, bad), false, `isInsideDir 非法输入未被拦截: ${String(bad)}`);
    assert.strictEqual(isInsideDir(bad, ROOT), false, `isInsideDir 非法 root 未被拦截: ${String(bad)}`);
  }
  assert.strictEqual(resolveInsideDir(ROOT, []), null, "空片段列表应拒绝");
  // 单个字符串也支持（非数组入参）
  assert.strictEqual(resolveInsideDir(ROOT, "10200003"), path.join(ROOT, "10200003"));
});
