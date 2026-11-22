import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe, type LibraryState, type PublishSettings, type TemplateSummary } from "./api";
import { desktop } from "./desktop";
import { Icon, type IconName } from "./icons";
import { clock } from "./time";
import type { Editor } from "./useEditor";

type SectionId = "timeline" | "publishing" | "memory" | "projects";
const SECTIONS: { id: SectionId; icon: IconName; title: string; blurb: string }[] = [
  { id: "timeline", icon: "layers", title: "Timeline templates", blurb: "Intros, lower thirds, layouts: pieces of a timeline to drop into any project." },
  { id: "publishing", icon: "doc", title: "Description and thumbnails", blurb: "The format and style Hermes follows in Publish." },
  { id: "memory", icon: "memory", title: "What Hermes remembers", blurb: "Notes about how you edit, carried into every project." },
  { id: "projects", icon: "clock", title: "Recent projects", blurb: "What you have worked on lately." },
];

/**
 * Everything that carries over between projects, as its own view next to Edit and Publish: timeline
 * templates, the description and thumbnail templates, Hermes's notes, and recent projects.
 */
export function Library({ editor }: { editor: Editor }) {
  const [lib, setLib] = useState<LibraryState | null>(null);
  const [active, setActive] = useState<SectionId>("timeline");
  const scroller = useRef<HTMLDivElement>(null);
  const notify = useRef(editor.notify);
  notify.current = editor.notify;
  // Stable, so it fetches once and on library changes, not on every redraw.
  const load = useCallback(() => {
    void api.library().then(setLib).catch((e) => notify.current(e instanceof Error ? e.message : String(e), "error"));
  }, []);
  useEffect(() => load(), [load]);
  useEffect(() => subscribe((e) => e.type === "library" && load(), () => {}), [load]);

  const go = (id: SectionId) => {
    setActive(id);
    scroller.current?.querySelector(`#lib-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // The section nearest the top is the one marked in the list on the left.
  const onScroll = () => {
    const box = scroller.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    let current: SectionId = SECTIONS[0]!.id;
    for (const s of SECTIONS) {
      const el = box.querySelector(`#lib-${s.id}`);
      if (el && el.getBoundingClientRect().top - top < 120) current = s.id;
    }
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1]!.id;
    setActive(current);
  };
  const count: Record<SectionId, string> = {
    timeline: lib ? String(lib.templates.length) : "",
    publishing: "",
    memory: "",
    projects: lib ? String(lib.projects.length) : "",
  };

  return (
    <section className="lib-view" aria-label="Library">
      <nav className="lib-nav" aria-label="Library sections">
        <div className="lib-nav-head">
          <h1>Library</h1>
          <p>Shared by every project</p>
        </div>
        {SECTIONS.map((s) => (
          <button key={s.id} className={active === s.id ? "on" : ""} aria-current={active === s.id ? "true" : undefined} onClick={() => go(s.id)}>
            <Icon name={s.icon} />
            <span>{s.title}</span>
            {count[s.id] && <em>{count[s.id]}</em>}
          </button>
        ))}
      </nav>
      <div className="lib-scroll" ref={scroller} onScroll={onScroll}>
        <Section id="timeline"><TimelineTemplates editor={editor} templates={lib?.templates ?? null} /></Section>
        <Section id="publishing"><PublishTemplates editor={editor} /></Section>
        <Section id="memory"><Memory editor={editor} saved={lib?.memory ?? null} /></Section>
        <Section id="projects">
          {lib && lib.projects.length === 0 && <p className="lib-empty">No projects yet.</p>}
          <ul className="lib-projects">
            {lib?.projects.slice(0, 12).map((p) => (
              <li key={p.path} className={p.path === editor.path ? "current" : ""} title={p.path}>
                <Icon name="folder" />
                <div>
                  <strong>{p.name}{p.path === editor.path && <span className="lib-tag">Open</span>}</strong>
                  <span>{when(p.lastOpened)}{p.note ? ` · ${p.note}` : ""}</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
        <div className="lib-tail" aria-hidden="true" />
      </div>
    </section>
  );
}

function Section({ id, children }: { id: SectionId; children: React.ReactNode }) {
  const s = SECTIONS.find((x) => x.id === id)!;
  return (
    <section className="lib-section" id={`lib-${id}`} aria-labelledby={`lib-${id}-h`}>
      <header>
        <span className="lib-ico"><Icon name={s.icon} size={18} /></span>
        <div>
          <h2 id={`lib-${id}-h`}>{s.title}</h2>
          <p>{s.blurb}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/** Saved stretches of timeline: save the marked stretch, drop one in at the playhead. */
function TimelineTemplates({ editor, templates }: { editor: Editor; templates: TemplateSummary[] | null }) {
  const [saving, setSaving] = useState<{ name: string; description: string } | null>(null);
  const range = editor.range ? ([Math.min(...editor.range), Math.max(...editor.range)] as [number, number]) : null;
  const save = async () => {
    if (!saving || !range || !saving.name.trim()) return;
    try {
      const t = await api.captureTemplate(editor.pid, { fromUs: range[0], toUs: range[1], name: saving.name.trim(), description: saving.description.trim() });
      editor.notify(`Saved template "${t.name}" (${t.contents})`);
      setSaving(null);
    } catch (e) {
      editor.notify(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const insert = async (id: string, name: string) => {
    try {
      const r = await api.insertTemplate(editor.pid, id, Math.round(editor.player.tlUs));
      editor.notify(r.missingFiles?.length ? `Inserted "${name}", but ${r.missingFiles.length} file(s) it uses are missing` : `Inserted "${name}" at ${clock(editor.player.tlUs)}`, r.missingFiles?.length ? "error" : "info");
    } catch (e) {
      editor.notify(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const stop = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") void save();
    if (e.key === "Escape") setSaving(null);
  };
  return (
    <>
      <div className="lib-callout">
        {saving ? (
          <div className="lib-save">
            <strong>Save {clock(range![0])}–{clock(range![1])} as a template</strong>
            <input autoFocus placeholder="Name, e.g. Chapter card" value={saving.name} onChange={(e) => setSaving({ ...saving, name: e.target.value })} onKeyDown={stop} />
            <input placeholder="When to use it (optional, Hermes reads this)" value={saving.description} onChange={(e) => setSaving({ ...saving, description: e.target.value })} onKeyDown={stop} />
            <div className="row">
              <button className="primary" disabled={!saving.name.trim()} onClick={() => void save()}>Save template</button>
              <button className="ghost" onClick={() => setSaving(null)}>Cancel</button>
            </div>
          </div>
        ) : range ? (
          <>
            <span>The stretch <strong>{clock(range[0])}–{clock(range[1])}</strong> is marked. Everything that starts inside it can be saved.</span>
            <button className="primary" onClick={() => setSaving({ name: "", description: "" })}>Save as template</button>
          </>
        ) : (
          <span>To save one, Shift-drag across a stretch on the timeline in Edit, then come back here. Hermes can save and insert templates too.</span>
        )}
      </div>
      {templates && templates.length === 0 && <p className="lib-empty">No timeline templates yet.</p>}
      <ul className="tpl-grid">
        {templates?.map((t) => (
          <li key={t.id} className="tpl-card">
            <div className="tpl-top">
              <strong>{t.name}</strong>
              <span className="tpl-len">{(t.lengthUs / 1e6).toFixed(1)} s</span>
            </div>
            {t.description && <p className="tpl-desc">{t.description}</p>}
            <div className="tpl-chips">{t.contents.split(/,\s*/).filter(Boolean).map((c) => <span key={c}>{c}</span>)}</div>
            <div className="tpl-actions">
              <button onClick={() => void insert(t.id, t.name)} title="Drop it into the open timeline at the playhead">Insert at {clock(editor.player.tlUs)}</button>
              <button className="ghost icon-only" aria-label={`Delete ${t.name}`} title="Delete" onClick={() => { if (confirm(`Delete the template "${t.name}"?`)) void api.deleteTemplate(t.id).catch(() => undefined); }}><Icon name="trash" /></button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The description format and thumbnail style every video starts from. */
function PublishTemplates({ editor }: { editor: Editor }) {
  const [s, setS] = useState<PublishSettings | null>(null);
  const [draft, setDraft] = useState<PublishSettings | null>(null);
  useEffect(() => void api.publishSettings().then((v) => { setS(v); setDraft(v); }).catch(() => undefined), []);
  if (!s || !draft) return <p className="lib-empty">Loading…</p>;
  const dirty = JSON.stringify({ ...s, fileReadable: 0 }) !== JSON.stringify({ ...draft, fileReadable: 0 });
  const set = (patch: Partial<PublishSettings>) => setDraft({ ...draft, ...patch });
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  const refs = draft.thumbnailRefs.filter((r) => r.trim());
  const save = () => void api.savePublishSettings({ ...draft, thumbnailRefs: refs.map((r) => r.trim()) }).then((v) => { setS(v); setDraft(v); editor.notify("Saved"); }).catch((e) => editor.notify(e.message, "error"));
  const usingFile = Boolean(draft.descriptionTemplateFile.trim());
  return (
    <>
      <div className="lib-cards">
        <div className="lib-card">
          <h3><Icon name="doc" /> Description</h3>
          <label className="lib-field">
            <span>Format file <em>read fresh every time, so you can keep it in your own notes</em></span>
            <input value={draft.descriptionTemplateFile} placeholder="Path to a text file with your format" onChange={(e) => set({ descriptionTemplateFile: e.target.value })} onKeyDown={stop} />
            {s.descriptionTemplateFile && !s.fileReadable && <span className="over small">That file can't be read; the format written below is used.</span>}
          </label>
          <label className="lib-field grow">
            <span>{usingFile ? "Fallback, if the file can't be read" : "Or write the format here"}</span>
            <textarea rows={12} value={draft.descriptionTemplate} placeholder={"Hook line\n\nWhat you'll learn…\n\nLinks\n\nChapters\n\n#hashtags"} onChange={(e) => set({ descriptionTemplate: e.target.value })} onKeyDown={stop} />
          </label>
        </div>
        <div className="lib-card">
          <h3><Icon name="image" /> Thumbnails</h3>
          <label className="lib-field grow">
            <span>Style</span>
            <textarea rows={7} value={draft.thumbnailStyle} placeholder="Layout, fonts, colours, where your face or mascot goes, rules…" onChange={(e) => set({ thumbnailStyle: e.target.value })} onKeyDown={stop} />
          </label>
          <div className="lib-field">
            <span>Reference pictures <em>Hermes looks at these for the look</em></span>
            <ul className="lib-refs">
              {refs.map((r, i) => (
                <li key={r + i} title={r}>
                  <Icon name="image" size={14} />
                  <span className="ref-name">{r.split(/[\\/]/).pop()}</span>
                  <span className="ref-dir">{r.replace(/[\\/][^\\/]*$/, "")}</span>
                  <button className="ghost icon-only" aria-label="Remove" onClick={() => set({ thumbnailRefs: refs.filter((_, j) => j !== i) })}>×</button>
                </li>
              ))}
              {refs.length === 0 && <li className="dim">None yet.</li>}
            </ul>
            <div className="row">
              {desktop && <button onClick={() => void desktop!.pickMedia().then((paths) => paths.length && set({ thumbnailRefs: [...refs, ...paths] }))}>Add pictures…</button>}
              <input className="grow" placeholder="…or paste a path and press Enter" onKeyDown={(e) => {
                e.stopPropagation();
                const v = (e.target as HTMLInputElement).value.trim().replace(/^"|"$/g, "");
                if (e.key === "Enter" && v) { set({ thumbnailRefs: [...refs, v] }); (e.target as HTMLInputElement).value = ""; }
              }} />
            </div>
          </div>
          <label className="lib-field">
            <span>Channel name <em>for the YouTube preview in Publish</em></span>
            <input value={draft.channelName} onChange={(e) => set({ channelName: e.target.value })} onKeyDown={stop} />
          </label>
        </div>
      </div>
      {dirty && (
        <div className="lib-savebar">
          <span>Unsaved changes to the description and thumbnail templates</span>
          <button className="ghost" onClick={() => setDraft(s)}>Discard</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      )}
    </>
  );
}

function Memory({ editor, saved }: { editor: Editor; saved: string | null }) {
  const [memory, setMemory] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty && saved !== null) setMemory(saved);
  }, [saved, dirty]);
  return (
    <div className="lib-card wide">
      <textarea
        className="memory" rows={12} value={memory} placeholder="Nothing yet. Hermes adds to this as it learns your style. Edit anything that is wrong."
        onChange={(e) => { setMemory(e.target.value); setDirty(true); }} onKeyDown={(e) => e.stopPropagation()}
      />
      <div className="row">
        <span className="dim small grow">Hermes reads these at the start of every chat.</span>
        {dirty && <button className="ghost" onClick={() => { setDirty(false); setMemory(saved ?? ""); }}>Discard</button>}
        <button className="primary" disabled={!dirty} onClick={() => void api.saveMemory(memory).then(() => { setDirty(false); editor.notify("Saved"); }).catch((e) => editor.notify(e.message, "error"))}>Save notes</button>
      </div>
    </div>
  );
}
