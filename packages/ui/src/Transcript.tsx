import { itemAt, pacing, proposedRanges, removeItemsOps, restoreItemsOps, searchSequence, sourceToTimeline, timelineToSource, type SeqItem } from "@sous-chef/core";
import { ProposalBar } from "./ProposalBar";
import { PacingPanel, type PaceChoice } from "./Pacing";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { baseName, clock } from "./time";
import type { Editor } from "./useEditor";

/** One word or pause. Memoised: a transcript is thousands of these. */
const Item = memo(function Item({ item, index, selected, hit, proposed, long }: { item: SeqItem; index: number; selected: boolean; hit: boolean; proposed: boolean; long?: boolean }) {
  const cls =
    (item.kind === "pause" ? "pause" : "word") +
    (item.removed ? " removed" : "") +
    (selected ? " selected" : "") +
    (hit ? " hit" : "") +
    (proposed && !item.removed ? " proposed" : "") +
    (item.fixed ? " fixed" : "") +
    (item.lowConfidence ? " unsure" : "") +
    (item.silent ? " silent" : "") +
    (long ? " long" : "");
  return (
    <span className={cls} data-i={index} title={item.kind === "pause" ? `Pause of ${item.text}` : item.removed ? "Removed" : undefined}>
      {item.kind === "pause" ? `· ${item.text} ·` : item.text}
    </span>
  );
});

