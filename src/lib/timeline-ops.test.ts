//src/lib/timeline-ops.test.ts
/** timeline-ops.test.ts — réordonner les pistes, changer un clip de piste, déposer un média, remplacer un média, transitions, application d'effets. */
import { describe, it, expect, beforeEach } from "vitest";
import { useEditor } from "./store";
import { CompositionS, emptyComposition, type Composition } from "./schema";
import { layoutDoc } from "./engine";

const vid = (o: object = {}) => ({ type: "video", name: "a.mp4", w: 1080, h: 1920, dur: 8000, fps: 30, hasAudio: true, bytes: 1, fp: "f", ...o }) as const;
const base = (): Composition => ({ ...emptyComposition(),
  assets: { r1: { ...vid() }, r2: { ...vid({ dur: 3000, name: "b.mp4" }) }, mute: { ...vid({ hasAudio: false }) }, im: { type: "image", name: "p.png", w: 400, h: 300, fp: "i" }, snd: { type: "audio", name: "m.mp3", dur: 10000, fp: "s" } },
  tracks: [
    { id: "v1", kind: "video", magnetic: true, clips: [{ id: "c1", asset: "r1", src: [0, 4000] }, { id: "c2", asset: "r1", src: [4000, 8000] }] },
    { id: "free", kind: "video", clips: [{ id: "f1", asset: "r1", src: [0, 2000], at: 1000, dur: 2000, speed: 2, volume: 0.5, afx: [{ id: "echo_v1" }] }] },
    { id: "ta", kind: "text", clips: [{ id: "t1", text: "A", style: "clean_title", at: 500, dur: 1500 }] },
    { id: "tb", kind: "text", clips: [] },
    { id: "au", kind: "audio", clips: [{ id: "a1", asset: "snd", src: [0, 10000], at: 0, dur: 10000 }] },
  ] });
const load = (d = base()) => useEditor.getState().load({ id: "p", name: "t", rev: 0, brief: { platform: "tiktok" }, doc: d });
const st = () => useEditor.getState(), doc = () => st().doc, ids = () => doc().tracks.map((t) => t.id);
const track = (id: string) => doc().tracks.find((t) => t.id === id)!;
const valid = () => expect(() => CompositionS.parse(doc())).not.toThrow();
beforeEach(() => load());

describe("ordre des pistes", () => {
  it("monter / descendre échange avec la voisine, sans effet aux extrémités", () => {
    st().moveTrack("v1", "up"); expect(ids().slice(0, 2)).toEqual(["free", "v1"]);
    st().moveTrack("v1", "down"); expect(ids().slice(0, 2)).toEqual(["v1", "free"]);
    st().moveTrack("v1", "down"); expect(ids()[0]).toBe("v1"); st().moveTrack("au", "up"); expect(ids().at(-1)).toBe("au");
  });
  it("réordonner à un rang précis, annulable", () => { st().reorderTrack("au", 0); expect(ids()[0]).toBe("au"); st().undo(); expect(ids()[0]).toBe("v1"); valid(); });
});

describe("changer un clip de piste (même type)", () => {
  it("texte → autre piste texte : at et dur conservés ; type différent, piste verrouillée ou même piste : refusé", () => {
    expect(st().moveClipToTrack("t1", "tb", 900)).toBe(true);
    expect(track("ta").clips.length).toBe(0); expect(track("tb").clips[0]).toMatchObject({ id: "t1", at: 500, dur: 1500 });
    expect(st().moveClipToTrack("t1", "au")).toBe(false); expect(st().moveClipToTrack("t1", "tb")).toBe(false);
    load(); st().toggleTrack("tb", "locked"); expect(st().moveClipToTrack("t1", "tb")).toBe(false); valid();
  });
  it("piste libre → piste principale : at/dur retirés, placé selon l'instant (centre du clip)", () => {
    expect(st().moveClipToTrack("f1", "v1", 9000)).toBe(true);
    const c: any[] = track("v1").clips; expect(c.map((x) => x.id)).toEqual(["c1", "c2", "f1"]); expect(c[2].at).toBeUndefined(); expect(c[2].dur).toBeUndefined();
    valid();
  });
  it("piste principale → piste libre : at et dur figés à la position actuelle", () => {
    const at = layoutDoc(doc()).byId.c2.at; expect(st().moveClipToTrack("c2", "free", 6000)).toBe(true);
    expect(track("free").clips.find((c) => c.id === "c2")).toMatchObject({ at: 6000, dur: 4000 }); expect(at).toBe(4000); valid();
  });
  it("quitter la piste principale supprime les transitions qui touchent le clip", () => {
    const d = base(); d.transitions = [{ between: ["c1", "c2"], effect: "crossfade_v1", dur: 400 }]; load(d);
    st().moveClipToTrack("c2", "free", 0); expect(doc().transitions).toEqual([]); valid();
  });
});

