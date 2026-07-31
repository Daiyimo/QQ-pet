/**
 * store 左栏储物柜（背包）分页缓存回归测试。
 *
 * 修复背景：mounted 里为了填 bgNameMap 会额外拉一大页背景（pageSize 20），
 * 该回包原先被无条件写进 bagCache["bagZB_background"]。用户点「装扮」时命中该缓存，
 * 于是 20 个背景被塞进官方 2x3（每页 6 件）网格，且 bagTotal 按 20/页算成 1 页，
 * 导致翻页按钮因 `page > bagTotal` 被拒、完全点不动。
 *
 * store/index.js 是浏览器端 IIFE（依赖 window / Vue 全局），这里用 node:vm 建沙箱
 * 加载真实源码，取出真实的 Vue 选项对象与纯函数来驱动，不做源码文本断言。
 * 注意：沙箱内的代码闭包引用的是沙箱自己的 window，因此打桩必须写到 sandbox.window 上。
 * 不依赖任何三方包。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/* 被测源码路径。可用 QQ_STORE_SRC 覆盖，专为"变异测试/回滚验证"准备：
   把 store/index.js 的缓存逻辑回滚到修复前写进临时文件，再
   `QQ_STORE_SRC=<临时文件> node --test test/storeBagCache.test.js`，
   即可验证这些用例真的会失败——无需改动仓库里的 src/。 */
const SRC = process.env.QQ_STORE_SRC
  || path.join(__dirname, "../src/windows/popups/store/index.js");

/**
 * 在沙箱里加载 store/index.js。
 * Vue 被打桩成不真正挂载，因此 mounted() 不会被自动调用，可由测试显式驱动。
 */
function loadStoreModule() {
  const sandbox = {
    console,
    window: { addEventListener() {} },
    Vue: { createApp: () => ({ mount() {} }) },
  };
  vm.runInNewContext(fs.readFileSync(SRC, "utf8"), sandbox, { filename: SRC });
  const exposed = sandbox.window.__storeTest;
  assert.ok(exposed, "store/index.js 应通过 window.__storeTest 暴露测试入口");
  return { exposed, sandbox };
}

/**
 * 用真实的 data()/computed/methods 组装一个可直接调用方法的实例替身。
 * computed 装成 getter，methods 绑到同一对象上，语义与 Vue 选项 API 一致。
 *
 * ⚠️ 这是**手工重实现的 Vue 选项 API 子集**，只支持 data / computed / methods：
 *   - 不支持 watch，不支持响应式（无依赖追踪、无 nextTick、无更新时序）；
 *   - 也不做 props / provide / 生命周期顺序。
 * 目前被测的都是纯 methods 与 mounted 里注册的纯回调，所以够用。
 * 一旦 store/index.js 开始依赖 watch 或响应式更新顺序，这个替身会**静默偏离**真实 Vue
 * （测试照绿但线上行为不同）——那时请换成真 Vue（引入 vue.global.js 或装 vue 依赖），
 * 不要继续往这个替身里加功能。
 */
function makeVm(appOptions, overrides = {}) {
  const inst = appOptions.data();
  for (const [key, getter] of Object.entries(appOptions.computed || {})) {
    Object.defineProperty(inst, key, { get: getter, configurable: true });
  }
  for (const [key, fn] of Object.entries(appOptions.methods || {})) {
    inst[key] = fn.bind(inst);
  }
  Object.assign(inst, overrides);
  return inst;
}

/**
 * 给沙箱装上 electronAPI 打桩：
 * - store_h_* 请求类通道把入参收集到 requests
 * - store_m_* 订阅类通道把回调存进 handlers 供测试触发
 */
function stubApi(sandbox) {
  const requests = [];
  const handlers = {};
  sandbox.window.electronAPI = new Proxy(
    {},
    {
      get(_target, prop) {
        const name = String(prop);
        if (name.startsWith("store_m_")) {
          return (cb) => {
            handlers[name] = cb;
          };
        }
        return (payload) => {
          requests.push({ channel: name, ...payload });
        };
      },
    },
  );
  return { requests, handlers };
}

/** 造一个"每页 20 件"的背景回包（即 bgNameMap 预拉取的形状） */
function prefetchPayload(itemCount) {
  return {
    type: "background",
    result: Array.from({ length: itemCount }, (_, i) => ({
      keyName: "_b" + i,
      name: "背景" + i,
      type: "background",
      num: 1,
    })),
    total: 1, // 20 件按 20/页 → 只有 1 页
    current: 1,
    pageSize: 20,
  };
}

/** 造一页 6 件的正常背景回包 */
function normalPage(current, total, count = 6) {
  return {
    type: "background",
    result: Array.from({ length: count }, (_, i) => ({
      keyName: "_p" + current + "_" + i,
      name: "背景" + i,
      type: "background",
      num: 1,
    })),
    total,
    current,
    pageSize: 6,
  };
}

/** 只取背包列表请求（过滤掉 mounted 里的商城列表/bus 请求） */
function bagRequests(requests) {
  return requests.filter((r) => r.channel === "store_h_listBag");
}

// ---------------------------------------------------------------- 纯函数层

