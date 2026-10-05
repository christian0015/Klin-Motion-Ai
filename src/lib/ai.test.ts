//src/lib/ai.test.ts
/** ai.test.ts — replis IA réglables (0 à 2), erreurs lisibles, médias vus par l'IA, arrondi des temps. */
import { describe, it, expect, beforeEach } from "vitest";
import { friendlyError, isTransient, mergeAi, retryTransient, withFallback, catalogForPrompt, responseSchema, systemPrompt } from "./gemini";
import { CompositionS, SettingsS, DEFAULT_SETTINGS, emptyComposition, migrate, type AiConfig, type Composition } from "./schema";
import { normalizeTimes } from "./normalize";
import { useEditor } from "./store";

const cfg = (o: Partial<AiConfig> = {}): AiConfig => ({ model: "m0", fallbackModels: ["m1", "m2"], maxFallbacks: 2, retryDelayMs: 0, ...o });
const e503 = Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'), { status: 503 });
const noSleep = async () => {};

describe("replis IA", () => {
  it("l'erreur 503 de l'énoncé est reconnue comme passagère et son message est lisible", () => {
    expect(isTransient(e503)).toBe(true); expect(friendlyError(e503)).toMatch(/surchargé.*crédits sont remboursés/);
    expect(isTransient(Object.assign(new Error("bad"), { status: 400 }))).toBe(false);
  });
  it("succès direct : un seul appel", async () => {
    const calls: string[] = []; const r = await withFallback(cfg(), async (m) => { calls.push(m); return "ok"; }, { sleep: noSleep });
    expect(calls).toEqual(["m0"]); expect(r.model).toBe("m0");
  });
  it("2 replis : m0 → m1 → m2", async () => {
    const calls: string[] = []; const r = await withFallback(cfg(), async (m) => { calls.push(m); if (m !== "m2") throw e503; return "ok"; }, { sleep: noSleep });
    expect(calls).toEqual(["m0", "m1", "m2"]); expect(r.model).toBe("m2"); expect(r.log.map((l) => !!l.error)).toEqual([true, true, false]);
  });
  it("1 repli : m0 → m1 puis échec", async () => {
    const calls: string[] = [];
    await expect(withFallback(cfg({ maxFallbacks: 1 }), async (m) => { calls.push(m); throw e503; }, { sleep: noSleep })).rejects.toMatchObject({ attempts: [{ model: "m0" }, { model: "m1" }] });
    expect(calls).toEqual(["m0", "m1"]);
  });
  it("0 repli : aucune nouvelle tentative", async () => {
    const calls: string[] = [];
    await expect(withFallback(cfg({ maxFallbacks: 0 }), async (m) => { calls.push(m); throw e503; }, { sleep: noSleep })).rejects.toThrow();
    expect(calls).toEqual(["m0"]);
  });
  it("modèle de repli vide : on retente le principal", async () => {
    const calls: string[] = []; await withFallback(cfg({ fallbackModels: [] }), async (m) => { calls.push(m); if (calls.length < 3) throw e503; return 1; }, { sleep: noSleep });
    expect(calls).toEqual(["m0", "m0", "m0"]);
  });
  it("erreur non passagère : pas de repli", async () => {
    const calls: string[] = []; await expect(withFallback(cfg(), async (m) => { calls.push(m); throw Object.assign(new Error("clé invalide"), { status: 403 }); }, { sleep: noSleep })).rejects.toThrow("clé invalide");
    expect(calls.length).toBe(1);
  });
  it("retryTransient suit le même plafond (1 + maxFallbacks essais)", async () => {
    let n = 0; await expect(retryTransient(cfg({ maxFallbacks: 1 }), async () => { n++; throw e503; }, noSleep)).rejects.toThrow(); expect(n).toBe(2);
  });
  it("réglages : défaut valide, plafond 2 respecté par le schéma", () => {
    expect(() => SettingsS.parse(DEFAULT_SETTINGS)).not.toThrow();
    expect(SettingsS.safeParse({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, maxFallbacks: 3 } }).success).toBe(false);
    expect(SettingsS.safeParse({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, maxFallbacks: -1 } }).success).toBe(false);
    expect(SettingsS.safeParse({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, fallbackModels: ["a1x", "b2x", "c3x"] } }).success).toBe(false);
  });
});

