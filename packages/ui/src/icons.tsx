/**
 * The editor's icons: small inline SVGs drawn on a 20-unit grid with round 1.7 strokes, in the
 * current text colour. A few kilobytes in all, nothing to load.
 */
const PATHS = {
  play: "M7 4.8v10.4a.8.8 0 0 0 1.2.7l8.2-5.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z",
  pause: "M6.5 4.5h2.2v11H6.5zM11.3 4.5h2.2v11h-2.2z",
  back5: "M3.5 10a6.5 6.5 0 1 0 2-4.7M3.5 3.5v3.3h3.3",
  fwd5: "M16.5 10a6.5 6.5 0 1 1-2-4.7M16.5 3.5v3.3h-3.3",
  plus: "M10 4.5v11M4.5 10h11",
  zoom: "M8.7 3.6a5.1 5.1 0 1 0 0 10.2 5.1 5.1 0 0 0 0-10.2ZM12.4 12.4l4 4M8.7 6.6v4.2M6.6 8.7h4.2",
  marker: "M10 2.8 15.2 8 10 13.2 4.8 8ZM10 13.2v4",
  text: "M4.5 5.5V4h11v1.5M10 4v12M7.6 16h4.8",
  graphic: "M3.5 13.5 7 9l2.5 3 2-2.5 5 6.5M3.5 4.5h13v12h-13zM13 7.3a.6.6 0 1 0 0 .1",
  undo: "M7.5 6.5 4 10l3.5 3.5M4.5 10h7a4.5 4.5 0 0 1 0 9H10",
  redo: "M12.5 6.5 16 10l-3.5 3.5M15.5 10h-7a4.5 4.5 0 0 0 0 9H10",
  split: "M10 3v14M6 6 3.5 10 6 14M14 6l2.5 4L14 14",
  cut: "M6 6.5a2 2 0 1 0 0-.1M6 17.5a2 2 0 1 0 0-.1M7.6 7.4 16 15M7.6 16.6 16 9",
  trash: "M4.5 6h11M8 6V4.5h4V6M6 6l.7 10a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6",
  fit: "M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4",
  gaps: "M3 4v12M17 4v12M6.5 10h7M9 7.5 6.5 10 9 12.5M11 7.5l2.5 2.5-2.5 2.5",
  mic: "M10 3a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 10 3ZM5.5 9.5a4.5 4.5 0 0 0 9 0M10 14v3",
  chevron: "M6 8l4 4 4-4",
  back: "M12 4.5 6.5 10l5.5 5.5",
  export: "M10 3.5v9M6.5 7 10 3.5 13.5 7M4 12.5v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3",
  transition: "M3.5 4.5h7v11h-7zM9.5 4.5h7v11h-7z M10.5 4.5l-1 11",
  layers: "M10 3.5 17 7l-7 3.5L3 7ZM3 10.5l7 3.5 7-3.5M3 14l7 3.5 7-3.5",
  doc: "M5.5 3h6l3.5 3.5V17h-9.5zM11.5 3v3.5H15M8 10h5M8 13h5",
  image: "M3.5 4.5h13v11h-13zM3.5 13l4-4 3.5 3.5 2-2 3.5 3.5M12.8 7.6a.6.6 0 1 0 0 .1",
  memory: "M10 3.5a5 5 0 0 0-3.2 8.8c.5.4.7 1 .7 1.6v.6h5v-.6c0-.6.2-1.2.7-1.6A5 5 0 0 0 10 3.5ZM8 17h4",
  clock: "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM10 6.5V10l2.5 1.8",
  sun: "M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10 2.5v1.6M10 15.9v1.6M2.5 10h1.6M15.9 10h1.6M4.7 4.7l1.1 1.1M14.2 14.2l1.1 1.1M4.7 15.3l1.1-1.1M14.2 5.8l1.1-1.1",
  moon: "M15.8 12.4A6.5 6.5 0 0 1 7.6 4.2a6.5 6.5 0 1 0 8.2 8.2Z",
  speaker: "M3.5 8v4h3l4 3.5v-11l-4 3.5ZM13.5 7.5a3.5 3.5 0 0 1 0 5M15.6 5.4a6.5 6.5 0 0 1 0 9.2",
  speakerOff: "M3.5 8v4h3l4 3.5v-11l-4 3.5ZM13.5 8l4 4M17.5 8l-4 4",
  gear: "M10 6.8a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4ZM8.6 2.5h2.8l.4 2 1.6.9 1.9-.7 1.4 2.4-1.5 1.3v1.9l1.5 1.3-1.4 2.4-1.9-.7-1.6.9-.4 2H8.6l-.4-2-1.6-.9-1.9.7-1.4-2.4 1.5-1.3V9.1L3.3 7.8l1.4-2.4 1.9.7 1.6-.9Z",
  film: "M3.5 4.5h13v11h-13zM6.5 4.5v11M13.5 4.5v11M3.5 8h3M3.5 12h3M13.5 8h3M13.5 12h3",
  pen: "M4 16l1-3.8L13.2 4a1.4 1.4 0 0 1 2 0l.8.8a1.4 1.4 0 0 1 0 2L7.8 15ZM11.8 5.4l2.8 2.8",
  box: "M4 5.5h12v9H4z",
  point: "M5 4l10 4.5-4.2 1.5L9 14.5Z",
  link: "M8.5 11.5l3-3M7.2 9.3 5.8 10.7a2.4 2.4 0 0 0 3.5 3.5l1.4-1.4M12.8 10.7l1.4-1.4a2.4 2.4 0 0 0-3.5-3.5L9.3 7.2",
  folder: "M3 6V5a1 1 0 0 1 1-1h4l1.5 1.5H16a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const filled = name === "play" || name === "pause";
  return (
    <svg className={"icon" + (className ? " " + className : "")} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false"
      fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
      {name === "back5" || name === "fwd5" ? <text x="10" y="12.6" textAnchor="middle" fontSize="6.6" fontWeight="700" fill="currentColor" stroke="none">5</text> : null}
    </svg>
  );
}
