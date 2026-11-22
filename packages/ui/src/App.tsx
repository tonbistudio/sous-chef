import { useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import logo from "./icon.png";
import type { Op } from "@sous-chef/core";
import { clipSpans, cutRangeOps, splitAtOp } from "./actions";
import { api, subscribe, token } from "./api";
import { Chat } from "./Chat";
import { Library } from "./Library";
import { SettingsButton } from "./Settings";
import { useTheme } from "./theme";
import { Publish } from "./Publish";
import { desktop } from "./desktop";
import { ExportButton } from "./ExportButton";
import { FilePicker } from "./FilePicker";
import { local, session } from "./storage";
import { Inspector, MediaBin, Preview } from "./Panels";
import { Transcript } from "./Transcript";
import { Timeline } from "./Timeline";
import { baseName, clock } from "./time";
import { useEditor, type Editor } from "./useEditor";

const RECENT = "sous.recent";

function recentProjects(): string[] {
  try {
    return JSON.parse(local.get(RECENT) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function remember(path: string): void {
  const next = [path, ...recentProjects().filter((p) => p !== path)].slice(0, 8);
  local.set(RECENT, JSON.stringify(next));
}

function setProjectInUrl(pid: string | null): void {
  const url = new URL(location.href);
  if (pid) url.searchParams.set("project", pid);
  else url.searchParams.delete("project");
  // Keep the token out of the address bar, but only when a reload can still find it.
  if (session.persistent) url.searchParams.delete("token");
  try {
    history.replaceState(null, "", url);
  } catch {
    /* a sandboxed frame may refuse; the address is only a convenience */
  }
  // Inside the Hermes page, tell the host which project is open so it can reopen it next time.
  if (window.parent !== window) window.parent.postMessage({ type: "sous:project", projectId: pid }, "*");
}

/** A new project needs only a name. It goes in the usual projects folder unless another is picked. */
function NewProject({ onCreated, onError }: { onCreated: (path: string, pid: string) => void; onError: (msg: string) => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.preferences().then((p) => setFolder(p.projectsFolder)).catch(() => undefined), []);
  const create = () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    onError("");
    api
      .newProject(name.trim(), folder || undefined)
      .then((r) => onCreated(r.path, r.projectId))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="new-project" onSubmit={(e) => { e.preventDefault(); create(); }}>
      <input autoFocus placeholder="New project name, e.g. Hermes plugins tutorial" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="primary" type="submit" disabled={!name.trim() || busy}>Create project</button>
      <div className="dim small folder-line">
        Saved in{" "}
        {desktop?.pickFolder ? (
          <>
            <span title={folder}>{folder || "…"}</span>{" "}
            <button type="button" className="ghost small" onClick={() => void desktop!.pickFolder!(folder).then((f) => f && setFolder(f.replace(/\\/g, "/")))}>Change…</button>
          </>
        ) : (
          <input className="folder" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder for the new project" />
        )}
        . No video needed: import takes, add text or graphics whenever you like.
      </div>
    </form>
  );
}

function Start({ onOpen }: { onOpen: (pid: string) => void }) {
  const [open, setOpen] = useState<{ projectId: string; path: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const recent = recentProjects();

  useEffect(() => {
    // A window on the start screen is still in use, even before a project is open.
    // Keep the same live connection the editor uses so the server does not idle out.
    const unsubscribe = subscribe(() => {}, () => {});
    api.projects().then((r) => setOpen(r.projects)).catch((e) => setError(e.message));
    return unsubscribe;
  }, []);

  const openPath = (path: string, create = false) => {
    setError("");
    api
      .open(path, create)
      .then((r) => {
        remember(r.path);
        onOpen(r.projectId);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const others = recent.filter((p) => !open.some((o) => o.path.toLowerCase() === p.toLowerCase()));

  return (
    <main className="start">
      <h1 className="brand"><img src={logo} alt="" width={40} height={40} />Sous Chef<span className="grow" /><ThemeToggle /></h1>
      <p className="lead">Start a new project, or open one.</p>
      <NewProject onCreated={(path, id) => { remember(path); onOpen(id); }} onError={setError} />
      {desktop ? (
        <div className="row">
          <button onClick={() => void desktop!.pickProject().then((p) => p && openPath(p))}>Open project…</button>
        </div>
      ) : (
        <button onClick={() => setPicking(true)}>Open a project…</button>
      )}
      {error && <p className="error">{error}</p>}
      {open.length > 0 && (
        <>
          <h2>Open now</h2>
          <ul className="projects">
            {open.map((p) => (
              <li key={p.projectId}>
                <button onClick={() => { remember(p.path); onOpen(p.projectId); }}>
                  <strong>{baseName(p.path).replace(/\.(sous|aigedit|cutroom)$/i, "")}</strong>
                  <span>{p.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {others.length > 0 && (
        <>
          <h2>Recent</h2>
          <ul className="projects">
            {others.map((p) => (
              <li key={p}>
                <button onClick={() => openPath(p)}>
                  <strong>{baseName(p).replace(/\.(sous|aigedit|cutroom)$/i, "")}</strong>
                  <span>{p}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {picking && (
        <FilePicker
          mode="project"
          title="Open or create a project"
          onCancel={() => setPicking(false)}
          onProject={(path, create) => {
            setPicking(false);
            openPath(path, create);
          }}
        />
      )}
    </main>
  );
}

function useShortcuts(editor: Editor, cut: () => void, split: () => void, remove: (closeUp?: boolean) => void, active = true) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true]") || document.querySelector(".overlay")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === "Space") {
        e.preventDefault();
        editor.player.toggle();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void (e.shiftKey ? editor.redo() : editor.undo());
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void editor.redo();
      } else if (!mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        split();
      } else if (!mod && e.key.toLowerCase() === "m") {
        e.preventDefault();
        void editor.run(`Add marker at ${clock(editor.player.tlUs)}`, [{ op: "marker.add", timeUs: Math.round(editor.player.tlUs) }]);
      } else if (!mod && e.key.toLowerCase() === "x") {
        e.preventDefault();
        cut();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (editor.range) cut();
        else if (editor.selectedZoomId) void editor.run("Remove zoom", [{ op: "zoom.remove", zoomId: editor.selectedZoomId }]);
        else if (editor.selectedOverlayId) void editor.run("Remove text", [{ op: "overlay.remove", overlayId: editor.selectedOverlayId }]);
        else remove(e.shiftKey);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) editor.player.seek(Math.max(0, editor.player.tlUs - 5_000_000));
        else editor.player.step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) editor.player.seek(Math.min(editor.plan.durationUs, editor.player.tlUs + 5_000_000));
        else editor.player.step(1);
      } else if (e.key === "Home") {
        editor.player.seek(0);
      } else if (e.key === "End") {
        editor.player.seek(editor.plan.durationUs);
      } else if (e.key === "Escape") {
        editor.setRange(null);
        editor.selectClip(null);
        editor.selectZoom(null);
        editor.selectOverlay(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, cut, split, remove, active]);
}

type View = "edit" | "publish" | "library";

/** Black marble or white marble. */
function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button className="ghost icon-only theme-toggle" onClick={toggle} title={`Switch to ${next === "light" ? "white" : "black"} marble`} aria-label={`Switch to ${next} mode`}>
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}

function EditorView({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { plan, range, selectedClipId, history } = editor;
  const [view, setView] = useState<View>(() => {
    const v = local.get("sous.view");
    return v === "publish" || v === "library" ? v : "edit";
  });
  const show = useCallback((v: View) => {
    setView(v);
    local.set("sous.view", v);
    if (v !== "edit") editor.player.pause();
  }, [editor.player]);
  useEffect(() => {
    const on = (e: Event) => show((e as CustomEvent).detail as View);
    window.addEventListener("sous:view", on);
    return () => window.removeEventListener("sous:view", on);
  }, [show]);

  const cut = useCallback(() => {
    if (!range) return;
    const ops = cutRangeOps(plan, range[0], range[1]);
    if (!ops.length) return;
    const a = Math.min(range[0], range[1]);
    void editor.run(`Cut ${clock(Math.abs(range[1] - range[0]), 2)} at ${clock(a)}`, ops).then((ok) => {
      if (ok) {
        editor.setRange(null);
        editor.player.seek(a);
      }
    });
  }, [editor, plan, range]);

  const split = useCallback(() => {
    const op = splitAtOp(plan, editor.player.tlUs);
    if (!op) {
      editor.notify("Move the playhead inside a clip to split it.");
      return;
    }
    void editor.run(`Split at ${clock(editor.player.tlUs)}`, [op]);
  }, [editor, plan]);

  /** Removes the selected clip, leaving its space empty. With `closeUp`, later clips slide left to fill it. */
  const remove = useCallback(
    (closeUp = false) => {
      if (!selectedClipId) return;
      const span = clipSpans(plan).get(selectedClipId);
      const ops: Op[] = [{ op: "clip.remove", clipId: selectedClipId }];
      if (closeUp && span && [...clipSpans(plan).values()].some((sp) => sp.startUs >= span.endUs)) ops.push({ op: "gap.close", atUs: span.startUs });
      void editor.run(closeUp ? "Remove clip and close the gap" : "Remove clip", ops);
    },
    [editor, plan, selectedClipId],
  );

  useShortcuts(editor, cut, split, remove, view === "edit");

  return (
    <div className={"editor" + (view === "edit" ? "" : " publishing") + (view === "library" ? " in-library" : "")}>
      <header className="topbar">
        <button className="ghost with-icon" onClick={onClose} title="Back to projects"><Icon name="back" />Projects</button>
        <strong className="project-name" title={editor.path}>{baseName(editor.path).replace(/\.(sous|aigedit|cutroom)$/i, "")}</strong>
        <div className="view-switch" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === "edit"} className={view === "edit" ? "on" : ""} onClick={() => show("edit")}>Edit</button>
          <button role="tab" aria-selected={view === "publish"} className={view === "publish" ? "on" : ""} onClick={() => show("publish")} title="Thumbnail, title and description for YouTube">Publish</button>
          <button role="tab" aria-selected={view === "library"} className={view === "library" ? "on" : ""} onClick={() => show("library")} title="Timeline templates, description and thumbnail templates, and what Hermes remembers, shared by every project">Library</button>
        </div>
        <span className="grow" />
        <button onClick={() => void editor.undo()} disabled={!history.canUndo} title={history.undo ? `Undo: ${history.undo} (Ctrl+Z)` : "Nothing to undo"} className="icon-only" aria-label="Undo"><Icon name="undo" /></button>
        <button onClick={() => void editor.redo()} disabled={!history.canRedo} title={history.redo ? `Redo: ${history.redo} (Ctrl+Shift+Z)` : "Nothing to redo"} className="icon-only" aria-label="Redo"><Icon name="redo" /></button>
        <span className="sep" />
        <button onClick={split} disabled={plan.durationUs === 0} title="Split the clip at the playhead (S)" className="with-icon"><Icon name="split" />Split</button>
        <button onClick={cut} disabled={!range} title="Cut the marked range (X or Delete)" className="with-icon"><Icon name="cut" />Cut range</button>
        <button onClick={() => remove(false)} disabled={!selectedClipId} title="Remove the selected clip and leave its space empty (Delete). Shift+Delete also closes the gap." className="with-icon"><Icon name="trash" />Remove clip</button>
        <span className="sep" />
        <ExportButton editor={editor} />
        <span className="sep" />
        <ThemeToggle />
        <span className={"status " + (editor.connected ? "ok" : "off")} title={editor.connected ? "Connected to the edit server" : "Reconnecting to the edit server"}>
          {editor.connected ? "Live" : "Offline"}
        </span>
        <span className="rev" title="Project revision">r{editor.project.revision}</span>
        <SettingsButton editor={editor} />
      </header>
      <Left editor={editor} />
      <Preview editor={editor} />
      <Side editor={editor} />
      <Timeline editor={editor} />
      {view === "publish" && <Publish editor={editor} />}
      {view === "library" && <Library editor={editor} />}
      <div className="toasts" aria-live="polite">
        {editor.toasts.map((t) => (
          <div key={t.id} className={"toast " + t.kind} role={t.kind === "error" ? "alert" : undefined}>
            <span className="toast-text">{t.text}</span>
            {t.count > 1 && <span className="toast-count" title="Times this came up">×{t.count}</span>}
            <button className="toast-x" aria-label="Dismiss" onClick={() => editor.dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The left column: the project's media, or the chat with Hermes. */
function Left({ editor }: { editor: Editor }) {
  const [tab, setTab] = useState<"media" | "chat">(() => (local.get("sous.left") === "chat" ? "chat" : "media"));
  const pick = (t: "media" | "chat") => {
    setTab(t);
    local.set("sous.left", t);
  };
  useEffect(() => {
    const on = (e: Event) => pick((e as CustomEvent).detail);
    window.addEventListener("sous:left", on);
    return () => window.removeEventListener("sous:left", on);
  }, []);
  return (
    <aside className="leftcol" aria-label="Media and chat">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "media"} className={tab === "media" ? "on" : ""} onClick={() => pick("media")}>Media</button>
        <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => pick("chat")}>
          Chat{editor.chat.running ? " ●" : ""}
        </button>
      </div>
      {tab === "media" ? <MediaBin editor={editor} /> : <Chat editor={editor} />}
    </aside>
  );
}

function Side({ editor }: { editor: Editor }) {
  const [tab, setTab] = useState<"transcript" | "details" | "media" | "chat">("transcript");
  // Picking a clip on the timeline is a request to see its details.
  useEffect(() => {
    if (editor.selectedClipId || editor.selectedZoomId || editor.selectedOverlayId) setTab("details");
  }, [editor.selectedClipId, editor.selectedZoomId, editor.selectedOverlayId]);
  return (
    <aside className="side" aria-label="Transcript and details">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "transcript"} className={tab === "transcript" ? "on" : ""} onClick={() => setTab("transcript")}>Transcript</button>
        <button role="tab" aria-selected={tab === "details"} className={tab === "details" ? "on" : ""} onClick={() => setTab("details")}>Details</button>
        <button role="tab" aria-selected={tab === "media"} className={"narrow-only" + (tab === "media" ? " on" : "")} onClick={() => setTab("media")}>Media</button>
        <button role="tab" aria-selected={tab === "chat"} className={"narrow-only" + (tab === "chat" ? " on" : "")} onClick={() => setTab("chat")}>Chat</button>
      </div>
      {tab === "transcript" ? <Transcript editor={editor} /> : tab === "details" ? <Inspector editor={editor} /> : tab === "chat" ? <Chat editor={editor} /> : <MediaBin editor={editor} />}
    </aside>
  );
}

function Loaded({ pid, onClose }: { pid: string; onClose: () => void }) {
  const editor = useEditor(pid);
  if (!editor) return <main className="start"><p className="lead">Opening project…</p></main>;
  return <EditorView editor={editor} onClose={onClose} />;
}

export function App() {
  const [pid, setPid] = useState<string | null>(() => new URLSearchParams(location.search).get("project"));
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    setProjectInUrl(pid);
  }, [pid]);

  // A project id in the URL may be stale after the server restarts.
  useEffect(() => {
    if (!token) {
      setProblem("This page needs to be opened from the Sous Chef app, which supplies its access token.");
      return;
    }
    api
      .projects()
      .then((r) => {
        if (pid && !r.projects.some((p) => p.projectId === pid)) setPid(null);
        setChecked(true);
      })
      .catch((e) => setProblem(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (problem) return <main className="start"><h1>Sous Chef</h1><p className="error">{problem}</p></main>;
  if (!checked) return <main className="start"><p className="lead">Connecting…</p></main>;
  if (!pid) return <Start onOpen={setPid} />;
  return <Loaded key={pid} pid={pid} onClose={() => setPid(null)} />;
}
