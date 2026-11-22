import type { Pacing } from "@sous-chef/core";
import { api } from "./api";
import { clock } from "./time";
import type { Editor } from "./useEditor";

export interface PaceChoice {
  longS: number;
  keepS: number;
}

const LONG = [0.7, 1, 1.5, 2, 3];
const KEEP = [0.2, 0.3, 0.5, 0.8];

/**
 * Pauses still in the edit and how fast each stretch moves. Long pauses are
 * also outlined in the transcript while this is open.
 */
export function PacingPanel({ editor, pace, choice, setChoice }: { editor: Editor; pace: Pacing; choice: PaceChoice; setChoice: (c: PaceChoice) => void }) {
  const { player } = editor;
  const n = pace.pauses.length;
  const top = Math.max(1, ...pace.windows.map((w) => w.wpm));
  const tighten = () => {
    if (!pace.tighten.length) return;
    void editor.run(`Tighten ${pace.tighten.length} pause${pace.tighten.length === 1 ? "" : "s"} to ${choice.keepS} s`, pace.tighten.flatMap((s) => s.ops));
  };
  const review = () => {
    if (!pace.tighten.length) return;
    void api
      .proposalCreate(editor.pid, {
        by: "user",
        summary: `Tighten pauses over ${choice.longS} s to ${choice.keepS} s`,
        items: pace.tighten.map((s) => ({ kind: "silence", label: s.label, ops: s.ops, savedUs: s.savedUs, clipId: s.clipId, mediaId: s.mediaId, atUs: s.atUs })),
      })
      .catch(() => undefined);
  };
  const slow = pace.windows.filter((w) => w.slow);
  return (
    <div className="pacing">
      <div className="pacing-row">
        <label>
          Pauses over{" "}
          <select value={String(choice.longS)} onChange={(e) => setChoice({ ...choice, longS: Number(e.target.value) })}>
            {LONG.map((v) => <option key={v} value={String(v)}>{v} s</option>)}
          </select>
        </label>
        <label>
          leave{" "}
          <select value={String(choice.keepS)} onChange={(e) => setChoice({ ...choice, keepS: Number(e.target.value) })}>
            {KEEP.map((v) => <option key={v} value={String(v)}>{v} s</option>)}
          </select>
        </label>
      </div>
      <p className="small">
        {n === 0 ? `No pauses over ${choice.longS} s left.` : `${n} pause${n === 1 ? "" : "s"} over ${choice.longS} s, ${clock(pace.longUs, 1)} in all.`}
        {pace.tighten.length > 0 && ` Tightening saves ${clock(pace.tightenSavesUs, 1)}.`}
        {pace.medianWpm > 0 && <span className="dim"> Usual pace {Math.round(pace.medianWpm)} words a minute.</span>}
      </p>
      <div className="pacing-row">
        <button className="primary" onClick={tighten} disabled={!pace.tighten.length} title="Cut every long pause down to what is left, as one edit (undo brings them all back)">Tighten all</button>
        <button onClick={review} disabled={!pace.tighten.length} title="Put the cuts up for review, to accept or skip one at a time">Review one by one</button>
      </div>
      <div className="pace-strip" title="Words a minute through the video. Highlighted stretches are slow: little said for a while. Click to jump there.">
        {pace.windows.map((w) => (
          <i
            key={w.tlStartUs}
            className={w.slow ? "slow" : undefined}
            style={{ flexGrow: w.tlEndUs - w.tlStartUs, height: `${Math.max(6, (w.wpm / top) * 100)}%` }}
            title={`${clock(w.tlStartUs, 0)}–${clock(w.tlEndUs, 0)}: ${Math.round(w.wpm)} words a minute${w.pauseUs > 1e6 ? `, ${(w.pauseUs / 1e6).toFixed(1)} s of pauses` : ""}`}
            onClick={() => player.seek(w.tlStartUs)}
          />
        ))}
      </div>
      {slow.length > 0 && (
        <p className="small dim">
          Slow:{" "}
          {slow.slice(0, 8).map((w, i) => (
            <button key={w.tlStartUs} className="link" onClick={() => player.seek(w.tlStartUs)}>{i ? ", " : ""}{clock(w.tlStartUs, 0)}</button>
          ))}
          {slow.length > 8 ? ` and ${slow.length - 8} more` : ""}
        </p>
      )}
      {n > 0 && (
        <p className="small pace-list">
          {pace.pauses.slice(0, 40).map((p) => (
            <button key={p.index} className="link" onClick={() => player.seek(p.tlUs)} title="Jump there">
              {clock(p.tlUs, 0)} <span className="dim">({(p.heardUs / 1e6).toFixed(1)} s)</span>
            </button>
          ))}
          {n > 40 ? <span className="dim"> and {n - 40} more</span> : null}
        </p>
      )}
    </div>
  );
}
