import { clipSourceToTimeline, sourceToTimeline, type Proposal, type Suggestion } from "@sous-chef/core";
import { useState } from "react";
import { clock } from "./time";
import type { Editor } from "./useEditor";

const NAMES: Record<string, [string, string]> = {
  silence: ["Silences", "silence"],
  filler: ["Filler words", "filler"],
  retake: ["Flubbed lines", "flubbed line"],
  zoom: ["Zooms", "zoom"],
  other: ["Other edits", "edit"],
};

/** A set of suggested edits with everything needed to say yes, no, or yes to part of it. */
export function ProposalBar({ editor, proposal }: { editor: Editor; proposal: Proposal }) {
  const [open, setOpen] = useState<string | null>(null);
  const { skipped } = editor;
  const kinds = Object.keys(NAMES).filter((k) => proposal.items.some((i) => i.kind === k));
  const on = proposal.items.filter((i) => !skipped.has(i.id));
  const saved = on.reduce((s, i) => s + i.savedUs, 0);

  const setMany = (items: Suggestion[], keep: boolean) => {
    const next = new Set(skipped);
    for (const i of items) keep ? next.delete(i.id) : next.add(i.id);
    editor.setSkipped(next);
  };
  const jump = (item: Suggestion) => {
    if (!item.mediaId || item.atUs === undefined) return;
    const tl = (item.clipId ? clipSourceToTimeline(editor.plan, item.clipId, item.atUs + 1000) : null) ?? sourceToTimeline(editor.plan, item.mediaId, item.atUs + 1000);
    if (tl !== null) {
      editor.player.pause();
      editor.player.seek(Math.max(0, tl - 1_000_000));
    }
  };

  return (
    <div className="proposal" role="region" aria-label="Suggested edits">
      <div className="proposal-head">
        <strong>{proposal.by === "agent" ? "Hermes suggests" : /^Tighten/.test(proposal.summary) ? proposal.summary : proposal.summary.startsWith("Auto zoom") ? "Suggested zooms" : "Suggested rough cut"}</strong>
        <span className="dim">{proposal.items.length} change{proposal.items.length === 1 ? "" : "s"}{saved > 0 ? ` · ${clock(saved, 0)} shorter` : ""}</span>
      </div>
      {kinds.map((kind) => {
        const items = proposal.items.filter((i) => i.kind === kind);
        const kept = items.filter((i) => !skipped.has(i.id)).length;
        return (
          <div key={kind} className="proposal-group">
            <label>
              <input type="checkbox" checked={kept > 0} ref={(el) => { if (el) el.indeterminate = kept > 0 && kept < items.length; }} onChange={(e) => setMany(items, e.target.checked)} />
              <span>{NAMES[kind]![0]}</span>
              <span className="dim">{kept} of {items.length}</span>
            </label>
            <button className="ghost" onClick={() => setOpen(open === kind ? null : kind)} aria-expanded={open === kind}>{open === kind ? "Hide" : "Show"}</button>
            {open === kind && (
              <ul>
                {items.map((item) => (
                  <li key={item.id}>
                    <input type="checkbox" checked={!skipped.has(item.id)} onChange={(e) => setMany([item], e.target.checked)} aria-label={item.label} />
                    <button className="ghost item" onClick={() => jump(item)} title="Jump to just before this">{item.label}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <div className="row">
        <button className="primary" disabled={on.length === 0} onClick={() => void editor.acceptProposal(proposal)}>
          {on.length === proposal.items.length ? "Accept all" : `Accept ${on.length}`}
        </button>
        <button onClick={() => void editor.rejectProposal(proposal)}>Reject</button>
      </div>
    </div>
  );
}
