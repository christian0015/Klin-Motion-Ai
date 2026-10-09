//src/effects/registry.test.ts
/**
 * registry.test.ts — TEST DE CONFORMITÉ de tout le registre : lancé par `npm test`, il refuse un effet qui ne respecte pas le contrat
 * (id, describe, bornes des paramètres, noms d'uniforms, signature du shader, pureté de draw/motion).
 * C'est le filet de sécurité de quiconque ajoute un effet sans voir le reste du code. Ne teste PAS le rendu visuel (WebGL).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EFFECTS } from "./index";
import { coerceParams, paramSpecs } from "@/lib/schema";

const RESERVED = new Set(["tMap", "tFrom", "tTo", "uTime", "uRes", "uSeed", "uAmount", "uProgress", "uSize", "uC", "uCorners", "uOpacity", "uPremult", "vUv", "position", "uv", "hash", "fx", "deform", "main",
  "input", "output", "sample", "filter", "half", "fixed", "common", "active", "partition", "class", "union", "enum", "typedef", "template", "this", "packed", "goto", "inline", "noinline", "volatile", "public", "static", "extern", "external", "interface", "long", "short", "double", "unsigned", "namespace", "using", "sizeof", "cast", "default", "switch", "case", "do", "for", "while", "if", "else", "return", "discard", "break", "continue", "float", "int", "bool", "vec2", "vec3", "vec4", "mat2", "mat3", "mat4", "uniform", "varying", "attribute", "const", "in", "out", "inout", "void", "true", "false", "struct", "highp", "mediump", "lowp", "precision", "layout", "centroid", "flat", "smooth", "texture"]);
const stubCtx = () => new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 12 }) : () => {}), set: () => true }) as any;
const SHADER_KINDS = ["fx", "lut", "overlay", "transition"];
/** Contexte Web Audio factice : chaque nœud accepte connect/disconnect, les AudioParam acceptent value et les rampes. */
const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} });
const anyNode = (): any => new Proxy({ connect: (n: any) => n, disconnect() {} } as any, { get: (t, k) => (k in t ? t[k] : param()), set: (t, k, v) => { t[k] = v; return true; } });
const fakeCtx = (): any => ({ sampleRate: 48000, currentTime: 0, destination: anyNode(), audioWorklet: { addModule: async () => {} },
  createGain: anyNode, createDelay: anyNode, createBiquadFilter: anyNode, createConvolver: anyNode, createWaveShaper: anyNode, createStereoPanner: anyNode, createChannelSplitter: anyNode, createChannelMerger: anyNode, createDynamicsCompressor: anyNode, createOscillator: anyNode,
  createBuffer: (c: number, len: number) => ({ numberOfChannels: c, length: len, getChannelData: () => new Float32Array(len) }) });
(globalThis as any).Path2D ??= class {};
(globalThis as any).AudioWorkletNode ??= class { constructor() { return anyNode(); } };

afterEach(() => vi.restoreAllMocks());

describe("registre d'effets", () => {
  it("identifiants uniques", () => { const ids = EFFECTS.map((e) => e.id); expect(new Set(ids).size).toBe(ids.length); });

  for (const e of EFFECTS) describe(`${e.id} [${e.kind}]`, () => {
    it("identité", () => {
      expect(e.id).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
      expect(e.describe.length).toBeGreaterThanOrEqual(20); expect(e.describe.length).toBeLessThanOrEqual(240);
      expect(["active", "deprecated"]).toContain(e.status); expect(["light", "heavy"]).toContain(e.cost);
    });
    it("paramètres : bornes et défauts", () => {
      for (const s of paramSpecs(e)) {
        if (s.type === "number") { expect(s.min, `${s.key}.min`).toBeGreaterThan(-1e6); expect(s.max, `${s.key}.max`).toBeLessThan(1e6); expect(s.def).toBeGreaterThanOrEqual(s.min); expect(s.def).toBeLessThanOrEqual(s.max); }
        if (SHADER_KINDS.includes(e.kind) || e.kind === "mesh") {
          expect(s.key, `nom d'uniform « ${s.key} »`).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
          expect(RESERVED.has(s.key), `« ${s.key} » est un nom réservé`).toBe(false);
        }
      }
    });
    if (SHADER_KINDS.includes(e.kind)) it("shader : fx(vec2 uv) sans main ni redéclaration", () => {
      expect(e.shader ?? "").toMatch(/vec4\s+fx\s*\(\s*vec2\s+uv\s*\)/);
      expect(e.shader).not.toMatch(/#version|void\s+main\s*\(/);
      expect(e.shader).not.toMatch(/uniform\s+\w+\s+(tMap|tFrom|tTo|uTime|uRes|uSeed|uAmount|uProgress)\b/);
    });
    if (e.kind === "mesh") it("mesh : deform(vec3 p, vec2 uv) et segments valides", () => {
      expect(e.mesh?.vertex ?? "").toMatch(/vec3\s+deform\s*\(\s*vec3\s+p\s*,\s*vec2\s+uv\s*\)/);
      for (const n of e.mesh!.segments) { expect(Number.isInteger(n)).toBe(true); expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(128); }
    });
    if (e.kind === "caption_style" || e.kind === "text_style" || e.kind === "shape_preset") it("draw : moteur canvas, déterministe, sans Math.random ni Date.now", () => {
      expect(e.engine).toBe("canvas"); expect(typeof e.draw).toBe("function");
      vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("Math.random interdit : utiliser seeded()"); });
      vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("Date.now interdit : le rendu est pur en fonction de t"); });
      const words = [{ t: "Bonjour", s: 0, e: 400 }, { t: "le", s: 420, e: 600 }, { t: "monde", s: 620, e: 1000 }];
      for (const t of [0, 500, 1999]) e.draw!({ g: stubCtx(), w: 540, h: 960, t, dur: 2000, text: "Bonjour le monde", words, emphasis: [1, 1], params: coerceParams(e, {}), reveal: { by: "letters", stagger: 40 }, svg: { w: 100, h: 100, items: [{ d: "M0 0L50 50", fill: "#fff", stroke: "#000", sw: 1, opacity: 1, m: [1, 0, 0, 1, 0, 0], len: 70 }] } });
    });
    if (e.kind === "motion_preset") it("motion : pure et finie", () => {
      expect(typeof e.motion).toBe("function");
      for (const t of [0, 300, 999]) { const a = e.motion!({ t, dur: 1000, params: {} }), b = e.motion!({ t, dur: 1000, params: {} }); expect(a).toEqual(b); for (const v of Object.values(a)) expect(Number.isFinite(v)).toBe(true); }
    });
    if (e.kind === "audio_fx") it("audio : build renvoie input/output avec un contexte factice, sans Math.random", async () => {
      expect(typeof e.audio?.build).toBe("function");
      vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("Math.random interdit : le rendu doit être identique en aperçu et à l'export"); });
      const ctx = fakeCtx(); await e.audio!.setup?.(ctx);
      const n = e.audio!.build({ ctx, params: coerceParams(e, {}), dur: 2 });
      expect(n.input).toBeTruthy(); expect(n.output).toBeTruthy();
    });
    if (e.kind === "sfx") it("sfx : url sous /sfx/ et durée", () => { expect(e.url ?? "").toMatch(/^\/sfx\/[\w.-]+\.(mp3|ogg|wav|m4a)$/); expect(e.duration ?? 0).toBeGreaterThan(0); });
  });
});
