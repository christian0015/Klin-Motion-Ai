//src/lib/media.test.ts
/** media.test.ts — images et sons : schéma, placement, rognage/coupe audio, conservation lors du montage IA. */
import { describe, it, expect, beforeEach } from "vitest";
import { useEditor } from "./store";
import { CompositionS, emptyComposition, type Composition } from "./schema";
import { layoutDoc, splitClipAt } from "./engine";
import { mergeAi } from "./gemini";

const vid = { type: "video", name: "a.mp4", w: 1080, h: 1920, dur: 8000, fps: 30, hasAudio: true, bytes: 1000, fp: "f1" } as const;
const mk = (): Composition => ({ ...emptyComposition(), assets: { r1: { ...vid }, im: { type: "image", name: "logo.png", w: 400, h: 300, fp: "f2", bytes: 5000 }, snd: { type: "audio", name: "music.mp3", dur: 10000, fp: "f3", bytes: 9000 } } });
const load = (doc: Composition) => useEditor.getState().load({ id: "p1", name: "t", rev: 0, brief: { platform: "tiktok" }, doc });
const st = () => useEditor.getState();

describe("schéma : images et sons", () => {
  it("assets image/audio avec name et bytes valides", () => { expect(() => CompositionS.parse(mk())).not.toThrow(); });
  it("une image dans un clip vidéo : durée = src, valide", () => {
    const d = mk(); d.tracks.push({ id: "img", kind: "video", clips: [{ id: "i1", asset: "im", src: [0, 3000], at: 500, dur: 3000, fit: "contain" }] });
    expect(() => CompositionS.parse(d)).not.toThrow(); const p = layoutDoc(d).byId.i1; expect([p.at, p.dur, p.ok]).toEqual([500, 3000, true]);
  });
});

describe("placement des médias", () => {
  beforeEach(() => load(mk()));
  it("vidéo → piste magnétique v1 ; image → piste libre (fit contain, 3 s) ; audio → piste audio", () => {
    expect(st().placeAsset("r1").ok).toBe(true); expect(st().placeAsset("im").ok).toBe(true); expect(st().placeAsset("snd").ok).toBe(true);
    const d = st().doc, v1: any = d.tracks.find((t) => t.id === "v1"), img: any = d.tracks.find((t) => t.kind === "video" && !t.magnetic), au: any = d.tracks.find((t) => t.kind === "audio");
    expect(v1.magnetic).toBe(true); expect(v1.clips[0].src).toEqual([0, 8000]);
    expect(img.clips[0]).toMatchObject({ asset: "im", fit: "contain", dur: 3000, src: [0, 3000] });
    expect(au.clips[0]).toMatchObject({ asset: "snd", dur: 10000, gain: 1 });
    expect(() => CompositionS.parse(d)).not.toThrow();
  });
  it("une 2e image réutilise la piste libre existante", () => {
    st().placeAsset("im"); st().placeAsset("im"); const tr = st().doc.tracks.filter((t) => t.kind === "video");
    expect(tr.length).toBe(1); expect(tr[0].clips.length).toBe(2);
  });
});

describe("audio : rognage et coupe", () => {
  const audioDoc = () => { const d = mk(); d.tracks.push({ id: "a", kind: "audio", clips: [{ id: "a1", asset: "snd", src: [0, 10000], at: 2000, dur: 10000, gain: 1 }] }); return d; };
  it("rogner le début décale at, src et dur ensemble", () => {
    load(audioDoc()); st().trimClip("a1", "l", 1000);
    expect(st().doc.tracks[0].clips[0]).toMatchObject({ src: [1000, 10000], at: 3000, dur: 9000 });
  });
  it("rogner la fin ajuste src et dur", () => {
    load(audioDoc()); st().trimClip("a1", "r", -4000);
    expect(st().doc.tracks[0].clips[0]).toMatchObject({ src: [0, 6000], at: 2000, dur: 6000 });
  });
  it("couper un audio donne deux clips contigus", () => {
    const d = audioDoc(); const L = layoutDoc(d); expect(splitClipAt(d, L, "a1", 7000, "a2")).toBe("a2");
    const [a, b]: any[] = d.tracks[0].clips; expect([a.at, a.dur, b.at, b.dur]).toEqual([2000, 5000, 7000, 5000]); expect([a.src[1], b.src[0]]).toEqual([5000, 5000]);
    expect(() => CompositionS.parse(d)).not.toThrow();
  });
});

describe("montage IA : conserve les images et sons ajoutés à la main", () => {
  it("pistes image/audio réinjectées, ids uniques, ancres retirées", () => {
    const base = mk();
    base.tracks.push({ id: "v1", kind: "video", clips: [{ id: "i1", asset: "im", src: [0, 3000], at: 0, dur: 3000 }] });
    base.tracks.push({ id: "a", kind: "audio", clips: [{ id: "a1", asset: "snd", src: [0, 10000], at: 0, dur: 10000 }, { id: "a2", asset: "snd", src: [0, 500], anchor: { clip: "c1", words: [0, 0] } }] });
    const ai: any = { words: {}, tracks: [{ id: "v1", kind: "video", magnetic: true, clips: [{ id: "i1", asset: "r1", src: [0, 4000] }] }], transitions: [] };
    const out = mergeAi(base, ai);
    expect(out.tracks.length).toBe(3);
    const ids = out.tracks.flatMap((t) => [t.id, ...t.clips.map((c) => c.id)]); expect(new Set(ids).size).toBe(ids.length);
    const audio = out.tracks.find((t) => t.kind === "audio")!; expect(audio.clips.length).toBe(1);
    const img = out.tracks.find((t) => t.kind === "video" && !t.magnetic)!; expect((img.clips[0] as any).asset).toBe("im");
    expect(() => CompositionS.parse(out)).not.toThrow();
  });
});
