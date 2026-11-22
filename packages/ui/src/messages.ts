/** Puts tool output into words a person can act on: no ffmpeg internals, file names not full paths. */
export function plainMessage(text: string): string {
  const missing = /(?:Error opening input file|No such file or directory)[^]*?([A-Za-z]:[\\/][^|]*?\.[A-Za-z0-9]{2,5}|\/[^|]*?\.[A-Za-z0-9]{2,5})/.exec(text);
  if (missing && /No such file or directory/.test(text)) {
    const name = missing[1]!.split(/[\\/]/).pop();
    const what = /^([^:]+?) failed:/.exec(text)?.[1];
    return `${what ? `${what}: ` : ""}can't find ${name}. It was moved or deleted; use Find… in Media to point to it.`;
  }
  return text.replace(/\[(?:in#|out#|vost#|aost#)[^\]]*\]\s*/g, "").replace(/\s*\|\s*/g, " ").trim();
}
