// achievement 预加载：contextBridge 暴露成就窗 IPC（通道命名 <窗口名>_h_xxx_m / <窗口名>_m_xxx_h）
const _require = eval("require");
const { contextBridge, ipcRenderer } = _require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // 拉取成就列表
  achievement_h_load: (e) => ipcRenderer.send("achievement_h_load_m", e),
  // 关闭窗口
  achievement_h_close: (e) => ipcRenderer.send("achievement_h_close_m", e),
  // 接收成就列表：{ ok, list: [{ id, name, desc, icon, unlocked, unlockedAt }] }
  achievement_m_load: (cb) => ipcRenderer.on("achievement_m_load_h",(_e,..._a)=>cb(..._a)),
});

module.exports = {};