describe("glisser un média sur une piste", () => {
  it("image sur piste libre à l'instant du dépôt ; son sur piste audio", () => {
    expect(st().dropAsset("im", "free", 2500)).toMatchObject({ ok: true }); expect(track("free").clips.at(-1)).toMatchObject({ asset: "im", at: 2500, dur: 3000, fit: "contain" });
    expect(st().dropAsset("snd", "au", 1200).ok).toBe(true); expect(track("au").clips.at(-1)).toMatchObject({ asset: "snd", at: 1200 }); valid();
  });
  it("vidéo sur la piste principale : insérée à la bonne place selon l'instant", () => {
    expect(st().dropAsset("r2", "v1", 3000).ok).toBe(true); expect((track("v1").clips as any[]).map((c) => c.asset)).toEqual(["r1", "r2", "r1"]);
    load(); st().dropAsset("r2", "v1", 100); expect((track("v1").clips as any[]).map((c) => c.asset)).toEqual(["r2", "r1", "r1"]);
    load(); st().dropAsset("r2", "v1", 9000); expect((track("v1").clips as any[]).map((c) => c.asset)).toEqual(["r1", "r1", "r2"]); valid();
  });
  it("média incompatible ou piste verrouillée : refusé avec un message", () => {
    expect(st().dropAsset("snd", "free", 0)).toMatchObject({ ok: false, msg: expect.stringContaining("ne va pas") });
    expect(st().dropAsset("r1", "au", 0).ok).toBe(false); expect(st().dropAsset("r1", "ta", 0).ok).toBe(false);
    st().toggleTrack("free", "locked"); expect(st().dropAsset("im", "free", 0)).toMatchObject({ ok: false, msg: expect.stringContaining("verrouillée") });
  });
});

describe("remplacer le média d'un clip", () => {
  it("vidéo → image : durée gardée, vitesse/volume/effets audio retirés, cadrage « contenir »", () => {
    expect(st().replaceClipAsset("f1", "im").ok).toBe(true);
    const c: any = track("free").clips[0]; expect(c).toMatchObject({ asset: "im", src: [0, 1000], fit: "contain", dur: 1000, at: 1000 });   // le clip ×2 durait 1 s à l'écran : on garde 1 s expect([c.speed, c.volume, c.afx]).toEqual([undefined, undefined, undefined]); valid();
  });
  it("vidéo → vidéo plus courte : la source est bornée à la durée du nouveau média ; sans son : effets audio retirés", () => {
    st().replaceClipAsset("c1", "r2"); expect((track("v1").clips[0] as any).src).toEqual([0, 3000]);
    st().replaceClipAsset("f1", "mute"); expect((track("free").clips[0] as any).afx).toBeUndefined(); valid();
  });
  it("son → son ; type incompatible refusé", () => {
    expect(st().replaceClipAsset("a1", "snd").ok).toBe(true); expect(st().replaceClipAsset("a1", "r1").ok).toBe(false); expect(st().replaceClipAsset("c1", "snd").ok).toBe(false); expect(st().replaceClipAsset("nope", "im").ok).toBe(false);
  });
  it("prévient quand des sous-titres ou textes ancrés dépendent du clip", () => {
    const d = base(); d.assets.r1 = { ...vid(), words: [{ t: "a", s: 0, e: 100 }] } as any; d.tracks.push({ id: "cap", kind: "caption", clips: [{ id: "k1", from: "c1", style: "minimal_clean" }] }); load(d);
    expect(st().replaceClipAsset("c1", "r2").msg).toMatch(/sous-titres/);
  });
});

