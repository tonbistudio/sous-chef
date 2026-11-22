// Runs in the sandboxed page before the editor loads. Exposes only native file dialogs and the path of a dropped file.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("sousChefDesktop", {
  /** Native "open files" dialog. Resolves to absolute paths, or an empty list when cancelled. */
  pickMedia: () => ipcRenderer.invoke("sous:pick-media"),
  /** Native dialog to open an existing project folder. Resolves to its path or null. */
  pickProject: () => ipcRenderer.invoke("sous:pick-project"),
  /** Native dialog to choose where a new project goes. Resolves to a path ending in .sous, or null. */
  newProject: () => ipcRenderer.invoke("sous:new-project"),
  /** Native folder dialog. Resolves to the folder, or null when cancelled. */
  pickFolder: (start) => ipcRenderer.invoke("sous:pick-folder", start),
  /** Where a file dropped on the window lives on disk. */
  pathForFile: (file) => webUtils.getPathForFile(file),
});
