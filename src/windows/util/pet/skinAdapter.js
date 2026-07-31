/**
 * skinAdapter.js —— 新版宠物皮肤适配器（在 swfPet.js 之后加载）
 *
 * 原理：包装 window.swfPet.prototype.init。当 init 参数带新皮肤 petSkin
 * （非 "classic"）时，用 defineProperty 拦截 init 内部 `this.router = new Router(...)`
 * 的赋值，在原 init 播放 enter 动画之前把该实例的 getRouter 换成
 * NewSkinRouter 的解析结果；老皮肤（classic / 配置缺失 / 桥不可用）完全走原逻辑。
 *
 * Config.xml 的读取（GB2312 解码）与文件存在性判断由 preload 桥完成
 * （渲染层主世界无 require）：window.electronAPI.newSkinReadConfig /
 * window.electronAPI.newSkinFileExists。
 *
 * 新皮肤为单一形象，不分 sex/age/mood 子目录；老皮肤的性别/年龄/心情体系不受影响。
 * 贴边隐藏（edgeHide 播 hideleft/hideright）映射到 motion 组 hide_left/hide_right
 * 文件，缺失时回退 stand 组（见 NewSkinRouter.resolve）。
 */
(function () {
  "use strict";
  if (!window.swfPet || !window.NewSkinRouter) return;

  const origInit = window.swfPet.prototype.init;

  window.swfPet.prototype.init = function (t = {}) {
    const skin = t.petSkin;
    const api = window.electronAPI || {};
    if (!skin || skin === "classic" || typeof api.newSkinReadConfig !== "function") {
      return origInit.call(this, t);
    }
    let xmlText = null;
    try {
      xmlText = api.newSkinReadConfig(skin);
    } catch (e) {
      // 新皮肤 Config.xml 读不到（缺文件/桥异常）属可降级情况：下一行回退老皮肤逻辑
      console.warn("[skinAdapter] 读取新皮肤 Config.xml 失败，回退老皮肤逻辑:", skin, e?.stack || e);
    }
    if (!xmlText) return origInit.call(this, t);

    const basePath = (t.baseRouter || "").replace(/assets\/Action$/, "assets/ActionNew/" + skin);
    const newRouter = new window.NewSkinRouter({
      skin,
      basePath,
      xmlText,
      exists: (rel) => {
        try {
          return typeof api.newSkinFileExists === "function" && !!api.newSkinFileExists(skin, rel);
        } catch (e) {
          return false;
        }
      },
    });

    let inst = null;
    const patchRouter = (r) => {
      const origGetRouter = r.getRouter.bind(r);
      r.getRouter = function (name, oldNext) {
        const res = newRouter.resolve(name);
        if (!res.src) return origGetRouter(name, oldNext); // 新皮肤无可用素材，回退老路由
        return { src: res.src, opt: { state: res.name }, name: res.name };
      };
    };

    Object.defineProperty(this, "router", {
      configurable: true,
      set(r) {
        inst = r;
        if (r) patchRouter(r);
      },
      get() {
        return inst;
      },
    });
    try {
      origInit.call(this, t);
    } finally {
      delete this.router; // 移除访问器，恢复普通属性
      this.router = inst;
    }
  };
})();
