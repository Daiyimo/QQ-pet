// pathGuard 的符号链接 / NTFS junction 复核测试。
//
// 修复的缺陷：原实现只做 path.resolve + 字符串前缀比较，`assets\ActionNew\evil -> C:\`
// 这类 junction 在词法上完全"界内"，于是 preload 的 newSkinReadConfig 可以把 root
// 之外的任意文件读出来、GB2312 解码后回传渲染层。
//
// Windows 上 fs.symlinkSync(..., "junction") 不需要管理员权限；文件符号链接需要，
// 因此那条用例在拿不到权限时 t.skip，绝不让 CI 变红。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isInsideDir,
  resolveInsideDir,
  realpathBestEffort,
} = require("../src/windows/util/pathGuard.js");

function withTempTree(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qqguard-link-"));
  const root = path.join(base, "ActionNew");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "10200003"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
  fs.writeFileSync(path.join(root, "10200003", "config.xml"), "<Config/>");
  try {
    return fn({ base, root, outside });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** 尝试建目录 junction/symlink；无权限或平台不支持时返回失败原因 */
function tryLinkDir(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `${e.code || e.message}` };
  }
}

function captureConsole(fn) {
  const errors = [];
  const orig = console.error;
  console.error = (...args) => errors.push(args.map((a) => String(a)).join(" "));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return errors;
}

test("目录 junction 指向 root 之外：必须拒绝（修复前会放行）", (t) => {
  withTempTree(({ root, outside }) => {
    const link = path.join(root, "evil");
    const linked = tryLinkDir(outside, link);
    if (!linked.ok) {
      t.skip(`当前环境无法创建目录链接（${linked.reason}），跳过`);
      return;
    }

    // 前提确认：词法上它确实"在界内"——这正是修复前被放行的原因
    const lexical = path.resolve(root, "evil", "secret.txt");
    assert.equal(isInsideDir(root, lexical), true, "词法校验挡不住 junction（故需 realpath 复核）");
    assert.equal(
      resolveInsideDir(root, ["evil", "secret.txt"], { followSymlinks: false }),
      lexical,
      "关掉链接复核时应保持旧的纯词法语义"
    );

    // 修复后：realpath 复核必须拒绝，并留下可排查的日志
    let got = "unset";
    const errors = captureConsole(() => {
      got = resolveInsideDir(root, ["evil", "secret.txt"]);
    });
    assert.equal(got, null, "junction 越界必须被拒绝");
    assert.ok(
      errors.some((m) => m.includes("符号链接/junction 解析后越出白名单根目录")),
      "拒绝必须留日志（调用方按拒绝处理并可排查）"
    );

    // 链接本身作为单段片段也要拒绝
    let alone = "unset";
    captureConsole(() => {
      alone = resolveInsideDir(root, ["evil"]);
    });
    assert.equal(alone, null, "指向外部的链接目录本身也应拒绝");
  });
});

test("root 自身通过 junction 访问时：其下合法路径不得被误拒", (t) => {
  withTempTree(({ base, root }) => {
    const rootLink = path.join(base, "ActionNewLink");
    const linked = tryLinkDir(root, rootLink);
    if (!linked.ok) {
      t.skip(`当前环境无法创建目录链接（${linked.reason}），跳过`);
      return;
    }
    // root 与 target 一起 realpath，包含关系仍成立 → 必须放行（防误杀）
    const got = resolveInsideDir(rootLink, ["10200003", "config.xml"]);
    assert.equal(got, path.resolve(rootLink, "10200003", "config.xml"));
    assert.ok(fs.existsSync(got), "返回的路径应当真实可读");
  });
});

test("root 内部指向 root 内部的链接：仍然放行", (t) => {
  withTempTree(({ root }) => {
    const link = path.join(root, "alias");
    const linked = tryLinkDir(path.join(root, "10200003"), link);
    if (!linked.ok) {
      t.skip(`当前环境无法创建目录链接（${linked.reason}），跳过`);
      return;
    }
    assert.equal(
      resolveInsideDir(root, ["alias", "config.xml"]),
      path.resolve(root, "alias", "config.xml"),
      "界内链接不应被误拒"
    );
  });
});

test("无链接的普通路径：行为与修复前一致（存在与不存在的都放行）", () => {
  withTempTree(({ root }) => {
    assert.equal(
      resolveInsideDir(root, ["10200003", "config.xml"]),
      path.resolve(root, "10200003", "config.xml")
    );
    // 皮肤包缺文件是常态：目标不存在也必须放行（由调用方 existsSync 判定）
    assert.equal(
      resolveInsideDir(root, ["10200003", "main", "stand", "001.swf"]),
      path.resolve(root, "10200003", "main", "stand", "001.swf")
    );
    // 越界仍然拒绝
    assert.equal(resolveInsideDir(root, ["..", "outside", "secret.txt"]), null);
  });
});

test("realpathBestEffort：不存在的深层路径回退到最近存在的祖先后再拼回", () => {
  withTempTree(({ root }) => {
    const deep = path.join(root, "10200003", "nope", "still-nope", "x.swf");
    const real = realpathBestEffort(deep);
    assert.equal(path.basename(real), "x.swf");
    assert.ok(
      real.toLowerCase().startsWith(fs.realpathSync.native(root).toLowerCase()),
      `回退结果应仍在 root 之下: ${real}`
    );
    // 纯不存在的绝对路径不应抛异常
    assert.equal(
      typeof realpathBestEffort(path.join(root, "a", "b", "c")),
      "string"
    );
  });
});
