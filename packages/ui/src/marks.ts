/** Shapes drawn on a frame for Hermes, in frame fractions (0,0 is the top-left corner). */
export type Tool = "draw" | "box" | "point";
export type Pt = [number, number];
export type Shape =
  | { kind: "draw"; color: string; pts: Pt[] }
  | { kind: "box"; color: string; a: Pt; b: Pt }
  | { kind: "point"; color: string; at: Pt };

const f2 = (v: number) => v.toFixed(2);
/** Shapes in plain words, numbered the way they are drawn on the picture. */
export function describeMarks(shapes: Shape[], atUs: number): string {
  let n = 0;
  const parts = shapes.map((s) => {
    n += 1;
    if (s.kind === "point") return `point ${n} at (${f2(s.at[0])}, ${f2(s.at[1])})`;
    if (s.kind === "box") {
      const [x0, x1] = [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])];
      const [y0, y1] = [Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])];
      return `box ${n} from (${f2(x0)}, ${f2(y0)}) to (${f2(x1)}, ${f2(y1)})`;
    }
    const xs = s.pts.map((p) => p[0]);
    const ys = s.pts.map((p) => p[1]);
    return `stroke ${n} (circled, underlined or pointed) covering x ${f2(Math.min(...xs))}–${f2(Math.max(...xs))}, y ${f2(Math.min(...ys))}–${f2(Math.max(...ys))}`;
  });
  return `frame at ${(atUs / 1e6).toFixed(2)}s on the timeline: ${parts.join("; ")}`;
}

