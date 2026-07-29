// llm/providers.js 安全相关单元测试：apiKey 加解密往返、safeStorage 不可用时拒绝明文落盘、
// 旧版明文键一次性迁移（含幂等）、解密失败的可观测降级。
// safeStorage 与 sys 存储全部注入，纯 node 下可跑（不需要 Electron）。
const test = require("node:test");
const assert = require("node:assert/strict");

const providers = require("../src/service/llm/providers.js");

// ---- 测试脚手架 ----

// 假 safeStorage：可用性、加/解密抛错均可控。
// 密文格式 base64("SS:" + 明文)，保证「密文里看不到明文」且可逆。
function makeSafeStorage(opt = {}) {
  return {
    isEncryptionAvailable: () => opt.available !== false,
    encryptString(plain) {
      if (opt.encryptThrows) throw new Error("encryptString boom");
      return Buffer.from("SS:" + plain, "utf8");
    },
    decryptString(buf) {
      if (opt.decryptThrows) throw new Error("decryptString boom");
      const s = buf.toString("utf8");
      if (!s.startsWith("SS:")) throw new Error("密文格式不对");
      return s.slice(3);
    },
  };
}

// 假 sys 存储：模拟 src/ini/pet.js 的 getSys/setSys（getSys 对空值返回 undefined，
// setSys 签名是 {name, value}）
function installSys(initial = {}) {
  const store = { ...initial };
  global.getSys = (k) => (k ? store[k] || undefined : store);
  global.setSys = ({ name, value }) => {
    store[name] = value;
  };
  return store;
}

// 收集 console.error / console.log，避免污染测试输出，同时断言"有日志"
function captureConsole() {
  const origError = console.error;
  const origLog = console.log;
  const errors = [];
  const logs = [];
  console.error = (...args) => errors.push(args.map(String).join(" "));
  console.log = (...args) => logs.push(args.map(String).join(" "));
  return {
    errors,
    logs,
    restore() {
      console.error = origError;
      console.log = origLog;
    },
  };
}

// 每个用例自己装配环境：safeStorage 桩 + sys 桩 + 迁移标记复位
function setup(opt = {}) {
  const ss = opt.noSafeStorage ? null : makeSafeStorage(opt);
  providers.__setSafeStorageStub(ss);
  providers.__resetLegacyMigrateFlag();
  const store = installSys(opt.sys || {});
  const cap = captureConsole();
  return { ss, store, cap };
}

function teardown(cap) {
  cap.restore();
  providers.__setSafeStorageStub(null);
  providers.__resetLegacyMigrateFlag();
}

// —— encryptApiKey / decryptApiKey ——

test("encryptApiKey/decryptApiKey：safeStorage 可用时往返一致，落盘带 enc: 前缀", () => {
  const { cap } = setup();
  try {
    const stored = providers.encryptApiKey("sk-round-trip-1234");
    assert.ok(stored.startsWith(providers.ENC_PREFIX));
    assert.ok(!stored.includes("sk-round-trip-1234")); // 落盘串里不含明文
    assert.equal(providers.decryptApiKey(stored), "sk-round-trip-1234");
    assert.deepEqual(cap.errors, []);
  } finally {
    teardown(cap);
  }
});

test("encryptApiKey：空值返回空串，已加密的不重复加密", () => {
  const { cap } = setup();
  try {
    assert.equal(providers.encryptApiKey(""), "");
    assert.equal(providers.encryptApiKey(null), "");
    const once = providers.encryptApiKey("sk-abc");
    assert.equal(providers.encryptApiKey(once), once);
  } finally {
    teardown(cap);
  }
});

test("encryptApiKey：safeStorage 不可用时绝不返回明文，返回失败信号并记错误日志", () => {
  const { cap } = setup({ available: false });
  try {
    const out = providers.encryptApiKey("sk-must-not-leak");
    assert.equal(out, providers.ENCRYPT_FAILED);
    assert.ok(providers.isEncryptFailed(out));
    assert.ok(!out.includes("sk-must-not-leak"));
    assert.equal(cap.errors.length, 1);
    assert.match(cap.errors[0], /safeStorage 不可用/);
  } finally {
    teardown(cap);
  }
});

test("encryptApiKey：完全没有 safeStorage（纯 node）时同样返回失败信号", () => {
  const { cap } = setup({ noSafeStorage: true });
  try {
    // 注入 null 后走真实 getSafeStorage：纯 node 下 require("electron") 没有 safeStorage
    const out = providers.encryptApiKey("sk-no-electron");
    assert.equal(out, providers.ENCRYPT_FAILED);
    assert.ok(cap.errors.length >= 1);
  } finally {
    teardown(cap);
  }
});