describe("l'IA voit tous les médias et tous les effets", () => {
  const base = (): Composition => ({ ...emptyComposition(), assets: {
    r1: { type: "video", name: "a.mp4", w: 1080, h: 1920, dur: 8000, fps: 30, hasAudio: true, bytes: 1, fp: "f1", proxy: "k1" },
    im: { type: "image", name: "logo.png", w: 400, h: 300, fp: "f2", proxy: "k2", desc: "logo" },
    snd: { type: "audio", name: "music.mp3", dur: 10000, fp: "f3", proxy: "k3" },
    snd2: { type: "audio", name: "other.mp3", dur: 5000, fp: "f4" },
  } });
  it("le prompt et le schéma de réponse listent les effets audio et les champs afx/fit/fade", () => {
    expect(catalogForPrompt()).toMatch(/autotune_v1 \[audio_fx\]/); expect(catalogForPrompt()).toMatch(/echo_v1 \[audio_fx\]/);
    expect(systemPrompt([])).toMatch(/IMAGES/); expect(systemPrompt([])).toMatch(/SONS/);
    const clip: any = (responseSchema([]).properties.tracks.items.properties.clips.items.properties);
    expect(clip.afx.items.properties.id.enum).toContain("echo_v1"); expect(clip.fit.enum).toContain("contain"); expect(clip.fade).toBeTruthy();
  });
  it("les images et sons placés par l'IA sont gardés ; les médias non utilisés de l'utilisateur sont conservés", () => {
    const b = base(); b.tracks.push({ id: "mine", kind: "audio", clips: [{ id: "u1", asset: "snd2", src: [0, 5000], at: 0, dur: 5000 }] });
    const ai: any = { words: {}, transitions: [], tracks: [
      { id: "v1", kind: "video", magnetic: true, clips: [{ id: "c1", asset: "r1", src: [0, 4000], afx: [{ id: "echo_v1", params: { mix: 5 } }] }] },
      { id: "img", kind: "video", clips: [{ id: "i1", asset: "im", src: [0, 3000], at: 500, dur: 3000, fit: "contain" }, { id: "bad", asset: "snd", src: [0, 1] }] },
      { id: "music", kind: "audio", clips: [{ id: "m1", asset: "snd", src: [0, 8000], at: 0, dur: 8000, gain: 0.2, fade: [500, 800] }, { id: "ghost", asset: "nope", src: [0, 1] }] },
    ] };
    const out = mergeAi(b, ai); const all = out.tracks.flatMap((t) => t.clips as any[]);
    expect(all.find((c) => c.id === "i1")).toBeTruthy(); expect(all.find((c) => c.id === "m1")).toBeTruthy();
    expect(all.find((c) => c.id === "bad")).toBeUndefined(); expect(all.find((c) => c.id === "ghost")).toBeUndefined();   // mauvais type de média : écartés
    expect(all.find((c) => c.asset === "snd2")).toBeTruthy();                                                              // son non utilisé par l'IA : conservé
    expect((all.find((c) => c.id === "c1").afx[0].params.mix)).toBe(1);                                                    // borné dans [0, 1]
    expect(() => CompositionS.parse(out)).not.toThrow();
  });
});

describe("temps entiers", () => {
  it("normalizeTimes arrondit tout, sans toucher ce qui est déjà bon", () => {
    const d: any = { tracks: [{ clips: [{ at: 10.6, dur: 99.4, src: [1.2, 2000.7], fade: [10.5, 20.4], anchor: { clip: "a", words: [0, 1], offset: -3.6, dur: 7.7 }, speed: { kf: [[0.4, 1], [1000.6, 2]] }, transform: { scale: { kf: [[250.5, 1]] } }, fx: [{ id: "x", params: { a: { kf: [[12.4, 1]] } } }] }] }], transitions: [{ dur: 199.5, params: { p: { kf: [[3.3, 1]] } } }], assets: { r: { dur: 1000.4, words: [{ s: 1.4, e: 2.6 }] } } };
    normalizeTimes(d); const c = d.tracks[0].clips[0];
    expect([c.at, c.dur, ...c.src, ...c.fade, c.anchor.offset, c.anchor.dur]).toEqual([11, 99, 1, 2001, 11, 20, -4, 8]);
    expect([c.speed.kf[0][0], c.speed.kf[1][0], c.transform.scale.kf[0][0], c.fx[0].params.a.kf[0][0]]).toEqual([0, 1001, 251, 12]);
    expect([d.transitions[0].dur, d.transitions[0].params.p.kf[0][0], d.assets.r.dur, d.assets.r.words[0].s, d.assets.r.words[0].e]).toEqual([200, 3, 1000, 1, 3]);
    const snap = JSON.stringify(d); normalizeTimes(d); expect(JSON.stringify(d)).toBe(snap);
  });
  it("migrate répare un document déjà enregistré avec des décimales", () => {
    const m = migrate({ v: 2, canvas: { w: 1080, h: 1920, fps: 30 }, assets: { r: { type: "video", w: 1, h: 1, dur: 5000, fps: 30, hasAudio: true, bytes: 1, fp: "x" } }, transitions: [],
      tracks: [{ id: "t", kind: "video", clips: [{ id: "c", asset: "r", src: [0.5, 1234.567], at: 100.25, dur: 500.5 }] }] });
    expect(m.tracks[0].clips[0]).toMatchObject({ src: [1, 1235], at: 100, dur: 501 });
  });
  it("une action de la timeline avec un delta décimal produit des entiers (rognage, déplacement)", () => {
    const doc: Composition = { ...emptyComposition(), assets: { s: { type: "audio", dur: 10000, fp: "f" } }, tracks: [{ id: "a", kind: "audio", clips: [{ id: "a1", asset: "s", src: [0, 10000], at: 2000, dur: 10000 }] }] };
    useEditor.getState().load({ id: "p", name: "t", rev: 0, brief: { platform: "tiktok" }, doc });
    useEditor.getState().trimClip("a1", "l", 123.456); useEditor.getState().moveClip("a1", 77.77); useEditor.getState().trimClip("a1", "r", -33.3);
    const c: any = useEditor.getState().doc.tracks[0].clips[0];
    for (const v of [c.at, c.dur, ...c.src]) expect(Number.isInteger(v)).toBe(true);
    expect(() => CompositionS.parse(useEditor.getState().doc)).not.toThrow();
  });
});
