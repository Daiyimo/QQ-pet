"use strict";

/**
 * localstorge.js —— 渲染层 localStorage 的 JSON 存取封装
 *
 * 注意：文件名是历史拼写错误（应为 localstorage.js），全项目 grep 当前**零引用**
 * （2026-08 审查时确认），保留原文件名以避免漏改引用风险；若将来确认无用可整体删除。
 *
 * 历史问题（本次清理）：
 * - 旧实现是 `new class{...}` 匿名实例，创建后即被丢弃，实例方法不可达；
 * - `module.exports={}` 空壳导出，require 它拿不到任何东西。
 * 现改为导出类本身（双模：CommonJS / 渲染层 window.LocalStorge），调用方自行实例化。
 */
class LocalStorge {
  constructor() {
    this.storage = window.localStorage;
  }
  get(key) {
    let v = this.storage.getItem(key + "");
    try {
      v = JSON.parse(v);
    } catch (e) {
      console.warn("[localstorge] 读取项 JSON 解析失败，返回原始字符串:", e?.message || e);
    }
    return v;
  }
  set(key, v) {
    try {
      v = JSON.stringify(v);
    } catch (e) {
      console.warn("[localstorge] 写入项 JSON 序列化失败，按原值写入:", e?.message || e);
    }
    this.storage.setItem(key + "", v);
  }
  remove(key) {
    this.storage.removeItem(key + "");
  }
  clear() {
    this.storage.clear();
  }
}

if (typeof module !== "undefined" && module) {
  module.exports = { LocalStorge };
}
if (typeof window !== "undefined") {
  window.LocalStorge = LocalStorge;
}
