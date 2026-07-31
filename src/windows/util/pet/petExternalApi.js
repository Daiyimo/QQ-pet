/**
 * petExternalApi.js —— window.API 桥：动作 SWF 的 ExternalInterface 回调（企鹅眼神追随）
 *
 * ## 背景
 *
 * 官方动作素材（src/assets/Action/...）的 DoABC 内建了"眼神追随鼠标"逻辑：
 * SWF 每帧通过 ExternalInterface 调用页面上的 `API.GetCursorPosition` / `API.GetWindowRect`
 * 拉取鼠标位置与宠物容器矩形，据此计算眼球在眼眶椭圆内的偏移（还有揉眼、晕眼判定）。
 * 官方 1.2.5 渲染层在宠物组件 mounted 时挂这两个回调（renderer.index.js:47466-47467）。
 *
 * 若页面没有 window.API，SWF 的 isDebugMode() 判定为 true，回退到 Flash 原生 mouseX/mouseY ——
 * 该分支在 Ruffle 下基本等价于"只有光标悬停在宠物本体上才有反应"。
 * 本模块把官方桥补上，恢复完整的窗口内眼神追随。
 *
 * ## 协议（与 SWF 内反汇编逻辑对齐，不可改）
 *
 * - `API.GetCursorPosition()` -> "x,y,0"：相对宠物窗口左上角的鼠标坐标（clientX/clientY）。
 * - `API.GetWindowRect()` -> "left,top,width,height"：宠物容器（#pet）在窗口内的矩形。
 *   SWF 内部做 p = cursor - rect.xy，再按 rect.size / loaderInfo.size 缩放，
 *   所以必须给 #pet 的实际矩形（swfPet.js 会按 opt.size 缩放 SWF），不能给整个窗口。
 * - `API.GetCursorPositionHtml()`：常量池里有名字但本批素材不调，留 noop 兼容旧存根语义。
 *
 * ## 加载方式
 *
 * 由 src/windows/main/main.js 的 jsFiles 注入（唯一接入点，压缩文件里就一行）：
 *   a.jsFiles=["./util/pet/petExternalApi.js","./util/move.js",...]
 * 注入发生在 Ruffle 加载 SWF 之前，ENTER_FRAME 回调首次触发时 window.API 已就绪。
 *
 * ## 已知限制
 *
 * 主窗口 setIgnoreMouseEvents(true,{forward:true})：光标落在透明像素上时窗口收不到
 * mousemove，返回的是最后一次位置（官方 1.2.5 同样只跟踪窗口内光标，行为一致）。
 */
((global) => {
  "use strict";

  let lastX = 0;
  let lastY = 0;

  global.addEventListener(
    "mousemove",
    (e) => {
      lastX = e.clientX;
      lastY = e.clientY;
    },
    { passive: true }
  );

  /** 宠物容器矩形；元素未就绪或被 Ruffle 替换瞬间回退到整个窗口。 */
  function getPetRect() {
    const el = global.document && global.document.getElementById("pet");
    if (el) {
      const r = el.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) return r;
    }
    return { left: 0, top: 0, width: global.innerWidth || 0, height: global.innerHeight || 0 };
  }

  global.API = Object.assign(global.API || {}, {
    GetCursorPosition: () => lastX + "," + lastY + ",0",
    GetWindowRect: () => {
      const r = getPetRect();
      return r.left + "," + r.top + "," + r.width + "," + r.height;
    },
    GetCursorPositionHtml: () => {},
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getPetRect };
  }
})(typeof window !== "undefined" ? window : globalThis);
