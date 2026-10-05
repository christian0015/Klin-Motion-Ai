//src/lib/dsp.test.ts
/** dsp.test.ts — le correcteur de hauteur (autotune) testé sur de vraies sinusoïdes : on évalue le MÊME texte que celui livré au worklet. */
import { describe, it, expect } from "vitest";
import { AUTOTUNE_WORKLET_SRC, PITCH_DSP_SRC, SCALES } from "./dsp";

const SR = 48000;
const PC: any = new Function(`${PITCH_DSP_SRC}; return PitchCorrector;`)();
const sine = (f: number, sec: number, amp = 0.5) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));
/** Fréquence estimée par passages à zéro montants. */
const freq = (x: Float32Array) => { let c = 0; for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) c++; return c / (x.length / SR); };
const run = (f: number, o: object, sec = 1.6) => { const c = new PC(SR, { key: 0, scale: null, strength: 1, speed: 0, mix: 1, ...o }); const out = new Float32Array(Math.round(sec * SR)); c.process(sine(f, sec), out); return { c, out, tail: out.slice(Math.round(0.8 * SR)) }; };

describe("autotune : détection", () => {
  it.each([110, 150, 220, 440])("détecte %i Hz à ±1,5 Hz", (f) => { expect(Math.abs(run(f, { mix: 0 }).c.f0 - f)).toBeLessThan(1.5); });
  it("silence : pas de hauteur, pas de NaN", () => {
    const c = new PC(SR, { key: 0, scale: null, strength: 1, speed: 0, mix: 1 }); const out = new Float32Array(SR / 2); c.process(new Float32Array(SR / 2), out);
    expect(c.f0).toBe(0); expect(out.every((v) => Number.isFinite(v) && v === 0)).toBe(true);
  });
});

describe("autotune : correction", () => {
  it("226 Hz (La un peu haut) est ramené à 220 Hz en chromatique", () => { expect(Math.abs(freq(run(226, {}).tail) - 220)).toBeLessThan(3); });
  it("214 Hz (La un peu bas) est ramené à 220 Hz", () => { expect(Math.abs(freq(run(214, {}).tail) - 220)).toBeLessThan(3); });
  it("force 0 : la hauteur n'est pas modifiée", () => { expect(Math.abs(freq(run(226, { strength: 0 }).tail) - 226)).toBeLessThan(3); });
  it("note déjà juste : inchangée", () => { expect(Math.abs(freq(run(220, {}).tail) - 220)).toBeLessThan(3); });
  it("Do majeur : un Si♭ (233 Hz) est attiré vers une note de la gamme (La = 220 Hz)", () => {
    expect(Math.abs(freq(run(233.08, { scale: SCALES.major }).tail) - 220)).toBeLessThan(3);
  });
  it("la sortie reste bornée et finie", () => { const { out } = run(226, {}); expect(Math.max(...out.map(Math.abs))).toBeLessThan(1.2); expect(out.every(Number.isFinite)).toBe(true); });
  it("mix 0 : signal sec (retardé de la latence, même fréquence)", () => { expect(Math.abs(freq(run(226, { mix: 0 }).tail) - 226)).toBeLessThan(3); });
});

describe("autotune : worklet", () => {
  it("le code du worklet s'évalue, enregistre un processeur et produit des échantillons finis", () => {
    let registered = "";
    class Base { port = {}; }
    const make = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", `${AUTOTUNE_WORKLET_SRC}; return MiaAutotune;`);
    const Cls = make(Base, (n: string) => { registered = n; }, SR);
    expect(registered).toBe("mia-autotune");
    const p = new Cls({ processorOptions: { key: 0, scale: null, strength: 1, speed: 20, mix: 1 } });
    const out = [new Float32Array(128), new Float32Array(128)];
    for (let b = 0; b < 40; b++) expect(p.process([[sine(226, 128 / SR).length ? new Float32Array(128).fill(0.1) : new Float32Array(128)]], [out])).toBe(true);
    expect(out[0].every(Number.isFinite) && out[1].every(Number.isFinite)).toBe(true);
  });
});
