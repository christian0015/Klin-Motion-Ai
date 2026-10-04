//src/lib/engine.test.ts
/** engine.test.ts — tests de engine + schema (décision D11 : uniquement ces deux modules). */
import { describe, it, expect } from "vitest";
import { CompositionS, EXAMPLE_DOC, migrate, type Composition } from "./schema";
import { layoutDoc, srcToTimeline, timelineToSrc, validate, removeClip, splitClipAt, buildFrameState, evalNum, seeded } from "./engine";

const clone = (): Composition => JSON.parse(JSON.stringify(EXAMPLE_DOC));

describe("schema", () => {
  it("l'exemple 5.6 valide", () => { expect(() => CompositionS.parse(EXAMPLE_DOC)).not.toThrow(); });
  it("rejette les champs inconnus (strict)", () => {
    const d: any = clone(); d.tracks[0].clips[0].bogus = 1;
    expect(CompositionS.safeParse(d).success).toBe(false);
  });
  it("migrate : v1 → v2", () => {
    const v1 = { tracks: [{ id: "t", kind: "overlay" }] };
    const m = migrate(v1);
    expect(m.v).toBe(2); expect(m.canvas.w).toBe(1080); expect(m.tracks[0].clips).toEqual([]);
  });
});

describe("schema — documents abîmés par MongoDB", () => {
  it("migrate répare un document dont les objets vides ont été supprimés", () => {
    const m = migrate({ v: 2, canvas: { w: 1080, h: 1920, fps: 30 }, tracks: [{ id: "v1", kind: "video", magnetic: true }] });
    expect(m.assets).toEqual({}); expect(m.transitions).toEqual([]); expect(m.tracks[0].clips).toEqual([]);
  });
  it("migrate refuse une version future au lieu de la dégrader", () => { expect(() => migrate({ v: 3 })).toThrow(/inconnue/); });
});

describe("engine — temps source ↔ timeline", () => {
  it("vitesse constante", () => {
    const c = { at: 1000, src: [0, 4000] as [number, number], speed: 2 };
    expect(srcToTimeline(c, 2000)).toBe(2000);
    expect(timelineToSrc(c, 2000)).toBe(2000);
  });
  it("rampe de vitesse (intégrale)", () => {
    const sp = { kf: [[0, 1], [1000, 2]] as [number, number][] };
    const c = { at: 0, src: [0, 5000] as [number, number], speed: sp };
    expect(timelineToSrc(c, 1000)).toBe(1500);
    expect(Math.abs(srcToTimeline(c, 1500) - 1000)).toBeLessThanOrEqual(2);
  });
  it("keyframes et easing", () => {
    expect(evalNum({ kf: [[0, 0], [1000, 10]] }, 500, 0)).toBe(5);
  });
  it("bruit seedé déterministe", () => { expect(seeded("c1", 5)).toBe(seeded("c1", 5)); expect(seeded("c1", 5)).not.toBe(seeded("c1", 6)); });
});

describe("engine — layout", () => {
  it("piste magnétique + transition (chevauchement)", () => {
    const L = layoutDoc(clone());
    expect(L.byId.c1.at).toBe(0); expect(L.byId.c1.dur).toBe(3200);
    expect(L.byId.c2.at).toBe(3000); // 3200 − 200 de transition
    expect(L.byId.c2.dur).toBe(4000);
  });
  it("ancre sur index de mots", () => {
    const L = layoutDoc(clone());
    expect(L.byId.t1.at).toBe(340); expect(L.byId.t1.dur).toBe(360);
  });
  it("mots hors du clip source : non rendu + avertissement", () => {
    const d: any = clone(); d.tracks[0].clips[0].src = [0, 300];
    const L = layoutDoc(d);
    expect(L.byId.t1.ok).toBe(false);
    expect(L.warnings.some((w) => w.code === "anchor_out_of_range")).toBe(true);
  });
  it("span d'un calque d'effet suit les clips", () => {
    const L = layoutDoc(clone());
    expect(L.byId.a1.at).toBe(0); expect(L.byId.a1.dur).toBe(7000);
  });
  it("buildFrameState : transition active dans le chevauchement", () => {
    const d = clone(); const L = layoutDoc(d);
    const s = buildFrameState(d, L, 3100);
    expect(s.transitions.length).toBe(1);
    expect(s.transitions[0].progress).toBeCloseTo(0.5, 1);
  });
});

describe("engine — opérations", () => {
  it("suppression d'un clip référencé : les ancres sont figées en at/dur", () => {
    const d = clone(); const L = layoutDoc(d);
    removeClip(d, L, "c1");
    const t1: any = d.tracks.find((t) => t.id === "txt")!.clips[0];
    expect(t1.anchor).toBeUndefined(); expect(t1.at).toBe(340); expect(t1.dur).toBe(360);
    expect(d.tracks.find((t) => t.id === "cap")!.clips.length).toBe(0);
    expect(() => CompositionS.parse(d)).not.toThrow();
  });
  it("coupe d'un clip vidéo au playhead", () => {
    const d = clone(); const L = layoutDoc(d);
    expect(splitClipAt(d, L, "c1", 1000, "c1b")).toBe("c1b");
    const v: any = d.tracks[0].clips;
    expect(v[0].src).toEqual([0, 1000]); expect(v[1].src).toEqual([1000, 3200]);
  });
});

describe("engine — validate", () => {
  it("effet inconnu ou désactivé : ignoré avec avertissement, sans crash", () => {
    const w = validate(clone(), (id) => id === "bw");
    expect(w.some((x) => x.code === "unknown_effect" && x.msg.includes("cloth_wave_v1"))).toBe(true);
  });
});
