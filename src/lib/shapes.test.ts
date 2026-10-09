//src/lib/shapes.test.ts
/** shapes.test.ts — formes et gabarits : lecture de SVG (fonctions pures), courbes de mouvement, dessin des gabarits, ajout dans la timeline, IA. */
import { describe, it, expect, beforeEach } from "vitest";
import { IDENT, mul, parseTransform, pathLength, shapeToPath } from "./svg";
import { EASES, ease, layoutDoc, validate } from "./engine";
import { CompositionS, emptyComposition, type Composition, type ParsedSvg } from "./schema";
import { EFFECTS, registry } from "@/effects";
import { useEditor } from "./store";
import { catalogForPrompt, mergeAi, responseSchema } from "./gemini";

(globalThis as any).Path2D ??= class {};
const rec = (): { g: any; calls: string[] } => { const calls: string[] = []; const g: any = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 40 }) : (...a: unknown[]) => { calls.push(`${String(k)}(${a.map((x) => (typeof x === "number" ? Math.round(x * 10) / 10 : typeof x === "object" ? "{}" : x)).join(",")})`); }), set: () => true }); return { g, calls }; };
const SVG: ParsedSvg = { w: 100, h: 100, items: [{ d: "M0 0L100 0L100 100Z", fill: "#fff", stroke: null, sw: 1, opacity: 1, m: IDENT, len: 340 }] };
const run = (id: string, t: number, svg?: ParsedSvg) => { const e = registry.get(id)!, r = rec(); e.draw!({ g: r.g, w: 1080, h: 1920, t, dur: 3000, text: "", params: (e.params ? e.params.parse({}) : {}) as any, svg }); return r.calls; };

describe("lecture de SVG (fonctions pures)", () => {
  it("transformations : translate, scale, rotate, composition dans l'ordre d'écriture", () => {
    expect(parseTransform("translate(10,20)")).toEqual([1, 0, 0, 1, 10, 20]); expect(parseTransform("scale(2)")).toEqual([2, 0, 0, 2, 0, 0]);
    expect(parseTransform("translate(10 0) scale(2)")).toEqual([2, 0, 0, 2, 10, 0]); expect(parseTransform(null)).toEqual(IDENT);
    const r = parseTransform("rotate(90)"); expect([Math.round(r[0]), r[1], -r[2], Math.round(r[3])]).toEqual([0, 1, 1, 0]);
    expect(mul(IDENT, [2, 0, 0, 2, 5, 5])).toEqual([2, 0, 0, 2, 5, 5]);
  });
  it("formes de base → chemins, longueurs exactes ou proches", () => {
    const a = (o: Record<string, number>) => (k: string) => o[k] ?? 0;
    expect(pathLength(shapeToPath("rect", a({ width: 10, height: 20 }))!)).toBeCloseTo(60, 1);
    expect(pathLength(shapeToPath("circle", a({ cx: 50, cy: 50, r: 10 }))!)).toBeCloseTo(2 * Math.PI * 10, 0);
    expect(pathLength(shapeToPath("line", a({ x1: 0, y1: 0, x2: 30, y2: 40 }))!)).toBeCloseTo(50, 3);
    expect(pathLength(shapeToPath("polygon", a({}), "0,0 10,0 10,10")!)).toBeCloseTo(10 + 10 + Math.hypot(10, 10), 3);
    expect(shapeToPath("rect", a({ width: 0, height: 5 }))).toBeNull(); expect(shapeToPath("star", a({}))).toBeNull();
  });
  it("chemins : absolu et relatif, H/V, courbes", () => {
    expect(pathLength("M0 0L100 0")).toBe(100); expect(pathLength("m0 0 l30 40")).toBeCloseTo(50, 5); expect(pathLength("M0 0H30V40")).toBe(70);
    expect(pathLength("M0 0C10 0 20 0 30 0")).toBeCloseTo(30, 1);       // cubique dont les points sont alignés = segment
    expect(pathLength("M0 0Q15 0 30 0")).toBeCloseTo(30, 1); expect(pathLength("M0 0L10 0L10 10Z")).toBeCloseTo(10 + 10 + Math.hypot(10, 10), 3);
  });
});

describe("courbes de mouvement", () => {
  it("toutes les courbes partent de 0 et arrivent à 1 (sauf « hold »)", () => {
    for (const n of EASES.filter((x) => x !== "hold")) { expect(Math.abs(ease(n, 0)), n).toBeLessThan(1e-6); expect(Math.abs(ease(n, 1) - 1), n).toBeLessThan(1e-6); }
    expect(EASES).toEqual(expect.arrayContaining(["outElastic", "outBounce", "inBack", "spring"]));
  });
  it("rebond et ressort dépassent ou oscillent comme attendu, sans sortir de bornes absurdes", () => {
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => ease("spring", i / 49)))).toBeGreaterThan(1);
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => ease("outElastic", i / 49)))).toBeGreaterThan(1);
    for (const n of ["outBounce", "spring", "outElastic", "inBack"]) for (let i = 0; i <= 20; i++) expect(Math.abs(ease(n, i / 20))).toBeLessThan(1.6);
  });
});

