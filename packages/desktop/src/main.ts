import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { editorUrl, ensureServer, type ServerInfo } from "@sous-chef/server/connect";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = "Sous Chef";
const APP_ID = "com.tonbistudio.sous-chef";
const ICON = path.join(here, "..", "assets", process.platform === "win32" ? "icon.ico" : "icon.png");

// Its own name and identity, not Electron's: the taskbar groups windows by this id and takes the
// name and icon from the Start menu shortcut that carries the same id.
app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

/**
 * Windows takes the taskbar name and icon from a Start menu shortcut carrying the app's id. Run from
 * the source with plain electron.exe, the shortcut is what stops it being called "Electron"; run from
 * the launcher (Sous Chef.exe, `npm run launcher`), the shortcut points at that instead. A
 * shortcut to the launcher is never swapped back to electron.exe by a run from source.
 */
function ensureShortcut(): void {
  if (process.platform !== "win32") return;
  try {
    const link = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", `${APP_NAME}.lnk`);
    const fromSource = /^electron\.exe$/i.test(path.basename(process.execPath));
    const want = { target: process.execPath, args: fromSource ? `"${app.getAppPath()}"` : "", cwd: path.dirname(process.execPath), icon: fromSource ? ICON : process.execPath, iconIndex: 0, appUserModelId: APP_ID, description: "Local, agent-driven video editor" };
    let current: Electron.ShortcutDetails | null = null;
    try { current = shell.readShortcutLink(link); } catch { /* not made yet */ }
    if (current && fromSource && !/electron\.exe$/i.test(current.target) && existsSync(current.target)) return;
    if (current && current.target === want.target && current.args === want.args && current.icon === want.icon && current.appUserModelId === APP_ID) return;
    shell.writeShortcutLink(link, current ? "replace" : "create", want);
  } catch {
    /* only cosmetic */
  }
}
const MEDIA = ["mp4", "m4v", "mov", "mkv", "webm", "mp3", "wav", "m4a", "aac", "flac", "ogg", "png", "jpg", "jpeg", "webp", "gif"];

let win: BrowserWindow | null = null;
let server: ServerInfo | null = null;

// QA hook: lets an automated check read the page over the DevTools protocol. Off unless asked for.
const debugPort = process.env.SOUS_CHEF_DEBUG_PORT;
if (debugPort) app.commandLine.appendSwitch("remote-debugging-port", debugPort);

function boundsFile(): string {
  return path.join(app.getPath("userData"), "window.json");
}

function savedBounds(): { width: number; height: number; x?: number; y?: number } {
  try {
    return JSON.parse(readFileSync(boundsFile(), "utf8"));
  } catch {
    return { width: 1440, height: 900 };
  }
}

/** A project folder passed on the command line, e.g. when a .sous folder is opened with the app. */
function projectArg(argv: string[]): string | null {
  const hit = argv.slice(1).find((a) => /\.(sous|aigedit|cutroom)$/i.test(a) && existsSync(a));
  return hit ? path.resolve(hit) : null;
}

async function openProject(dir: string, create = false): Promise<string | null> {
  if (!server) return null;
  const res = await fetch(`http://127.0.0.1:${server.port}/api/projects/open`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ path: dir, create }),
  });
  const body = (await res.json()) as { projectId?: string; error?: { message: string } };
  if (!res.ok || !body.projectId) {
    dialog.showErrorBox("Sous Chef", body.error?.message ?? "Could not open that project.");
    return null;
  }
  return body.projectId;
}

async function showProject(dir: string, create = false): Promise<void> {
  const id = await openProject(dir, create);
  if (id && win && server) await win.loadURL(editorUrl(server, id));
}

