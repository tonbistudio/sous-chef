import { sourceToTimeline, type OverlaySpan, type Plan } from "./compile.js";
import { fillSettings } from "./project.js";
import { sequence, type Transcripts } from "./transcript.js";
import type { Project, Settings, Us } from "./types.js";

/**
 * Captions are worked out from the words that survive the cuts, with word
 * fixes applied. They are never stored: change the edit and they follow.
 */
export interface Cue {
  startUs: Us;
  endUs: Us;
  text: string;
}

const MAX_CHARS = 46;
/** A pause this long always starts a new caption. */
const BREAK_GAP_US = 700_000;
/** How long a caption lingers after its last word, if nothing follows. */
const LINGER_US = 250_000;
const MIN_US = 600_000;

export function captionSettings(project: Project): Settings["captions"] {
  return fillSettings({ ...project, settings: JSON.parse(JSON.stringify(project.settings)) } as Project).settings.captions;
}

/** Caption cues in timeline time. */
export function captionCues(project: Project, transcripts: Transcripts, plan: Plan): Cue[] {
  const style = captionSettings(project);
  const maxWords = Math.max(1, Math.min(20, Math.round(style.maxWords)));
  const words: { text: string; a: Us; b: Us; clipId: string }[] = [];
  const seq = sequence(project, transcripts, { voice: true });
  // While a voiceover speaks, it is the narration: the take underneath gets no captions there.
  const spoken: [Us, Us][] = [];
  for (const it of seq) {
    if (!it.voice) continue;
    const last = spoken[spoken.length - 1];
    if (last && it.tlStartUs! - last[1] < BREAK_GAP_US) last[1] = Math.max(last[1], it.tlEndUs!);
    else spoken.push([it.tlStartUs!, it.tlEndUs!]);
  }
  for (const it of seq) {
    if (it.kind !== "word" || it.removed || it.silent) continue;
    if (it.voice) {
      words.push({ text: it.text, a: it.tlStartUs!, b: Math.max(it.tlStartUs! + 1000, it.tlEndUs!), clipId: it.clipId });
      continue;
    }
    const a = sourceToTimeline(plan, it.mediaId, it.startUs);
    const b = sourceToTimeline(plan, it.mediaId, Math.max(it.startUs, it.endUs - 1000));
    // A word clipped by a cut's breathing room may have no place on the timeline.
    if (a === null && b === null) continue;
    const start = a ?? b!;
    if (spoken.some(([from, to]) => start >= from && start < to)) continue;
    words.push({ text: it.text, a: start, b: Math.max(start + 1000, b ?? start), clipId: it.clipId });
  }
  words.sort((p, q) => p.a - q.a);

  const cues: Cue[] = [];
  let cur: typeof words = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.text).join(" ");
    cues.push({ startUs: cur[0]!.a, endUs: cur[cur.length - 1]!.b, text: style.uppercase ? text.toUpperCase() : text });
    cur = [];
  };
  for (const w of words) {
    const last = cur[cur.length - 1];
    if (last) {
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      const sentenceEnd = /[.!?]["')\]]?$/.test(last.text) && cur.length >= 3;
      if (w.a - last.b > BREAK_GAP_US || w.clipId !== last.clipId || cur.length >= maxWords || chars > MAX_CHARS || sentenceEnd) flush();
    }
    cur.push(w);
  }
  flush();
  // Hold each caption a moment, but never into the next one or past the end.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const limit = i + 1 < cues.length ? cues[i + 1]!.startUs : plan.durationUs;
    c.endUs = Math.min(limit, Math.max(c.endUs + LINGER_US, c.startUs + MIN_US));
    if (c.endUs <= c.startUs) c.endUs = Math.min(limit, c.startUs + 1000);
  }
  return cues.filter((c) => c.endUs > c.startUs);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function stamp(us: Us, sep: string, digits: number): string {
  const ms = Math.round(us / 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = digits === 3 ? pad(ms % 1000, 3) : pad(Math.floor((ms % 1000) / 10), 2);
  return `${digits === 3 ? pad(h) : h}:${pad(m)}:${pad(s)}${sep}${frac}`;
}

/** The cues as an SRT subtitle file. */
export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.startUs, ",", 3)} --> ${stamp(c.endUs, ",", 3)}\n${c.text}\n`).join("\n");
}

const assColor = (hex: string, alpha = 0) => `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
const assText = (t: string) => t.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");

