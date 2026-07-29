const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  setup_h_say: (msg) => ipcRenderer.send("setup_h_say_m", msg),
  setup_m_bus: (callback) => ipcRenderer.on("setup_m_bus_h", callback),
  setup_h_bus: (event) => ipcRenderer.send("setup_h_bus_m", event),
  setup_m_sysInfo: (callback) => ipcRenderer.on("setup_m_sysInfo_h", callback),
  setup_h_setStting: (data) => ipcRenderer.send("setup_h_setStting_m", data),
});