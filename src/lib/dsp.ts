//src/lib/dsp.ts
/**
 * dsp.ts — traitement du signal pour les effets audio qui ne peuvent pas être de simples nœuds Web Audio.
 * Contient : PITCH_DSP_SRC (code JS du correcteur de hauteur « autotune », sous forme de TEXTE), AUTOTUNE_WORKLET_SRC (le même code
 *            + le processeur AudioWorklet), SCALES/KEYS, ensureWorklet (chargement une seule fois par contexte audio).
 * Ne contient PAS : le graphe Web Audio d'un effet (effects/*.ts) ni la lecture/le mixage (render.tsx).
 *
 * POURQUOI DU TEXTE : un AudioWorklet s'exécute dans un autre contexte JS, il faut lui fournir du code source. Le MÊME texte est
 * évalué dans les tests (vitest) : ce qui est testé est exactement ce qui est livré. Le texte ne doit référencer AUCUNE variable externe
 * (le minifieur renommerait les identifiants) : tout est dans la classe.
 */

/** Gammes : classes de hauteur (0 = tonique) autorisées ; `null` = chromatique (toutes les notes). */
export const SCALES: Record<string, number[] | null> = {
  chromatic: null, major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], pentatonic: [0, 2, 4, 7, 9],
};
export const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/**
 * PitchCorrector : détection de hauteur (NSDF/McLeod sur signal décimé ×4, toutes les 256 échantillons) → note cible la plus proche dans
 * la gamme → rapport de transposition lissé (temps de retour `speed` ms) → décalage par deux grains croisés sur ligne à retard (40 ms).
 * Options : { key:0..11, scale:number[]|null, strength:0..1, speed:ms, mix:0..1 }. Latence ≈ 20 ms (le dry est retardé d'autant : pas de phasing).
 */