test("isUsableBagPayload 拒绝页大小与本窗 2x3 网格不一致的回包", () => {
  const { exposed } = loadStoreModule();
  const { isUsableBagPayload, BAG_PAGE_SIZE } = exposed;
  assert.equal(BAG_PAGE_SIZE, 6, "背包网格恒为每页 6 件");
  assert.equal(
    isUsableBagPayload(prefetchPayload(20), 1, BAG_PAGE_SIZE),
    false,
    "20/页的预拉取回包不可当作第 1 页渲染",
  );
});

test("isUsableBagPayload 接受页大小与页码都匹配的回包", () => {
  const { exposed } = loadStoreModule();
  const { isUsableBagPayload, BAG_PAGE_SIZE } = exposed;
  assert.equal(isUsableBagPayload(normalPage(2, 3), 2, BAG_PAGE_SIZE), true);
});

test("isUsableBagPayload 拒绝页码不符、错误回包与缺 result 的回包", () => {
  const { exposed } = loadStoreModule();
  const { isUsableBagPayload, BAG_PAGE_SIZE } = exposed;
  assert.equal(
    isUsableBagPayload(normalPage(3, 5), 1, BAG_PAGE_SIZE),
    false,
    "页码不符应重新请求",
  );
  assert.equal(
    isUsableBagPayload({ error: "boom", result: [], current: 1, pageSize: 6 }, 1, BAG_PAGE_SIZE),
    false,
    "错误回包不可渲染",
  );
  assert.equal(
    isUsableBagPayload({ current: 1, pageSize: 6 }, 1, BAG_PAGE_SIZE),
    false,
    "缺 result 数组不可渲染",
  );
  assert.equal(isUsableBagPayload(null, 1, BAG_PAGE_SIZE), false);
});

// ---------------------------------------------------------------- 行为层

test("loadBagPage 遇到 20/页的污染缓存时重新请求整页，而不是把 20 件铺进 2x3 网格", () => {
  const { exposed, sandbox } = loadStoreModule();
  const { requests } = stubApi(sandbox);
  const inst = makeVm(exposed.appOptions, {
    activeBagMall: "bagZB",
    activeBagTab: "background",
    bagCache: { bagZB_background: prefetchPayload(20) },
  });

  inst.loadBagPage(1);

  assert.equal(inst.bagItems.length, 0, "污染缓存不得上屏");
  const reqs = bagRequests(requests);
  assert.equal(reqs.length, 1, "应重新向主进程请求一页");
  assert.equal(reqs[0].pageSize, 6, "重新请求必须用 6/页");
  assert.equal(reqs[0].current, 1);
  assert.equal(reqs[0].type, "background");
  assert.equal(inst.bagLoading, true, "进入加载态");
});

test("loadBagPage 命中 6/页的正常缓存时直接展示且不再请求", () => {
  const { exposed, sandbox } = loadStoreModule();
  const { requests } = stubApi(sandbox);
  const inst = makeVm(exposed.appOptions, {
    activeBagMall: "bagZB",
    activeBagTab: "background",
    bagCache: { bagZB_background: normalPage(2, 4, 1) },
  });

  inst.loadBagPage(2);

  assert.equal(bagRequests(requests).length, 0, "命中缓存不应再请求");
  assert.equal(inst.bagItems.length, 1);
  assert.equal(inst.bagCurrent, 2);
  assert.equal(inst.bagTotal, 4, "页数应取回包的 total");
  assert.equal(inst.bagPageSize, 6);
});

test("store_m_bag 收到 20/页预拉取回包时只并 bgNameMap，不写缓存也不上屏", () => {
  const { exposed, sandbox } = loadStoreModule();
  const { handlers } = stubApi(sandbox);
  const inst = makeVm(exposed.appOptions, {
    activeBagMall: "bagZB",
    activeBagTab: "background",
  });

  exposed.appOptions.mounted.call(inst);
  assert.ok(handlers.store_m_bag, "mounted 应注册 store_m_bag 回调");
  handlers.store_m_bag({}, prefetchPayload(20));

  assert.equal(
    Object.keys(inst.bgNameMap).length,
    20,
    "预拉取的唯一用途（背景名录）必须仍然生效",
  );
  assert.equal(inst.bgNameMap._b0, "背景0");
  assert.equal(
    inst.bagCache.bagZB_background,
    undefined,
    "20/页回包不得进入 bagCache",
  );
  assert.equal(inst.bagItems.length, 0, "20/页回包不得上屏");
  assert.equal(inst.bagTotal, 0, "不得把 total=1 写进页数，否则翻页被锁死");
});

test("store_m_bag 收到 6/页正常回包时正常入缓存并上屏", () => {
  const { exposed, sandbox } = loadStoreModule();
  const { handlers } = stubApi(sandbox);
  const inst = makeVm(exposed.appOptions, {
    activeBagMall: "bagZB",
    activeBagTab: "background",
  });

  exposed.appOptions.mounted.call(inst);
  handlers.store_m_bag({}, normalPage(1, 4, 2));

  assert.ok(inst.bagCache.bagZB_background, "6/页回包应入缓存");
  assert.equal(inst.bagItems.length, 2, "应上屏");
  assert.equal(inst.bagTotal, 4, "页数按 6/页计算，翻页可用");
  assert.equal(inst.bagPageSize, 6);
  assert.equal(inst.bagLoading, false);
});

