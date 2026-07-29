// aiChat 预加载：contextBridge 暴露对话 IPC（通道命名 <窗口名>_h_xxx_m / <窗口名>_m_xxx_h）
const _require = eval("require");
const { contextBridge, ipcRenderer } = _require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // 发送消息：{ text, withScreen }
  aiChat_h_send: (e) => ipcRenderer.send("aiChat_h_send_m", e),
  // 清空对话历史
  aiChat_h_clear: (e) => ipcRenderer.send("aiChat_h_clear_m", e),
  // 关闭窗口
  aiChat_h_close: (e) => ipcRenderer.send("aiChat_h_close_m", e),
  // 接收回复：{ ok, reply?, error?, type? }
  aiChat_m_reply: (cb) => ipcRenderer.on("aiChat_m_reply_h", cb),
});

module.exports = {};
