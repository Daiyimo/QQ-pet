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

// —— 平台无关的兜底防线（不碰真实文件系统，绝不会被 skip）——
//
// 为什么必须有这一组：下面那三条真实 junction 用例依赖"能否创建链接"的 FS 权限
// （非管理员的某些 Windows 配置 / CI 容器 / 非 Windows 平台都可能建不出来），
// 建不出来就只能 t.skip —— 而套件依然全绿，于是"junction 越权读任意文件"这条
// 安全保证在该环境里一条防线都不剩。注入假 realpath 把该保证与 FS 权限解耦：
// 只要 realpath 的结果越出 root，resolveInsideDir 就必须返回 null。
const FAKE_ROOT = path.join(path.sep === "\\" ? "C:\\" : "/", "app", "assets", "ActionNew");

test("[平台无关] realpath 把 target 解析到 root 之外 → 必须拒绝", () => {
  const outside = path.join(path.sep === "\\" ? "C:\\" : "/", "Windows", "win.ini");
  const calls = [];
  const fakeRealpath = (p) => {
    calls.push(p);
    // root 原样返回；target 解析为 root 之外（等价于 evil 是指向外部的 junction）
    return p === FAKE_ROOT ? FAKE_ROOT : outside;
  };
  const errors = captureConsole(() => {
    assert.equal(
      resolveInsideDir(FAKE_ROOT, ["evil", "secret.txt"], { realpath: fakeRealpath }),
      null,
      "realpath 结果越界时必须拒绝（这条是 junction 越权读文件的唯一平台无关防线）"
    );
  });
  assert.equal(calls.length, 2, "root 与 target 都必须过一遍 realpath");
  assert.equal(calls[0], FAKE_ROOT);
  assert.equal(calls[1], path.join(FAKE_ROOT, "evil", "secret.txt"));
  assert.ok(
    errors.some((m) => m.includes("符号链接/junction 解析后越出白名单根目录")),
    "拒绝必须留日志"
  );
});

test("[平台无关] realpath 把 root 解析到别处（root 被链接劫持）→ 必须拒绝", () => {
  const elsewhere = path.join(path.sep === "\\" ? "C:\\" : "/", "somewhere-else");
  const fakeRealpath = (p) => (p === FAKE_ROOT ? elsewhere : p);
  captureConsole(() => {
    assert.equal(
      resolveInsideDir(FAKE_ROOT, ["10200003", "config.xml"], { realpath: fakeRealpath }),
      null
    );
  });
});

test("[平台无关] 兄弟前缀混淆在 realpath 层同样被挡（ActionNewEvil）", () => {
  const fakeRealpath = (p) => (p === FAKE_ROOT ? FAKE_ROOT : FAKE_ROOT + "Evil" + path.sep + "x.swf");
  captureConsole(() => {
    assert.equal(resolveInsideDir(FAKE_ROOT, ["x.swf"], { realpath: fakeRealpath }), null);
  });
});

test("[平台无关] realpath 结果仍在 root 内 → 放行，且返回词法路径而非 realpath 结果", () => {
  // 反向对照：证明上面几条的 null 是"越界判定"的结果，而不是注入 realpath 就一律拒绝
  const realish = path.join(path.sep === "\\" ? "C:\\" : "/", "real", "ActionNew");
  const fakeRealpath = (p) => p.replace(FAKE_ROOT, realish);
  const expected = path.join(FAKE_ROOT, "10200003", "main", "stand", "001.swf");
  const errors = captureConsole(() => {
    assert.equal(
      resolveInsideDir(FAKE_ROOT, ["10200003", "main/stand/001.swf"], { realpath: fakeRealpath }),
      expected,
      "界内必须放行，且返回的是未解析链接的词法路径（调用方拿它去 fs 读取）"
    );
  });
  assert.deepEqual(errors, [], "放行路径不应有拒绝日志");
});

test("[平台无关] realpath 抛错或返回非字符串 → fail-closed 拒绝，不得放行", () => {
  const throwing = () => {
    throw Object.assign(new Error("EACCES: permission denied, realpath"), { code: "EACCES" });
  };
  const errors = captureConsole(() => {
    assert.equal(
      resolveInsideDir(FAKE_ROOT, ["10200003"], { realpath: throwing }),
      null,
      "复核拿不到结论时必须拒绝（fail-open 等于没有校验）"
    );
  });
  assert.ok(
    errors.some((m) => m.includes("realpath 复核过程异常") && m.includes("at ")),
    "异常必须带完整堆栈落日志"
  );

  for (const bad of [undefined, null, 123, {}, ""]) {
    captureConsole(() => {
      assert.equal(
        resolveInsideDir(FAKE_ROOT, ["10200003"], { realpath: () => bad }),
        null,
        `realpath 返回 ${JSON.stringify(bad)} 时必须拒绝`
      );
    });
  }
});

test("[平台无关] 生产默认不受注入影响：不传 realpath 时走真实实现", () => {
  // 真实 realpath 下，仓库内真实存在的皮肤目录必须放行（防止注入点把默认行为改坏）
  const realRoot = path.resolve(__dirname, "../src/assets/ActionNew");
  assert.equal(
    resolveInsideDir(realRoot, ["10200003"]),
    path.join(realRoot, "10200003"),
    "默认路径必须仍用真实 fs.realpathSync.native 且放行界内路径"
  );
  assert.equal(resolveInsideDir(realRoot, ["..", "Action"]), null, "默认路径仍必须挡住越界");
});

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