export function Transcript({ editor }: { editor: Editor }) {
  const { seq, plan, project, player, jobs } = editor;
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [query, setQuery] = useState("");
  const [hitIndex, setHitIndex] = useState(0);
  const [fixing, setFixing] = useState<number | null>(null);
  const [fixText, setFixText] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  const dragging = useRef(false);
  const current = useRef<HTMLElement | null>(null);

  const lo = sel ? Math.min(sel[0], sel[1]) : -1;
  const hi = sel ? Math.max(sel[0], sel[1]) : -1;
  const hits = useMemo(() => searchSequence(seq, query), [seq, query]);
  const hitSet = useMemo(() => {
    const s = new Set<number>();
    for (const [a, b] of hits) for (let i = a; i <= b; i++) s.add(i);
    return s;
  }, [hits]);

  // The pacing view: computed only while it is open.
  const [paceOpen, setPaceOpen] = useState(false);
  const [paceChoice, setPaceChoice] = useState<PaceChoice>({ longS: 1, keepS: 0.5 });
  const pace = useMemo(
    () => (paceOpen && seq.length ? pacing(project, editor.transcripts, { longUs: paceChoice.longS * 1e6, keepUs: paceChoice.keepS * 1e6 }, { plan, seq }) : null),
    [paceOpen, project, editor.transcripts, plan, seq, paceChoice],
  );
  const longSet = useMemo(() => new Set(pace?.pauses.map((p) => p.index) ?? []), [pace]);

  // Words and pauses a pending suggestion would remove, shown ghosted.
  const proposedSet = useMemo(() => {
    const out = new Set<number>();
    if (!editor.proposals.length) return out;
    const ranges = proposedRanges(editor.proposals, editor.skipped);
    seq.forEach((it, i) => {
      const list = ranges.get(it.clipId);
      if (!list) return;
      const mid = (it.startUs + it.endUs) / 2;
      // A trimmed silence keeps a little of the pause, so it counts when most of it goes.
      if (list.some((r) => (it.kind === "pause" ? r.startUs < it.endUs && r.endUs > it.startUs && r.kind === "silence" : mid >= r.startUs && mid < r.endUs))) out.add(i);
    });
    return out;
  }, [seq, editor.proposals, editor.skipped]);

  // A selection made against an older transcript may point past the end.
  useEffect(() => {
    if (sel && Math.max(sel[0], sel[1]) >= seq.length) setSel(null);
  }, [seq, sel]);

  // Follow the playhead without re-rendering: move one class between two elements.
  useEffect(() => {
    const mark = () => {
      const hit = timelineToSource(plan, player.tlUs);
      const i = hit ? itemAt(seq, hit.segment.clipId, hit.srcUs) : -1;
      const el = i >= 0 ? body.current?.querySelector<HTMLElement>(`[data-i="${i}"]`) ?? null : null;
      if (el === current.current) return;
      current.current?.classList.remove("now");
      el?.classList.add("now");
      current.current = el;
      if (el && player.playing) {
        const box = body.current!;
        const top = el.offsetTop - box.offsetTop;
        if (top < box.scrollTop + 20 || top > box.scrollTop + box.clientHeight - 60) box.scrollTop = Math.max(0, top - box.clientHeight / 3);
      }
    };
    current.current = null;
    mark();
    return player.subscribe(mark);
  }, [seq, plan, player]);

  const seekTo = useCallback(
    (i: number) => {
      // A removed word does not play; go to the next thing that does.
      for (let k = i; k < seq.length; k++) {
        const it = seq[k]!;
        if (it.removed) continue;
        const tl = it.voice ? it.tlStartUs! : sourceToTimeline(plan, it.mediaId, it.startUs + 1000);
        if (tl !== null) {
          player.pause();
          player.seek(tl);
          return;
        }
      }
    },
    [seq, plan, player],
  );

  const indexOf = (target: EventTarget | null): number | null => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>("[data-i]");
    return el ? Number(el.dataset.i) : null;
  };

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || fixing !== null) return;
    const i = indexOf(e.target);
    if (i === null) {
      setSel(null);
      return;
    }
    e.preventDefault();
    body.current?.focus();
    if (e.shiftKey && anchor.current !== null) setSel([anchor.current, i]);
    else {
      anchor.current = i;
      setSel([i, i]);
      seekTo(i);
    }
    dragging.current = true;
  };
  const onMove = (e: React.MouseEvent) => {
    if (!dragging.current || anchor.current === null) return;
    const i = indexOf(e.target);
    if (i !== null) setSel((s) => (s && s[1] === i ? s : [anchor.current!, i]));
  };
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const picked = sel ? seq.slice(lo, hi + 1) : [];
  const anyKept = picked.some((i) => !i.removed);
  const anyRemoved = picked.some((i) => i.removed);
  const describe = () => {
    const words = picked.filter((i) => i.kind === "word").map((i) => i.text);
    if (!words.length) return "a pause";
    const text = words.length <= 6 ? words.join(" ") : `${words.slice(0, 3).join(" ")} … ${words.slice(-2).join(" ")}`;
    return `"${text}"`;
  };

  const remove = useCallback(() => {
    if (!sel) return;
    const ops = removeItemsOps(project, seq, lo, hi);
    if (ops.length) void editor.run(`Delete ${describe()}`, ops);
    else if (picked.some((i) => i.voice)) editor.notify("Voiceover words can be fixed but not cut here. Trim or split the voiceover clip on the timeline.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, project, seq, lo, hi, editor]);

  const restore = useCallback(() => {
    if (!sel) return;
    const ops = restoreItemsOps(project, seq, lo, hi);
    if (ops.length) void editor.run(`Restore ${describe()}`, ops);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, project, seq, lo, hi, editor]);

  const startFix = (i: number) => {
    if (seq[i]?.kind !== "word") return;
    setFixing(i);
    setFixText(seq[i]!.text);
  };
  const commitFix = () => {
    const it = fixing !== null ? seq[fixing] : null;
    setFixing(null);
    if (!it?.wordId) return;
    const text = fixText.trim();
    if (text === it.text) return;
    void editor.run(text ? `Fix "${it.text}" to "${text}"` : `Clear the fix on "${it.text}"`, [{ op: "word.fix", mediaId: it.mediaId, wordId: it.wordId, text: text || null }]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (fixing !== null) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      if (anyKept) remove();
      else if (anyRemoved) restore();
    } else if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.metaKey && sel) {
      e.preventDefault();
      e.stopPropagation();
      restore();
    } else if (e.key === "Enter" && sel && lo === hi) {
      e.preventDefault();
      startFix(lo);
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && sel) {
      e.preventDefault();
      e.stopPropagation();
      const next = Math.max(0, Math.min(seq.length - 1, sel[1] + (e.key === "ArrowLeft" ? -1 : 1)));
      if (e.shiftKey) setSel([sel[0], next]);
      else {
        anchor.current = next;
        setSel([next, next]);
        seekTo(next);
      }
    } else if (e.key === "Escape") {
      setSel(null);
    }
  };

  const gotoHit = (n: number) => {
    if (!hits.length) return;
    const k = ((n % hits.length) + hits.length) % hits.length;
    setHitIndex(k);
    const [a, b] = hits[k]!;
    anchor.current = a;
    setSel([a, b]);
    seekTo(a);
    body.current?.querySelector(`[data-i="${a}"]`)?.scrollIntoView({ block: "center" });
  };

  const job = jobs.find((j) => j.kind === "transcribe" || j.kind === "roughcut");
  const missing = editor.clips.filter((c) => !editor.transcripts[c.mediaId]).map((c) => c.mediaId);
  const missingIds = [...new Set(missing)];
  const removedUs = useMemo(() => {
    let us = 0;
    for (const c of editor.clips) for (const r of c.removed) us += r.endUs - r.startUs;
    return us;
  }, [editor.clips]);

  // Group items by clip so each take gets a heading.
  const groups = useMemo(() => {
    const out: { clipId: string; start: number; end: number }[] = [];
    seq.forEach((it, i) => {
      const last = out[out.length - 1];
      if (last && last.clipId === it.clipId) last.end = i;
      else out.push({ clipId: it.clipId, start: i, end: i });
    });
    return out;
  }, [seq]);

  return (
    <div className="transcript">
      <div className="transcript-tools">
        <input
          type="search" placeholder="Search the transcript" value={query}
          onChange={(e) => { setQuery(e.target.value); setHitIndex(0); }}
          onKeyDown={(e) => { if (e.key === "Enter") gotoHit(e.shiftKey ? hitIndex - 1 : hits.length && sel && lo === hits[hitIndex]?.[0] ? hitIndex + 1 : hitIndex); }}
        />
        {query && <span className="dim count">{hits.length ? `${Math.min(hitIndex + 1, hits.length)} of ${hits.length}` : "none"}</span>}
      </div>
      <div className="transcript-actions">
        <button onClick={remove} disabled={!anyKept} title="Delete the selected words from the video (Delete)">Delete</button>
        <button onClick={restore} disabled={!anyRemoved} title="Bring the selected words back (R)">Restore</button>
        <button onClick={() => sel && startFix(lo)} disabled={!sel || lo !== hi || seq[lo]?.kind !== "word"} title="Correct a misheard word (Enter). Timing is not changed.">Fix word</button>
        <span className="grow" />
        {removedUs > 0 && <span className="dim">{clock(removedUs, 0)} cut</span>}
        <button className={paceOpen ? "on" : undefined} onClick={() => setPaceOpen((v) => !v)} disabled={seq.length === 0} title="Long pauses still in the edit and how fast each stretch moves">
          Pacing
        </button>
        <button
          onClick={() => void editor.roughCut()}
          disabled={seq.length === 0 || jobs.some((j) => j.kind === "roughcut")}
          title="Suggest cuts for flubbed lines (the first try of a line you said again), filler words and long silences, and zooms. Hermes reads the transcript, so it takes a minute. Nothing changes until you accept."
        >
          Rough cut
        </button>
      </div>
      {pace && <PacingPanel editor={editor} pace={pace} choice={paceChoice} setChoice={setPaceChoice} />}
      {editor.proposals.map((p) => <ProposalBar key={p.id} editor={editor} proposal={p} />)}
      {job && (
        <div className="job">
          <div className="bar"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
          <span className="dim">{job.message || job.label}</span>
        </div>
      )}
      {!job && missingIds.length > 0 && (
        <div className="job">
          {editor.canTranscribe ? (
            <button className="primary" onClick={() => void editor.transcribe(missingIds)}>
              Transcribe {missingIds.length === 1 ? "this take" : `${missingIds.length} takes`}
            </button>
          ) : (
            <span className="dim">Transcription is not set up on this computer. See sidecar/README.md in the app folder.</span>
          )}
        </div>
      )}
      {!job && missingIds.length === 0 && editor.canTranscribe && Object.keys(editor.transcripts).length > 0 && (
        <div className="job redo">
          <button
            className="ghost small"
            title="Transcribe the takes on the timeline again. Newer transcription writes down um and uh so they can be cut. Cuts stay where they are; corrected words may need fixing again."
            onClick={() => {
              const ids = [...new Set(editor.clips.map((c) => c.mediaId))];
              if (confirm("Transcribe the takes on the timeline again? Cuts stay where they are; words you corrected may need correcting again.")) void editor.transcribe(ids, true);
            }}
          >
            Transcribe again
          </button>
        </div>
      )}
      <div className="transcript-body" ref={body} tabIndex={0} onMouseDown={onDown} onMouseMove={onMove} onDoubleClick={(e) => { const i = indexOf(e.target); if (i !== null) startFix(i); }} onKeyDown={onKey}>
        {editor.clips.length === 0 && <p className="empty">Add a take to the timeline, then transcribe it to edit by deleting words.</p>}
        {groups.map((g) => {
          const clip = project.items[g.clipId];
          const media = clip && clip.type === "clip" ? project.media.find((m) => m.id === clip.mediaId) : null;
          return (
            <section key={g.clipId} className="take">
              <h4>{seq[g.start]?.voice ? "Voiceover · " : ""}{media ? baseName(media.path) : g.clipId}{seq[g.start]?.silent ? " · muted" : ""}</h4>
              <p>
                {seq.slice(g.start, g.end + 1).map((item, k) => {
                  const i = g.start + k;
                  if (fixing === i) {
                    return (
                      <input
                        key={i} className="fix" autoFocus value={fixText} size={Math.max(4, fixText.length + 1)}
                        onChange={(e) => setFixText(e.target.value)} onBlur={commitFix}
                        onMouseDown={(e) => e.stopPropagation()}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commitFix(); if (e.key === "Escape") setFixing(null); }}
                      />
                    );
                  }
                  return <Item key={i} item={item} index={i} selected={i >= lo && i <= hi} hit={hitSet.has(i)} proposed={proposedSet.has(i)} long={longSet.has(i)} />;
                })}
              </p>
            </section>
          );
        })}
      </div>
      <p className="transcript-hint dim">Click a word to jump there. Drag or Shift-click to select, Delete to cut, R to restore, double-click to fix a word.</p>
    </div>
  );
}