test("encryptApiKey：encryptString 抛错时返回失败信号并记完整错误", () => {
  const { cap } = setup({ encryptThrows: true });
  try {
    assert.equal(providers.encryptApiKey("sk-boom"), providers.ENCRYPT_FAILED);
    assert.equal(cap.errors.length, 1);
    assert.match(cap.errors[0], /加密失败/);
    assert.match(cap.errors[0], /encryptString boom/);
  } finally {
    teardown(cap);
  }
});

test("decryptApiKey：解密抛错时降级为空串并记错误日志", () => {
  const { cap } = setup();
  try {
    const stored = providers.encryptApiKey("sk-will-fail");
    providers.__setSafeStorageStub(makeSafeStorage({ decryptThrows: true }));
    assert.equal(providers.decryptApiKey(stored), "");
    assert.equal(cap.errors.length, 1);
    assert.match(cap.errors[0], /解密失败/);
    assert.match(cap.errors[0], /decryptString boom/);
  } finally {
    teardown(cap);
  }
});

test("decryptApiKey：safeStorage 不可用时无法解密密文，返回空串并记日志", () => {
  const { cap } = setup();
  try {
    const stored = providers.encryptApiKey("sk-locked");
    providers.__setSafeStorageStub(makeSafeStorage({ available: false }));
    assert.equal(providers.decryptApiKey(stored), "");
    assert.match(cap.errors.join("\n"), /无法解密/);
  } finally {
    teardown(cap);
  }
});

test("decryptApiKey：读到加密失败标记时返回空串并记日志", () => {
  const { cap } = setup();
  try {
    assert.equal(providers.decryptApiKey(providers.ENCRYPT_FAILED), "");
    assert.match(cap.errors.join("\n"), /从未成功保存/);
  } finally {
    teardown(cap);
  }
});

test("decryptApiKey：未迁移的旧明文原样返回（兼容旧数据）", () => {
  const { cap } = setup();
  try {
    assert.equal(providers.decryptApiKey("sk-old-plain"), "sk-old-plain");
    assert.equal(providers.decryptApiKey(""), "");
  } finally {
    teardown(cap);
  }
});

// —— saveProviders ——

test("saveProviders：正常保存后 sys 中只有密文", () => {
  const { store, cap } = setup();
  try {
    const r = providers.saveProviders([
      { id: "default", type: "anthropic", baseUrl: "https://x/v1", apiKey: "sk-secret", model: "m" },
    ]);
    assert.equal(r.ok, true);
    assert.ok(store.llmProviders[0].apiKey.startsWith(providers.ENC_PREFIX));
    assert.ok(!JSON.stringify(store).includes("sk-secret"));
    assert.equal(providers.getProvider("default").apiKey, "sk-secret");
  } finally {
    teardown(cap);
  }
});