describe("transitions", () => {
  it("poser, remplacer, ajuster la durée, retirer", () => {
    expect(st().setTransition("c1", "crossfade_v1", 500).ok).toBe(true); expect(doc().transitions).toEqual([{ between: ["c1", "c2"], effect: "crossfade_v1", dur: 500 }]);
    st().setTransition("c1", "slide_v1", 300); expect(doc().transitions).toEqual([{ between: ["c1", "c2"], effect: "slide_v1", dur: 300 }]);
    st().setTransition("c1", null); expect(doc().transitions).toEqual([]); valid();
  });
  it("dernier clip ou piste libre : refusé avec explication", () => {
    expect(st().setTransition("c2", "crossfade_v1")).toMatchObject({ ok: false, msg: expect.stringContaining("dernier") });
    expect(st().setTransition("f1", "crossfade_v1")).toMatchObject({ ok: false, msg: expect.stringContaining("principale") });
  });
  it("la transition crée un chevauchement dans la timeline", () => { st().setTransition("c1", "crossfade_v1", 400); const L = layoutDoc(doc()); expect(L.byId.c2.at).toBe(3600); });
});

describe("appliquer n'importe quel type d'effet", () => {
  it("fx : sur le clip sélectionné ; sans sélection : calque d'effets créé", () => {
    st().select("c1"); expect(st().applyEffect("vignette").ok).toBe(true); expect((track("v1").clips[0] as any).fx).toEqual([{ id: "vignette" }]);
    st().select(null); expect(st().applyEffect("bw").ok).toBe(true); expect(track(ids().at(-1)!).kind).toBe("adjustment");
  });
  it("lut : look global, intensité conservée", () => { st().applyEffect("teal_orange"); expect(doc().grade).toEqual({ lut: "teal_orange", amount: 0.7 }); st().apply("x", (d) => { d.grade!.amount = 0.3; }); st().applyEffect("teal_orange"); expect(doc().grade!.amount).toBe(0.3); });
  it("transition : demande un clip de la piste principale", () => {
    expect(st().applyEffect("crossfade_v1").ok).toBe(false); st().select("c1"); expect(st().applyEffect("slide_v1").ok).toBe(true); expect(doc().transitions[0].effect).toBe("slide_v1");
  });
  it("overlay, déformation, animation, style de texte", () => {
    expect(st().applyEffect("frame_neon_v1").ok).toBe(true); expect(doc().tracks.some((t) => t.kind === "overlay")).toBe(true);
    expect(st().applyEffect("cloth_wave_v1").ok).toBe(false); st().select("c1"); expect(st().applyEffect("cloth_wave_v1").ok).toBe(true); expect(st().applyEffect("ken_burns_v1").ok).toBe(true);
    expect(track("v1").clips[0]).toMatchObject({ mesh: { id: "cloth_wave_v1" }, motion: { preset: "ken_burns_v1" } });
    st().select("t1"); st().applyEffect("clean_title"); expect((track("ta").clips[0] as any).style).toBe("clean_title"); valid();
  });
  it("effet audio : clip avec son seulement", () => {
    st().select("c1"); expect(st().applyEffect("echo_v1").ok).toBe(true); expect((track("v1").clips[0] as any).afx).toEqual([{ id: "echo_v1" }]);
    const d = base(); d.tracks.push({ id: "m", kind: "video", clips: [{ id: "mm", asset: "mute", src: [0, 1000], at: 0, dur: 1000 }] }); load(d);
    st().select("mm"); expect(st().applyEffect("echo_v1")).toMatchObject({ ok: false, msg: expect.stringContaining("son") });
    st().select("a1"); expect(st().applyEffect("autotune_v1").ok).toBe(true); valid();
  });
  it("effet inconnu : message clair", () => { expect(st().applyEffect("nope_v9")).toMatchObject({ ok: false }); });
});