describe("gabarits de formes : dessin", () => {
  const presets = EFFECTS.filter((e) => e.kind === "shape_preset" && e.id !== "svg_draw_v1").map((e) => e.id);
  it("au moins 8 gabarits fournis", () => { expect(presets.length).toBeGreaterThanOrEqual(8); });
  it.each(presets)("%s : dessine quelque chose en cours de clip, de façon identique à chaque appel", (id) => {
    const T = id === "burst_lines_v1" ? 400 : 1500;   // l'éclat s'estompe en moins d'une seconde : on le contrôle pendant qu'il est visible
    const a = run(id, T), b = run(id, T);
    expect(a.some((c) => /^(fill|stroke|fillRect|fillText|strokeText)\(/.test(c))).toBe(true); expect(a).toEqual(b);
  });
  it("svg_draw_v1 : dessine un SVG chargé, ne dessine rien sans SVG, le tracé progresse", () => {
    expect(run("svg_draw_v1", 1500, SVG).some((c) => c.startsWith("fill("))).toBe(true); expect(run("svg_draw_v1", 1500)).toEqual([]);
    expect(run("svg_draw_v1", 100, SVG).find((c) => c.startsWith("setLineDash"))).not.toBe(run("svg_draw_v1", 1500, SVG).find((c) => c.startsWith("setLineDash")));
  });
  it("svg_draw_v1 est caché à l'IA, les autres gabarits lui sont proposés", () => {
    expect(catalogForPrompt()).not.toMatch(/svg_draw_v1/); expect(catalogForPrompt()).toMatch(/lower_third_v1 \[shape_preset\]/);
    const ids = (responseSchema([]).properties.tracks.items.properties.clips.items.properties as any).shape.properties.preset.enum as string[];
    expect(ids).toContain("stat_counter_v1"); expect(ids).not.toContain("svg_draw_v1");
  });
});

describe("formes dans la timeline", () => {
  const load = (d: Composition = emptyComposition()) => useEditor.getState().load({ id: "p", name: "t", rev: 0, brief: { platform: "tiktok" }, doc: d });
  const st = () => useEditor.getState(), doc = () => st().doc;
  const withSvg = (): Composition => ({ ...emptyComposition(), assets: { lg: { type: "svg", name: "logo.svg", w: 200, h: 100, fp: "x" }, im: { type: "image", name: "p.png", w: 1, h: 1, fp: "y" } } });
  beforeEach(() => load());
  it("piste Formes : élément par défaut = premier gabarit, valide et visible dans la mise en page", () => {
    const id = st().addTrack("shape"); expect(st().addDefaultClip(id).ok).toBe(true);
    expect((doc().tracks[0].clips[0] as any).shape.preset).toBe("lower_third_v1"); expect(() => CompositionS.parse(doc())).not.toThrow();
    expect(layoutDoc(doc()).list[0]).toMatchObject({ kind: "shape", ok: true, dur: 2500 });
  });
  it("un SVG se place sur une piste Formes ; il ne va pas sur une piste vidéo", () => {
    load(withSvg()); expect(st().placeAsset("lg").ok).toBe(true); const tr = doc().tracks.find((t) => t.kind === "shape")!; expect((tr.clips[0] as any).shape).toEqual({ asset: "lg" });
    const v = st().addTrack("video"); expect(st().dropAsset("lg", v, 0).ok).toBe(false); expect(st().dropAsset("lg", tr.id, 500).ok).toBe(true); expect(() => CompositionS.parse(doc())).not.toThrow();
  });
  it("onglet Effets : un gabarit crée une forme ; svg_draw_v1 demande un SVG importé ; remplacement du gabarit d'une forme sélectionnée", () => {
    expect(st().applyEffect("stat_counter_v1").ok).toBe(true); const tr = doc().tracks.find((t) => t.kind === "shape")!; expect((tr.clips[0] as any).shape.preset).toBe("stat_counter_v1");
    expect(st().applyEffect("svg_draw_v1")).toMatchObject({ ok: false, msg: expect.stringContaining("SVG") });
    st().select(tr.clips[0].id); st().applyEffect("badge_pop_v1"); expect((doc().tracks.find((t) => t.kind === "shape")!.clips[0] as any).shape.preset).toBe("badge_pop_v1");
  });
  it("supprimer un SVG retire ses formes ; un gabarit inconnu ou un SVG manquant est signalé", () => {
    load(withSvg()); st().placeAsset("lg"); st().removeAsset("lg"); expect(doc().assets.lg).toBeUndefined(); expect((doc().tracks as { clips: unknown[] }[]).flatMap((t) => t.clips).length).toBe(0);
    const d = withSvg(); d.tracks.push({ id: "s", kind: "shape", clips: [{ id: "a", shape: { preset: "fantome_v9" }, at: 0, dur: 1000 }, { id: "b", shape: { asset: "im" }, at: 0, dur: 1000 }] });
    const w = validate(d, (x) => registry.has(x)); expect(w.some((x) => x.msg.includes("fantome_v9"))).toBe(true); expect(w.some((x) => x.code === "asset_missing")).toBe(true);
  });
  it("l'IA : gabarit valide gardé et borné, gabarit inconnu écarté", () => {
    const ai: any = { words: {}, transitions: [], tracks: [{ id: "sh", kind: "shape", clips: [
      { id: "s1", shape: { preset: "stat_counter_v1", params: { to: 99999999, label: "de vues" } }, at: 500, dur: 2000 }, { id: "s2", shape: { preset: "inconnu_v1" }, at: 0, dur: 1000 }] }] };
    const out = mergeAi(withSvg(), ai); const clips = out.tracks.flatMap((t) => t.clips as any[]);
    expect(clips.map((c) => c.id)).toEqual(["s1"]); expect(clips[0].shape.params.to).toBe(999999); expect(clips[0].shape.params.label).toBe("de vues"); expect(() => CompositionS.parse(out)).not.toThrow();
  });
});
