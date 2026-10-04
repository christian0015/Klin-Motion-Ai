//src/lib/store.test.ts
/** store.test.ts — pistes avec élément par défaut, ajout/suppression ; garde-fou du rendu (uniforms jamais réassignés). */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { useEditor } from "./store";
import { CompositionS, EXAMPLE_DOC, emptyComposition } from "./schema";

const load = (doc = emptyComposition()) => useEditor.getState().load({ id: "p1", name: "t", rev: 0, brief: { platform: "tiktok" }, doc });
const doc = () => useEditor.getState().doc;

describe("pistes : élément par défaut", () => {
  beforeEach(() => load());
  it("texte : style du registre + animation, sélectionné, document valide", () => {
    const id = useEditor.getState().addTrack("text"); const r = useEditor.getState().addDefaultClip(id);
    expect(r.ok).toBe(true);
    const c: any = doc().tracks[0].clips[0];
    expect(c.style).toBe("clean_title"); expect(c.motion?.preset).toBe("pop_in"); expect(useEditor.getState().selection).toBe(c.id);
    expect(() => CompositionS.parse(doc())).not.toThrow();
  });
  it("overlay et calque d'effets", () => {
    const o = useEditor.getState().addTrack("overlay"), a = useEditor.getState().addTrack("adjustment");
    expect(useEditor.getState().addDefaultClip(o).ok).toBe(true); expect(useEditor.getState().addDefaultClip(a).ok).toBe(true);
    expect((doc().tracks[0].clips[0] as any).effect).toBe("frame_neon_v1"); expect((doc().tracks[1].clips[0] as any).fx[0].id).toBe("vignette");
    expect(() => CompositionS.parse(doc())).not.toThrow();
  });
  it("vidéo sans rush : refus explicite ; audio : renvoie vers l'import", () => {
    const v = useEditor.getState().addTrack("video"), au = useEditor.getState().addTrack("audio");
    expect(useEditor.getState().addDefaultClip(v)).toMatchObject({ ok: false, msg: expect.stringContaining("rush") });
    expect(useEditor.getState().addDefaultClip(au)).toMatchObject({ ok: false, msg: expect.stringContaining("audio") });
  });
  it("sous-titres : refus sans vidéo ; OK avec un clip vidéo", () => {
    const cap = useEditor.getState().addTrack("caption");
    expect(useEditor.getState().addDefaultClip(cap).ok).toBe(false);
    load(JSON.parse(JSON.stringify(EXAMPLE_DOC)));
    const c2 = useEditor.getState().addTrack("caption"); const r = useEditor.getState().addDefaultClip(c2);
    expect(r.ok).toBe(true); expect((doc().tracks.at(-1)!.clips[0] as any).style).toBe("minimal_clean");
  });
  it("sous-titres sans transcription : mots d'exemple visibles et valides", () => {
    load(JSON.parse(JSON.stringify(EXAMPLE_DOC))); useEditor.getState().select("c2");
    const id = useEditor.getState().addTrack("caption"), r = useEditor.getState().addDefaultClip(id);
    expect(r.ok).toBe(true); expect(r.msg).toContain("exemple");
    const a: any = doc().assets.r2; expect(a.words.map((w: any) => w.t)).toEqual(["Vos", "sous-titres", "ici"]);
    expect(a.words[0].s).toBeGreaterThanOrEqual(5000); expect(a.words[2].e).toBeLessThanOrEqual(9000);
    expect(() => CompositionS.parse(doc())).not.toThrow();
  });
  it("seule une piste vide peut être supprimée", () => {
    load(JSON.parse(JSON.stringify(EXAMPLE_DOC))); const n = doc().tracks.length;
    useEditor.getState().removeTrack("v1"); expect(doc().tracks.length).toBe(n);
    const e = useEditor.getState().addTrack("shape"); useEditor.getState().removeTrack(e); expect(doc().tracks.length).toBe(n);
  });
});

describe("rushs", () => {
  it("supprimer un rush retire ses clips, les sous-titres liés, l'asset et son état de synchro", () => {
    load(JSON.parse(JSON.stringify(EXAMPLE_DOC))); useEditor.getState().setSync("r1", { state: "missing" }); useEditor.getState().setProblem("r1", "x");
    useEditor.getState().removeAsset("r1");
    const st = useEditor.getState();
    expect(st.doc.assets.r1).toBeUndefined(); expect(st.sync.r1).toBeUndefined(); expect(st.problems.r1).toBeUndefined();
    expect((st.doc.tracks as { clips: any[] }[]).flatMap((t) => t.clips).some((c) => c.asset === "r1" || c.from === "c1")).toBe(false);
    expect((st.doc.tracks.find((t) => t.id === "txt")!.clips[0] as any).anchor).toBeUndefined();   // ancre figée en at/dur
    expect(() => CompositionS.parse(st.doc)).not.toThrow();
    useEditor.getState().undo(); expect(useEditor.getState().doc.assets.r1).toBeDefined();           // annulable
  });
});

describe("rendu : garde-fou three.js", () => {
  it("`material.uniforms` n'est jamais réassigné (three.js le capture au 1er rendu → valeurs figées, écran noir)", () => {
    const src = readFileSync(process.cwd() + "/src/lib/render.tsx", "utf8").split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"));
    const bad = src.filter((l) => /\.uniforms\s*=[^=]/.test(l));
    expect(bad).toEqual([]);
  });
});