/** The projects folder from preferences, where the Open and New dialogs start. Null if it can't be read. */
async function projectsFolder(): Promise<string | null> {
  if (!server) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/preferences`, { headers: { authorization: `Bearer ${server.token}` } });
    const p = (await res.json()) as { projectsFolder?: string };
    return res.ok && typeof p.projectsFolder === "string" && p.projectsFolder ? path.normalize(p.projectsFolder) : null;
  } catch {
    return null;
  }
}

async function pickProject(): Promise<string | null> {
  if (!win) return null;
  const start = await projectsFolder();
  const r = await dialog.showOpenDialog(win, { title: "Open an Sous Chef project", properties: ["openDirectory"], ...(start && existsSync(start) ? { defaultPath: start } : {}) });
  const dir = r.filePaths[0];
  if (r.canceled || !dir) return null;
  if (!/\.(sous|aigedit|cutroom)$/i.test(dir)) {
    dialog.showErrorBox("Sous Chef", "Choose a project folder. Its name ends in .sous");
    return null;
  }
  return dir;
}

async function pickFolder(start?: string): Promise<string | null> {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { title: "Where new projects go", properties: ["openDirectory", "createDirectory"], ...(typeof start === "string" && start ? { defaultPath: start } : {}) });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

async function newProject(): Promise<string | null> {
  if (!win) return null;
  const start = await projectsFolder();
  const r = await dialog.showSaveDialog(win, {
    title: "New Sous Chef project",
    ...(start ? { defaultPath: path.join(start, "New project.sous") } : {}),
    buttonLabel: "Create project",
    filters: [{ name: "Sous Chef project", extensions: ["sous"] }],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath.toLowerCase().endsWith(".sous") ? r.filePath : `${r.filePath}.sous`;
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { label: "New Project…", accelerator: "CmdOrCtrl+N", click: async () => { const p = await newProject(); if (p) await showProject(p, true); } },
          { label: "Open Project…", accelerator: "CmdOrCtrl+O", click: async () => { const p = await pickProject(); if (p) await showProject(p); } },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "View",
        submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
      },
    ]),
  );
}

async function createWindow(): Promise<void> {
  server = await ensureServer();
  const origin = `http://127.0.0.1:${server.port}`;
  win = new BrowserWindow({
    ...savedBounds(),
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0e0e10",
    title: APP_NAME,
    icon: ICON,
    show: false,
    webPreferences: {
      preload: path.join(here, "..", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.on("close", () => {
    if (win && !win.isMinimized() && !win.isFullScreen()) {
      try {
        writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
      } catch {
        /* not worth failing a close over */
      }
    }
  });
  win.on("closed", () => {
    win = null;
  });
  // The window only ever shows the local editor. Anything else opens in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin + "/")) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  const dir = projectArg(process.argv);
  const id = dir ? await openProject(dir) : null;
  await win.loadURL(editorUrl(server, id ?? undefined));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const dir = projectArg(argv);
    if (dir) void showProject(dir);
  });

  ipcMain.handle("sous:pick-media", async () => {
    if (!win) return [];
    const r = await dialog.showOpenDialog(win, {
      title: "Import media",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Video, audio and images", extensions: MEDIA }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle("sous:pick-project", () => pickProject());
  ipcMain.handle("sous:new-project", () => newProject());
  ipcMain.handle("sous:pick-folder", (_e, start: unknown) => pickFolder(typeof start === "string" ? start : undefined));

  app.whenReady().then(async () => {
    buildMenu();
    ensureShortcut();
    try {
      await createWindow();
    } catch (err) {
      dialog.showErrorBox("Sous Chef could not start", err instanceof Error ? err.message : String(err));
      app.quit();
    }
  });
  // The edit server keeps running for a while so the Hermes page can still use it; it stops itself when idle.
  app.on("window-all-closed", () => app.quit());
  // QA hooks, off unless asked for: close the window after a delay, and log the shutdown sequence.
  const closeAfter = Number(process.env.SOUS_CHEF_QA_CLOSE_AFTER_MS ?? 0);
  if (closeAfter > 0) setTimeout(() => win?.close(), closeAfter);
  if (process.env.SOUS_CHEF_DEBUG_LOG) {
    const log = (m: string) => appendFileSync(process.env.SOUS_CHEF_DEBUG_LOG!, `${new Date().toISOString()} ${m}\n`);
    for (const e of ["window-all-closed", "before-quit", "will-quit", "quit"] as const) app.on(e as "quit", () => log(e));
    process.on("exit", (code) => log(`process exit ${code}`));
  }
}