test("store_m_bag 的错误回包仍能显示错误且不污染缓存", () => {
  const { exposed, sandbox } = loadStoreModule();
  const { handlers } = stubApi(sandbox);
  const inst = makeVm(exposed.appOptions, {
    activeBagMall: "bagZB",
    activeBagTab: "background",
  });

  exposed.appOptions.mounted.call(inst);
  handlers.store_m_bag({}, { type: "background", error: "读盘失败", result: [] });

  assert.equal(inst.bagError, "读盘失败", "错误信息应上屏");
  assert.equal(inst.bagCache.bagZB_background, undefined, "错误回包不得入缓存");
});

test("store_m_bag 收到 getConsumablesPage 的畸形失败回包时清掉 loading 走空态，不永久转圈", () => {
  // getConsumablesPage 失败形态：{opt, msg:"获取失败", state:"err"}
  // 既没有 error 也没有 result/pageSize，页大小守卫必须放行，
  // 否则会把"清 loading + 空态"的降级路径变成转圈永不停。
  const { exposed, sandbox } = loadStoreModule();
  const { handlers } = stubApi(sandbox);
  const inst = makeVm(exposed.appOptions, {
    activeBagMall: "bagZB",
    activeBagTab: "background",
  });

  exposed.appOptions.mounted.call(inst);
  assert.equal(inst.bagLoading, true, "mounted 里的 loadBagPage 应先进入加载态");

  handlers.store_m_bag({}, { opt: { type: "background" }, type: "background", msg: "获取失败", state: "err" });

  assert.equal(inst.bagLoading, false, "畸形回包必须清掉 loading，不能永久转圈");
  assert.equal(inst.bagItems.length, 0, "应退化为空列表（模板据此显示空态文案）");
  assert.equal(inst.bagTotal, 0, "页数归零");
});

test("store_m_bag 收到缺 pageSize 的合法回包时不被守卫误挡（守卫自身不制造挂死）", () => {
  const { exposed, sandbox } = loadStoreModule();
  const { handlers } = stubApi(sandbox);
  const inst = makeVm(exposed.appOptions, {
    activeBagMall: "bagZB",
    activeBagTab: "background",
  });

  exposed.appOptions.mounted.call(inst);
  handlers.store_m_bag({}, {
    type: "background",
    result: [{ keyName: "_b1", name: "背景1", type: "background", num: 1 }],
    total: 2,
    current: 1,
    // 故意不带 pageSize
  });

  assert.equal(inst.bagLoading, false, "缺 pageSize 不应导致挂死");
  assert.equal(inst.bagItems.length, 1, "应正常上屏");
});

test("预拉取回包先到时：中间态既不上屏也不入缓存，正常回包到达后仍能翻到第 2 页", () => {
  const { exposed, sandbox } = loadStoreModule();
  const { requests, handlers } = stubApi(sandbox);
  const inst = makeVm(exposed.appOptions, {
    activeBagMall: "bagZB",
    activeBagTab: "background",
  });

  exposed.appOptions.mounted.call(inst);

  // 1) bgNameMap 预拉取的 20/页回包先到。
  //    必须断言**中间态**：只看最终状态是抓不到 bug 的——随后到达的 6/页回包
  //    会把 bagTotal 覆盖成正确值，修复前的实现最终状态也是对的。
  //    真实故障是这一刻缓存被污染、20 件被铺进 2x3 网格。
  handlers.store_m_bag({}, prefetchPayload(20));

  assert.equal(
    inst.bagCache.bagZB_background,
    undefined,
    "中间态：20/页回包不得写进 bagCache（否则用户点「装扮」时会命中污染缓存）",
  );
  assert.equal(inst.bagItems.length, 0, "中间态：20 件不得铺进 2x3 网格");
  assert.equal(inst.bagTotal, 0, "中间态：不得把按 20/页算出的 total=1 写进页数");
  assert.equal(inst.bagLoading, true, "中间态：仍在等真正的 6/页首页，加载态不应被清掉");
  assert.equal(
    Object.keys(inst.bgNameMap).length,
    20,
    "中间态：预拉取的唯一用途（背景名录）必须已生效",
  );

  // 2) 随后 6/页的真实首页回包到达
  handlers.store_m_bag({}, normalPage(1, 4));
  assert.equal(inst.bagTotal, 4, "页数应为 4，而非被 20/页回包算成 1");
  assert.equal(inst.bagItems.length, 6, "首页应正好 6 件");
  assert.equal(inst.bagLoading, false);

  // 3) 点「下一页」不应再被 page > bagTotal 拒掉
  requests.length = 0;
  inst.bagGoto(2);

  const reqs = bagRequests(requests);
  assert.equal(reqs.length, 1, "翻页必须能发出请求");
  assert.equal(reqs[0].current, 2);
  assert.equal(reqs[0].pageSize, 6);
});
