/**
 * newSkinRouter.js —— 新版宠物皮肤（ActionNew/<skinId>）的 Config.xml 解析与动作路由
 *
 * 渲染层普通 script 全局类（window.NewSkinRouter），同时兼容 CommonJS（node --test 用）。
 *
 * 渲染层没有 fs 权限（contextIsolation），因此构造时注入：
 *   - xmlText：preload 桥读取并 GB2312 解码后的 config.xml 文本
 *   - exists(relPath)：preload 桥的文件存在性判断（relPath 相对皮肤根目录）
 *
 * 分组（Package 树 → 磁盘目录）：
 *   stand  → main/stand/normal   （待机）
 *   motion → main/stand/motion   （点击/拖拽/贴边，含 trigger 属性）
 *   play   → main/play           （玩耍）
 *   walk   → main/walk
 *   turn   → main/turn
 *   lead   → main/lead
 *
 * resolve(routerName) 把老皮肤动作名映射到分组/具体文件：
 *   normal/speak      → stand 组加权随机
 *   play              → play 组加权随机
 *   hideleft/hideright→ motion 组 trigger=hitLeft/hitRight 文件，缺失回退 stand
 *   drag              → motion 组 trigger=drag 文件随机，缺失回退 stand
 *   walk/turn/lead    → 对应组加权随机
 *   其余（enter/exit/eat/clean/sick/cure/game/levUp/dying/die/revival/bury/
 *        first/etoj/jtoc/changeState/appear/hide 等无新版动画的）→ play 组随机
 *   任何分组为空时回退链：目标组 → stand → play → null
 */
(function (global) {
  "use strict";

  const GROUP_DIRS = {
    stand: "main/stand/normal",
    motion: "main/stand/motion",
    play: "main/play",
    walk: "main/walk",
    turn: "main/turn",
    lead: "main/lead",
  };

  // 老动作名 → 新皮肤分组；未列出的名字统一走 FALLBACK_GROUP
  const NAME_TO_GROUP = {
    normal: "stand",
    speak: "stand",
    play: "play",
    walk: "walk",
    turn: "turn",
    lead: "lead",
    drag: "motion",
    hideleft: "motion",
    hideright: "motion",
  };
  const FALLBACK_GROUP = "play";

  class NewSkinRouter {
    /**
     * @param {object} opts
     * @param {string} opts.skin      皮肤目录名，如 "10200003"
     * @param {string} opts.basePath  SWF 相对 URL 前缀，如 "../../assets/ActionNew/10200003"
     * @param {string} opts.xmlText   GB2312 解码后的 config.xml 全文
     * @param {Function} opts.exists  (relPath)=>boolean 文件存在性判断（可选，缺省不过滤）
     */
    constructor({ skin, basePath, xmlText, exists } = {}) {
      this.skin = skin || "";
      this.basePath = (basePath || "").replace(/\/+$/, "");
      this.exists = typeof exists === "function" ? exists : () => true;
      this.groups = { stand: [], motion: [], play: [], walk: [], turn: [], lead: [] };
      if (xmlText) this.parse(xmlText);
    }

    /** 解析 config.xml → this.groups（每项 {path, probability, trigger, name}） */
    parse(xmlText) {
      const packages = [];
      // 非递归扫描：记录 Package 开标签栈，Action 归属当前栈
      const re = /<(\/?)(Package|Action)(\s[^>]*?)?(\/?)>/g;
      let m;
      const stack = [];
      while ((m = re.exec(xmlText))) {
        const [, closing, tag, attrText, selfClose] = m;
        if (tag === "Package") {
          if (closing) stack.pop();
          else {
            const attrs = parseAttrs(attrText || "");
            if (!selfClose) stack.push(attrs.name || "");
            // 自闭合 Package 无内容，忽略
          }
        } else if (!closing) {
          const attrs = parseAttrs(attrText || "");
          if (!attrs.path) continue;
          packages.push({
            pkgPath: stack.slice(),
            path: attrs.path,
            probability: parseFloat(attrs.probability) || 0,
            trigger: attrs.trigger || "",
            name: attrs.name || "",
          });
        }
      }
      for (const a of packages) {
        const group = this._groupOf(a.pkgPath);
        if (group) this.groups[group].push(a);
      }
      return this.groups;
    }

    /** Package 栈 → 分组名：stand/normal→stand，stand/motion→motion，其余取顶层名 */
    _groupOf(pkgPath) {
      if (pkgPath[0] === "main") pkgPath = pkgPath.slice(1);
      if (pkgPath[0] === "stand") {
        if (pkgPath[1] === "normal") return "stand";
        if (pkgPath[1] === "motion") return "motion";
        return "stand";
      }
      return GROUP_DIRS[pkgPath[0]] ? pkgPath[0] : null;
    }

    /** 组内加权随机（先按 exists 过滤不存在的文件），返回相对皮肤根目录的路径或 null */
    pickSwf(group, filter) {
      let list = (this.groups[group] || []).filter((a) => {
        if (filter && !filter(a)) return false;
        return a.probability > 0 && this.exists(this.relPath(group, a.path));
      });
      if (!list.length) return null;
      const total = list.reduce((s, a) => s + a.probability, 0);
      let r = Math.random() * total;
      for (const a of list) {
        r -= a.probability;
        if (r <= 0) return this.relPath(group, a.path);
      }
      return this.relPath(group, list[list.length - 1].path);
    }

    /** 分组 + 文件名 → 相对皮肤根目录路径 */
    relPath(group, file) {
      return `${GROUP_DIRS[group]}/${file}`;
    }

    /** 分组为空时的回退链：目标组 → stand → play */
    _pickWithFallback(group, filter) {
      if (group !== "stand" && group !== "play") {
        return this.pickSwf(group, filter) || this._pickWithFallback("stand") || this.pickSwf("play");
      }
      if (group === "stand") return this.pickSwf("stand") || this.pickSwf("play");
      return this.pickSwf("play") || this.pickSwf("stand");
    }

    /**
     * 老动作名 → {src, rel, group, name}；src 为可直接喂给 <embed> 的相对 URL。
     * 完全无可用 SWF 时返回 {src:null, rel:null, group:null, name}。
     */
    resolve(routerName) {
      const name = (routerName || "normal") + "";
      let group = NAME_TO_GROUP[name] || FALLBACK_GROUP;
      let filter = null;
      if (name === "hideleft") filter = (a) => /hide_left/i.test(a.path) || a.trigger === "hitLeft";
      else if (name === "hideright") filter = (a) => /hide_right/i.test(a.path) || a.trigger === "hitRight";
      else if (name === "drag") filter = (a) => a.trigger === "drag" || /^drag/i.test(a.path);
      const rel = this._pickWithFallback(group, filter);
      return { src: rel ? `${this.basePath}/${rel}` : null, rel, group, name };
    }
  }

  function parseAttrs(text) {
    const attrs = {};
    const re = /([\w-]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(text))) attrs[m[1]] = m[2];
    return attrs;
  }

  global.NewSkinRouter = NewSkinRouter;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { NewSkinRouter };
  }
})(typeof window !== "undefined" ? window : globalThis);