test("saveProviders：safeStorage 不可用时整体放弃写入，明文不落盘且返回失败", () => {
  const { store, cap } = setup({ available: false });
  try {
    const r = providers.saveProviders([
      { id: "default", type: "openai", baseUrl: "https://x/v1", apiKey: "sk-plain-leak", model: "m" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error, /无法加密保存/);
    assert.equal(store.llmProviders, undefined); // 一个字节都没写
    assert.ok(!JSON.stringify(store).includes("sk-plain-leak"));
    assert.ok(cap.errors.length >= 1);
  } finally {
    teardown(cap);
  }
});

// —— 旧版明文键迁移 ——

test("migrateLegacyApiKey：明文 llmApiKey 迁移为加密 provider 并清除明文键", () => {
  const { store, cap } = setup({
    sys: { llmApiKey: "sk-legacy-plain", llmModel: "deepseek-chat" },
  });
  try {
    const r = providers.migrateLegacyApiKey();
    assert.equal(r.migrated, true);
    assert.equal(r.providerId, "legacy-deepseek");
    // 明文键被清空
    assert.ok(!store.llmApiKey);
    assert.ok(!JSON.stringify(store).includes("sk-legacy-plain"));
    // 加密条目写入 + 生效提供商指向它
    const entry = store.llmProviders.find((p) => p.id === "legacy-deepseek");
    assert.ok(entry.apiKey.startsWith(providers.ENC_PREFIX));
    assert.equal(entry.baseUrl, "https://api.deepseek.com/v1");
    assert.equal(entry.model, "deepseek-chat");
    assert.equal(store.llmActiveProvider, "legacy-deepseek");
    // 迁移后仍能正常取到 key
    assert.equal(providers.getChatProvider().apiKey, "sk-legacy-plain");
  } finally {
    teardown(cap);
  }
});

test("migrateLegacyApiKey：重复执行幂等（不重复追加条目、不改动已有配置）", () => {
  const { store, cap } = setup({ sys: { llmApiKey: "sk-legacy-plain" } });
  try {
    providers.migrateLegacyApiKey();
    const snapshot = JSON.stringify(store);
    const second = providers.migrateLegacyApiKey();
    const third = providers.migrateLegacyApiKey();
    assert.equal(second.migrated, false);
    assert.equal(second.reason, "no-legacy");
    assert.equal(third.reason, "no-legacy");
    assert.equal(JSON.stringify(store), snapshot);
    assert.equal(store.llmProviders.length, 1);
  } finally {
    teardown(cap);
  }
});

test("migrateLegacyApiKey：已有生效提供商时不抢占 llmActiveProvider", () => {
  const { store, cap } = setup({
    sys: {
      llmApiKey: "sk-legacy-plain",
      llmActiveProvider: "default",
      llmProviders: [{ id: "default", type: "openai", baseUrl: "https://x/v1", apiKey: "enc:zzz", model: "m" }],
    },
  });
  try {
    assert.equal(providers.migrateLegacyApiKey().migrated, true);
    assert.equal(store.llmActiveProvider, "default");
    assert.equal(store.llmProviders.length, 2);
  } finally {
    teardown(cap);
  }
});

test("migrateLegacyApiKey：safeStorage 不可用时不清明文，留待下次重试", () => {
  const { store, cap } = setup({ available: false, sys: { llmApiKey: "sk-legacy-plain" } });
  try {
    const r = providers.migrateLegacyApiKey();
    assert.equal(r.migrated, false);
    assert.equal(r.reason, "encrypt-unavailable");
    assert.equal(store.llmApiKey, "sk-legacy-plain"); // 没被清掉，用户配置不丢
    assert.equal(store.llmProviders, undefined);
    assert.ok(cap.errors.length >= 1);
    // 恢复凭据服务后重试可成功（幂等 + 可重试）
    providers.__setSafeStorageStub(makeSafeStorage());
    assert.equal(providers.migrateLegacyApiKey().migrated, true);
    assert.ok(!store.llmApiKey);
  } finally {
    teardown(cap);
  }
});

test("migrateLegacyApiKey：没有 legacy 明文键时什么都不做", () => {
  const { store, cap } = setup();
  try {
    assert.equal(providers.migrateLegacyApiKey().reason, "no-legacy");
    assert.deepEqual(Object.keys(store), []);
  } finally {
    teardown(cap);
  }
});

test("migrateLegacyApiKey：llmApiKey 已是密文时不重复迁移，只清废弃键", () => {
  const { store, cap } = setup({ sys: { llmApiKey: providers.ENC_PREFIX + "abc" } });
  try {
    const r = providers.migrateLegacyApiKey();
    assert.equal(r.migrated, false);
    assert.equal(r.reason, "not-plaintext");
    assert.ok(!store.llmApiKey);
    assert.equal(store.llmProviders, undefined);
  } finally {
    teardown(cap);
  }
});

// —— 统一读取入口 ——

test("getChatProvider：首次读取自动触发迁移，旧配置无缝可用", () => {
  const { store, cap } = setup({ sys: { llmApiKey: "sk-lazy-migrate", llmModel: "deepseek-chat" } });
  try {
    const cfg = providers.getChatProvider();
    assert.equal(cfg.id, "legacy-deepseek");
    assert.equal(cfg.apiKey, "sk-lazy-migrate");
    assert.ok(!store.llmApiKey);
    assert.equal(providers.hasChatProvider(), true);
  } finally {
    teardown(cap);
  }
});

test("hasChatProvider：未配置或 key 不可解密时为 false", () => {
  const { cap } = setup();
  try {
    assert.equal(providers.hasChatProvider(), false);
    installSys({
      llmActiveProvider: "default",
      llmProviders: [
        { id: "default", type: "openai", baseUrl: "https://x/v1", apiKey: providers.ENCRYPT_FAILED, model: "m" },
      ],
    });
    assert.equal(providers.hasChatProvider(), false);
  } finally {
    teardown(cap);
  }
});