export const PITCH_DSP_SRC = `
class PitchCorrector {
  constructor(sr, o) {
    this.sr = sr; this.key = o.key | 0; this.scale = o.scale || null;
    this.strength = o.strength; this.mix = o.mix; this.speed = o.speed;
    this.W = Math.round(0.04 * sr);
    this.N = 16384; this.mask = this.N - 1; this.buf = new Float32Array(this.N); this.w = 0;
    this.phase = 0; this.lr = 0;
    this.hop = 256; this.hopCount = 0;
    this.dec = 4; this.dsr = sr / 4; this.dsLen = 1024; this.dsMask = 1023; this.ds = new Float32Array(this.dsLen); this.dsW = 0; this.acc = 0; this.accN = 0;
    this.L = 256; this.minLag = Math.max(2, Math.floor(this.dsr / 800)); this.maxLag = Math.min(this.dsLen - this.L - 2, Math.ceil(this.dsr / 70));
    this.nsdf = new Float32Array(this.maxLag + 2);
    this.alpha = this.speed <= 0 ? 1 : 1 - Math.exp(-this.hop / (sr * this.speed / 1000));
    this.dryDelay = Math.round(this.W / 2); this.f0 = 0; this.target = 0;
  }
  detect() {
    const L = this.L, maxLag = this.maxLag, ds = this.ds, m = this.dsMask, n = this.nsdf;
    const start = this.dsW - (L + maxLag + 1);
    for (let tau = 1; tau <= maxLag; tau++) {
      let acf = 0, e = 0;
      for (let j = 0; j < L; j++) { const a = ds[(start + j) & m], b = ds[(start + j + tau) & m]; acf += a * b; e += a * a + b * b; }
      n[tau] = e > 1e-9 ? 2 * acf / e : 0;
    }
    let t = 1; while (t < maxLag && n[t] > 0) t++;
    const peaks = [];
    while (t < maxLag) {
      while (t < maxLag && n[t] <= 0) t++;
      let pk = -1, pv = 0;
      while (t < maxLag && n[t] > 0) { if (n[t] > pv) { pv = n[t]; pk = t; } t++; }
      if (pk >= this.minLag) peaks.push([pk, pv]);
    }
    if (!peaks.length) return 0;
    let mx = 0; for (const p of peaks) if (p[1] > mx) mx = p[1];
    if (mx < 0.6) return 0;
    let k = 0; for (const p of peaks) if (p[1] >= 0.9 * mx) { k = p[0]; break; }
    const a = n[k - 1], b = n[k], c = n[k + 1], den = a - 2 * b + c;
    const lag = k + (den !== 0 ? (a - c) / (2 * den) : 0);
    return lag > 0 ? this.dsr / lag : 0;
  }
  nearest(f0) {
    const midi = 69 + 12 * Math.log2(f0 / 440);
    let best = Math.round(midi), bd = 1e9;
    for (let note = Math.floor(midi) - 7; note <= Math.ceil(midi) + 7; note++) {
      const pc = (((note - this.key) % 12) + 12) % 12;
      if (this.scale && this.scale.indexOf(pc) < 0) continue;
      const d = Math.abs(note - midi);
      if (d < bd - 1e-9) { bd = d; best = note; }
    }
    return 440 * Math.pow(2, (best - 69) / 12);
  }
  tap(pos) { const i = Math.floor(pos), f = pos - i; return this.buf[i & this.mask] * (1 - f) + this.buf[(i + 1) & this.mask] * f; }
  process(input, output) {
    const W = this.W, N = this.N;
    for (let s = 0; s < input.length; s++) {
      const x = input[s];
      this.buf[this.w] = x; this.w = (this.w + 1) & this.mask;
      this.acc += x;
      if (++this.accN === this.dec) { this.ds[this.dsW] = this.acc / this.dec; this.dsW = (this.dsW + 1) & this.dsMask; this.acc = 0; this.accN = 0; }
      if (++this.hopCount >= this.hop) {
        this.hopCount = 0;
        const f0 = this.detect(); this.f0 = f0;
        let lt = 0;
        if (f0 > 0) { this.target = this.nearest(f0); lt = this.strength * Math.log(this.target / f0); }
        this.lr += this.alpha * (lt - this.lr);
      }
      const ratio = Math.exp(this.lr);
      const p1 = this.phase, p2 = (this.phase + 0.5) % 1;
      const g1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p1), g2 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p2);
      const wet = g1 * this.tap(this.w - p1 * W + N) + g2 * this.tap(this.w - p2 * W + N);
      this.phase += (1 - ratio) / W; this.phase -= Math.floor(this.phase);
      const dry = this.buf[(this.w - this.dryDelay + N) & this.mask];
      output[s] = dry * (1 - this.mix) + wet * this.mix;
    }
  }
}
`;

/** Code complet du worklet : correcteur + processeur (un correcteur par canal). */
export const AUTOTUNE_WORKLET_SRC = `${PITCH_DSP_SRC}
class MiaAutotune extends AudioWorkletProcessor {
  constructor(o) { super(); this.o = o.processorOptions; this.c = []; }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    for (let ch = 0; ch < out.length; ch++) {
      if (!this.c[ch]) this.c[ch] = new PitchCorrector(sampleRate, this.o);
      this.c[ch].process(inp[Math.min(ch, inp.length - 1)], out[ch]);
    }
    return true;
  }
}
registerProcessor("mia-autotune", MiaAutotune);
`;

const loaded = new WeakMap<object, Set<string>>();
/** Charge un AudioWorklet une seule fois par contexte audio (un second `addModule` du même nom lèverait une erreur). */
export async function ensureWorklet(ctx: BaseAudioContext, name: string, src: string): Promise<void> {
  const done = loaded.get(ctx) ?? new Set<string>(); loaded.set(ctx, done);
  if (done.has(name)) return;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  try { await ctx.audioWorklet.addModule(url); done.add(name); } finally { URL.revokeObjectURL(url); }
}
