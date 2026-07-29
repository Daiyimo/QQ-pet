// travel 预加载：contextBridge 暴露旅游 IPC（通道命名 <窗口名>_h_xxx_m / <窗口名>_m_xxx_h）
const _require = eval("require");
const { contextBridge, ipcRenderer } = _require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // 请求下发状态（打开时 / 倒计时归零后刷新）
  travel_h_load: (e) => ipcRenderer.send("travel_h_load_m", e),
  // 开始旅游
  travel_h_start: (e) => ipcRenderer.send("travel_h_start_m", e),
  // 提前召回
  travel_h_cancel: (e) => ipcRenderer.send("travel_h_cancel_m", e),
  // 关闭窗口
  travel_h_close: (e) => ipcRenderer.send("travel_h_close_m", e),
  // 接收状态下发：{ status, provinces }
  travel_m_load: (cb) => ipcRenderer.on("travel_m_load_h", cb),
  // 接收操作结果：{ status, result }
  travel_m_status: (cb) => ipcRenderer.on("travel_m_status_h", cb),
});

module.exports = {};
