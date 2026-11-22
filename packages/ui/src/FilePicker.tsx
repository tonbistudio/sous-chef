import { useEffect, useState } from "react";
import { api, type DirEntry, type DirListing } from "./api";
import { local } from "./storage";
import { bytes } from "./time";

interface Props {
  /** "files": pick media files. "project": pick or create a project folder. */
  mode: "files" | "project";
  title: string;
  onCancel: () => void;
  onFiles?: (paths: string[]) => void;
  onProject?: (path: string, create: boolean) => void;
}

const LAST_DIR = "sous.lastDir";

export function FilePicker({ mode, title, onCancel, onFiles, onProject }: Props) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [pathText, setPathText] = useState("");
  const [name, setName] = useState("");

  const go = (dir: string) => {
    setError("");
    api
      .list(dir)
      .then((l) => {
        setListing(l);
        setPathText(l.dir);
        setPicked([]);
        if (l.dir) local.set(LAST_DIR + "." + mode, l.dir);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    const last = local.get(LAST_DIR + "." + mode);
    // Projects start in the projects folder from preferences the first time.
    const first = last ? Promise.resolve(last) : mode === "files" ? Promise.resolve("") : api.preferences().then((p) => p.projectsFolder, () => "");
    first
      .then((dir) => api.list(dir))
      .then((l) => {
        setListing(l);
        setPathText(l.dir);
      })
      .catch(() => go(""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const click = (entry: DirEntry) => {
    if (entry.type === "dir") go(entry.path);
    else if (entry.type === "project") {
      if (mode === "project") onProject?.(entry.path, false);
      else go(entry.path);
    } else if (mode === "files") {
      setPicked((p) => (p.includes(entry.path) ? p.filter((x) => x !== entry.path) : [...p, entry.path]));
    }
  };

  const cleanName = name.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\.(sous|aigedit|cutroom)$/i, "");
  const files = listing?.entries.filter((e) => e.type === "file") ?? [];

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="modal picker" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="ghost" onClick={onCancel} aria-label="Close">✕</button>
        </header>
        <form
          className="pathbar"
          onSubmit={(e) => {
            e.preventDefault();
            go(pathText.trim());
          }}
        >
          <button type="button" disabled={listing?.parent == null} onClick={() => go(listing?.parent ?? "")}>Up</button>
          <input value={pathText} onChange={(e) => setPathText(e.target.value)} placeholder="Type or paste a folder path" spellCheck={false} />
          <button type="submit">Go</button>
        </form>
        {error && <p className="error">{error}</p>}
        <ul className="entries">
          {listing?.entries.map((entry) => (
            <li key={entry.path}>
              <button
                className={"entry " + entry.type + (picked.includes(entry.path) ? " picked" : "")}
                disabled={mode === "project" && entry.type === "file"}
                onClick={() => click(entry)}
                onDoubleClick={() => entry.type === "file" && mode === "files" && onFiles?.([entry.path])}
              >
                <span className="kind">{entry.type === "dir" ? "Folder" : entry.type === "project" ? "Project" : "Media"}</span>
                <span className="name">{entry.name}</span>
                {entry.type === "file" && (
                  <span className="meta">
                    {entry.mtimeMs ? new Date(entry.mtimeMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) + " · " : ""}
                    {bytes(entry.size ?? 0)}
                  </span>
                )}
              </button>
            </li>
          ))}
          {listing && listing.entries.length === 0 && <li className="empty">Nothing to show in this folder.</li>}
        </ul>
        <footer>
          {mode === "files" ? (
            <>
              <button
                className="ghost"
                disabled={files.length === 0}
                onClick={() => setPicked(picked.length === files.length ? [] : files.map((f) => f.path))}
              >
                {picked.length === files.length && files.length > 0 ? "Select none" : "Select all"}
              </button>
              <span className="grow">{picked.length} selected</span>
              <button onClick={onCancel}>Cancel</button>
              <button className="primary" disabled={picked.length === 0} onClick={() => onFiles?.(picked)}>
                Import {picked.length || ""}
              </button>
            </>
          ) : (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" className="grow" />
              <button
                className="primary"
                disabled={!cleanName || !listing?.dir}
                onClick={() => onProject?.(`${listing!.dir.replace(/\/$/, "")}/${cleanName}.sous`, true)}
              >
                Create here
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
