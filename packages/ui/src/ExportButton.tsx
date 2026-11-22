import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { api, type ExportJob } from "./api";
import { bytes, clock } from "./time";
import type { Editor } from "./useEditor";

/** Starts an export and shows its progress. The export runs in the edit server, so closing this window does not stop it. */
export function ExportButton({ editor }: { editor: Editor }) {
  const [job, setJob] = useState<ExportJob | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number>();
  const { pid } = editor;

  // Pick up an export that is already running, e.g. one Hermes started.
  useEffect(() => {
    api.exportList(pid).then((r) => {
      const running = r.jobs.find((j) => j.state === "running");
      if (running) {
        setJob(running);
        setOpen(true);
      }
    }).catch(() => undefined);
  }, [pid]);

  useEffect(() => {
    if (job?.state !== "running") return;
    timer.current = window.setInterval(() => {
      api.exportStatus(pid, job.id).then(setJob).catch(() => undefined);
    }, 500);
    return () => window.clearInterval(timer.current);
  }, [pid, job?.id, job?.state]);

  const start = () => {
    setOpen(true);
    api.exportStart(pid).then(setJob).catch((e) => editor.notify(e instanceof Error ? e.message : String(e), "error"));
  };

  const running = job?.state === "running";
  const took = job?.finishedAt ? (job.finishedAt - job.startedAt) / 1000 : 0;
  return (
    <>
      <button className="primary with-icon" onClick={running ? () => setOpen(true) : start} disabled={editor.plan.durationUs === 0} title="Export the timeline as a video file">
        <Icon name="export" />{running ? `Exporting ${Math.round(job.progress * 100)}%` : "Export"}
      </button>
      {open && job && (
        <div className="overlay" onClick={() => !running && setOpen(false)}>
          <div className="modal export" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>{running ? "Exporting" : job.state === "done" ? "Export finished" : job.state === "cancelled" ? "Export cancelled" : "Export failed"}</h2>
            </header>
            <div className="export-body">
              <div className="bar"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
              <p className="dim">{clock(job.durationUs, 0)} of video · revision {job.revision} · {job.encoder === "h264_nvenc" ? "graphics card" : "processor"} encoding</p>
              {job.state === "done" && (
                <p>
                  Saved to <span className="path">{job.outPath}</span>
                  <span className="dim"> · {bytes(job.sizeBytes ?? 0)} · took {took.toFixed(1)} s ({(job.speed ?? 0).toFixed(1)}× real time)</span>
                </p>
              )}
              {job.state === "done" && job.loudnessLufs !== undefined && (
                <p className="dim">
                  Loudness {job.loudnessLufs} LUFS
                  {job.targetLufs !== undefined ? ` (levelled to ${job.targetLufs})` : job.loudnessLufs < -18 ? " — quieter than YouTube's −14. Turn on “Level the loudness on export” in the project settings to bring it up." : ""}
                </p>
              )}
              {job.state === "failed" && <p className="error">{job.error}</p>}
              {running && <p className="dim">This keeps going if you close the window. Later edits are not included.</p>}
            </div>
            <footer>
              <span className="grow" />
              {running ? (
                <>
                  <button onClick={() => void api.exportCancel(pid, job.id).then(setJob)}>Cancel export</button>
                  <button className="primary" onClick={() => setOpen(false)}>Hide</button>
                </>
              ) : (
                <button className="primary" onClick={() => setOpen(false)}>Close</button>
              )}
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
