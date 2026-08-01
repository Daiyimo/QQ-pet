// signIn 预加载：contextBridge 暴露签到 IPC（通道命名 signIn_h_xxx_m / signIn_m_xxx_h）
const _require = eval("require");
const { contextBridge, ipcRenderer } = _require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // 事件总线：{ event: "mounted" | "close" }
  signIn_h_bus: (e) => ipcRenderer.send("signIn_h_bus_m", e),
  // 点击"立即签到"
  signIn_h_do: (e) => ipcRenderer.send("signIn_h_do_m", e),
  // 接收状态：{ signedToday, streak, total, week[7] }
  signIn_m_load: (cb) => ipcRenderer.on("signIn_m_load_h",(_e,..._a)=>cb(..._a)),
  // 接收签到结果：{ ok, reason?, streak?, total?, rewards?, status }
  signIn_m_result: (cb) => ipcRenderer.on("signIn_m_result_h",(_e,..._a)=>cb(..._a)),
});

module.exports = {};
