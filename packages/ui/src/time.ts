export const S = 1_000_000;

/** 83.5 s -> "1:23.5" */
export function clock(us: number, decimals = 1): string {
  const total = Math.max(0, us) / S;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const whole = Math.floor(s);
  const frac = decimals > 0 ? "." + String(Math.floor((s - whole) * 10 ** decimals)).padStart(decimals, "0") : "";
  return `${m}:${String(whole).padStart(2, "0")}${frac}`;
}

export function bytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(0) + " MB";
  return Math.max(1, Math.round(n / 1e3)) + " KB";
}

export function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}