/**
 * Captions and text overlays as one ASS subtitle file, which ffmpeg burns into
 * the picture. Times can be shifted and clipped so one part of a long export
 * gets only what falls inside it. Pass null for the caption style to leave
 * captions out.
 */
export function toAss(
  cues: Cue[],
  style: Settings["captions"] | null,
  width: number,
  height: number,
  fromUs: Us = 0,
  toUs: Us = Number.MAX_SAFE_INTEGER,
  texts: OverlaySpan[] = [],
): string {
  const styles: string[] = [];
  const lines: string[] = [];
  const side = Math.round(width * 0.08);
  if (style) {
    const size = Math.round(Math.max(0.02, Math.min(0.15, style.size)) * height);
    const align = style.position === "top" ? 8 : style.position === "middle" ? 5 : 2;
    // BorderStyle 3 draws a box behind the text (in the outline colour); 1 draws an outline and shadow.
    const look = style.box ? `3,${Math.round(size * 0.28)},0` : `1,${Math.max(2, Math.round(size * 0.09))},${Math.max(1, Math.round(size * 0.04))}`;
    styles.push(`Style: Cap,Arial,${size},&H00FFFFFF,&H00FFFFFF,${style.box ? "&H66000000" : "&H00000000"},&H80000000,-1,0,0,0,100,100,0,0,${look},${align},${side},${side},${Math.round(height * 0.07)},1`);
    for (const c of cues) {
      const a = Math.max(c.startUs, fromUs);
      const b = Math.min(c.endUs, toUs);
      if (b > a) lines.push(`Dialogue: 0,${stamp(a - fromUs, ".", 2)},${stamp(b - fromUs, ".", 2)},Cap,,0,0,0,,${assText(c.text)}`);
    }
  }
  texts.forEach((o, i) => {
    const a = Math.max(o.tlStartUs, fromUs);
    const b = Math.min(o.tlEndUs, toUs);
    if (o.kind !== "text" || b <= a) return;
    const size = Math.round(o.style.size * height * o.transform.scale);
    const look = o.style.box ? `3,${Math.round(size * 0.3)},0` : `1,${Math.max(2, Math.round(size * 0.08))},${Math.max(1, Math.round(size * 0.04))}`;
    styles.push(`Style: T${i},Arial,${size},${assColor(o.style.color)},${assColor(o.style.color)},${o.style.box ? "&H59000000" : "&H00000000"},&H80000000,${o.style.bold ? -1 : 0},0,0,0,100,100,0,0,${look},5,${side},${side},0,1`);
    const x = Math.round((0.5 + o.transform.x) * width);
    const y = Math.round((0.5 + o.transform.y) * height);
    // A fade only plays when this part of the video contains that end of the overlay.
    const fin = a === o.tlStartUs ? Math.round(o.fadeInUs / 1000) : 0;
    const fout = b === o.tlEndUs ? Math.round(o.fadeOutUs / 1000) : 0;
    const alpha = o.transform.opacity < 0.995 ? `\\alpha&H${Math.round((1 - o.transform.opacity) * 255).toString(16).padStart(2, "0").toUpperCase()}&` : "";
    lines.push(`Dialogue: 1,${stamp(a - fromUs, ".", 2)},${stamp(b - fromUs, ".", 2)},T${i},,0,0,0,,{\\pos(${x},${y})\\fad(${fin},${fout})${alpha}}${assText(o.text)}`);
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines,
    "",
  ].join("\n");
}

/** Whether a stretch of the video has any caption or text to burn in. */
export function hasBurnIn(cues: Cue[], captionsOn: boolean, texts: OverlaySpan[], fromUs: Us, toUs: Us): boolean {
  return (captionsOn && cues.some((c) => c.endUs > fromUs && c.startUs < toUs)) || texts.some((o) => o.kind === "text" && o.tlEndUs > fromUs && o.tlStartUs < toUs);
}
