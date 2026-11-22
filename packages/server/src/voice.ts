/**
 * The clean-up applied to a voiceover recording, so narration recorded in the
 * editor sits next to narration recorded through a streaming program's
 * microphone filters: noise reduction, a little gain, a compressor, a touch
 * of EQ, then an expander that pulls down the room between phrases.
 * The values are a common spoken-voice chain; ffmpeg's filters do the work.
 */
export interface VoiceChain {
  /** Noise reduction in dB; 0 turns it off. */
  noiseReductionDb: number;
  gainDb: number;
  compressor: { ratio: number; thresholdDb: number; attackMs: number; releaseMs: number; makeupDb: number };
  eq: { lowDb: number; midDb: number; highDb: number };
  expander: { ratio: number; thresholdDb: number; attackMs: number; releaseMs: number };
}

export const DEFAULT_VOICE_CHAIN: VoiceChain = {
  noiseReductionDb: 12,
  gainDb: 2.8,
  compressor: { ratio: 4, thresholdDb: -20, attackMs: 3, releaseMs: 60, makeupDb: 3.6 },
  eq: { lowDb: 0.1, midDb: 0.2, highDb: 0.4 },
  expander: { ratio: 2.5, thresholdDb: -38.1, attackMs: 10, releaseMs: 150 },
};

const lin = (db: number) => Math.pow(10, db / 20);
const n = (v: number, digits = 4) => Number(v.toFixed(digits)).toString();

/** The ffmpeg audio filter string for a chain. */
export function voiceFilter(c: VoiceChain = DEFAULT_VOICE_CHAIN): string {
  const parts = ["highpass=f=70"];
  // The noise floor is measured as it goes (tn=1), so no noise sample is needed.
  if (c.noiseReductionDb > 0) parts.push(`afftdn=nr=${n(Math.min(40, c.noiseReductionDb), 1)}:nf=-45:tn=1`);
  if (c.gainDb) parts.push(`volume=${n(c.gainDb, 2)}dB`);
  parts.push(
    `acompressor=threshold=${n(lin(c.compressor.thresholdDb))}:ratio=${n(c.compressor.ratio, 2)}:attack=${n(c.compressor.attackMs, 1)}:release=${n(c.compressor.releaseMs, 1)}:makeup=${n(Math.max(1, lin(c.compressor.makeupDb)))}`,
  );
  if (c.eq.lowDb) parts.push(`bass=g=${n(c.eq.lowDb, 2)}:f=250`);
  if (c.eq.midDb) parts.push(`equalizer=f=1000:t=q:w=1:g=${n(c.eq.midDb, 2)}`);
  if (c.eq.highDb) parts.push(`treble=g=${n(c.eq.highDb, 2)}:f=4000`);
  parts.push(`agate=threshold=${n(lin(c.expander.thresholdDb), 5)}:ratio=${n(c.expander.ratio, 2)}:attack=${n(c.expander.attackMs, 1)}:release=${n(c.expander.releaseMs, 1)}:range=0.1`);
  parts.push("alimiter=limit=0.95");
  return parts.join(",");
}
