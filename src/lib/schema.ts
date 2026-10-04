//src/lib/schema.ts
/**
 * schema.ts — LA source de vérité : modèle JSON (zod), types, defaults, migrate(), contrat d'effet.
 * Contient : primitives (Ms/Num/Col), Composition, Assets, Pistes/Clips, Brief, Settings, defineEffect,
 *            paramSpecs (formulaire généré), coerceParams (bornes), exemple 5.6.
 * Ne contient PAS : rendu, UI, accès réseau, accès base de données.
 *
 * CONVENTIONS SHADERS des effets (lues par render.tsx) :
 *  - fx / lut  : `shader` définit `vec4 fx(vec2 uv)` ; disponibles : sampler2D tMap, float uTime, vec2 uRes,
 *                float uSeed, helper `float hash(vec2)`, et un `uniform` par paramètre (nombre → float, "#hex" → vec3).
 *  - overlay   : `shader` définit `vec4 fx(vec2 uv)` dessiné plein cadre (alpha pré-multiplié non requis).
 *  - mesh      : `mesh.vertex` définit `vec3 deform(vec3 p, vec2 uv)` (p en pixels canvas, centré) ;
 *                disponibles : float uTime + un uniform par paramètre.
 *  - transition: `shader` définit `vec4 fx(vec2 uv)` ; disponibles : sampler2D tFrom, tTo, float uProgress.
 */
import { z } from "zod";
import type { ComponentType } from "react";

/* ────────────────────────── Primitives ────────────────────────── */
export type Ms = number;
export const ms = z.number().int().min(0).max(36_000_000);
const id = z.string().min(1).max(48);

const Kf = z.union([
  z.tuple([z.number(), z.number()]),
  z.tuple([z.number(), z.number(), z.string()]),
]);
export const NumS = z.union([z.number(), z.strictObject({ kf: z.array(Kf).min(1).max(64) })]);
export type Num = z.infer<typeof NumS>;
export const ColS = z.union([
  z.string().regex(/^#[0-9a-fA-F]{6}$/),
  z.strictObject({ kf: z.array(z.tuple([z.number(), z.string().regex(/^#[0-9a-fA-F]{6}$/)])).min(1).max(64) }),
]);
export type Col = z.infer<typeof ColS>;
export const PS = z.tuple([z.number(), z.number()]);
export type P = z.infer<typeof PS>;
const ParamValue = z.union([NumS, ColS, z.string().max(200), z.boolean()]);
export type ParamValue = z.infer<typeof ParamValue>;
const Params = z.record(z.string().max(40), ParamValue);

/* ────────────────────────── Defaults (rule 5.5.8) ────────────────────────── */
export const DEFAULTS = {
  canvas: { w: 1080, h: 1920, fps: 30 },
  fit: "cover" as const,
  z: 0,
  speed: 1,
  volume: 1,
  gain: 1,
  opacity: 1,
  clipDur: 2000,
} as const;
export const DOC_LIMITS = { tracks: 24, clipsPerTrack: 400, text: 500, bytes: 1_000_000 } as const;

/* ────────────────────────── Assets ────────────────────────── */
export const WordS = z.strictObject({ t: z.string().max(80), s: ms, e: ms });
export type Word = z.infer<typeof WordS>;
export const AssetS = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("video"), desc: z.string().max(500).optional(), name: z.string().max(200).optional(),
    w: z.number().int().positive(), h: z.number().int().positive(), dur: ms, fps: z.number().positive(),
    rot: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    hasAudio: z.boolean(), bytes: z.number().nonnegative(), fp: z.string().max(80),
    remote: z.string().max(300).optional(), proxy: z.string().max(300).optional(),
    words: z.array(WordS).max(20000).optional(),
  }),
  z.strictObject({ type: z.literal("audio"), name: z.string().max(200).optional(), remote: z.string().max(300).optional(), dur: ms, desc: z.string().max(500).optional(), fp: z.string().max(80).optional(), words: z.array(WordS).max(20000).optional() }),
  z.strictObject({ type: z.literal("image"), remote: z.string().max(300).optional(), w: z.number().int().positive(), h: z.number().int().positive(), fp: z.string().max(80).optional() }),
  z.strictObject({ type: z.enum(["svg", "lottie", "model3d"]), remote: z.string().max(300).optional() }),
  z.strictObject({
    type: z.literal("generated"), kind: z.enum(["image", "video"]), prompt: z.string().max(1000),
    status: z.enum(["pending", "ready", "failed"]), ref: z.string().max(48).optional(),
  }),
]);
export type Asset = z.infer<typeof AssetS>;
export type VideoAsset = Extract<Asset, { type: "video" }>;

/* ────────────────────────── Pistes et clips ────────────────────────── */
const Anchor = z.strictObject({
  clip: id, words: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  offset: z.number().int().optional(), dur: ms.optional(),
});
const Transform = z.strictObject({
  pos: z.strictObject({ x: NumS, y: NumS, z: NumS.optional() }).optional(),
  scale: z.union([NumS, z.strictObject({ x: NumS, y: NumS })]).optional(),
  rot: NumS.optional(),
  rot3d: z.strictObject({ x: NumS, y: NumS, z: NumS }).optional(),
  persp: z.number().min(0).max(4000).optional(),
  pivot: PS.optional(),
  corners: z.tuple([PS, PS, PS, PS]).optional(),
  opacity: NumS.optional(),
});
export type Transform = z.infer<typeof Transform>;
const FxRef = z.strictObject({ id: z.string().max(60), params: Params.optional() });
const Blend = z.enum(["normal", "add", "screen", "multiply", "overlay"]);

const visual = {
  id, at: ms.optional(), dur: ms.optional(), anchor: Anchor.optional(), transform: Transform.optional(),
  motion: z.strictObject({ preset: z.string().max(60), params: Params.optional() }).optional(),
  blend: Blend.optional(),
  matte: z.strictObject({ from: id, mode: z.enum(["alpha", "luma", "invert"]) }).optional(),
  behind: id.optional(),
  fx: z.array(FxRef).max(12).optional(),
  mesh: FxRef.optional(),
  z: z.number().optional(),
};
const Fill = z.looseObject({ type: z.enum(["color", "gradient", "media"]) });

export const VideoClipS = z.strictObject({
  ...visual, asset: id, src: z.tuple([ms, ms]), speed: NumS.optional(),
  fit: z.enum(["cover", "contain", "fill"]).optional(), volume: NumS.optional(),
});
export const AdjustmentClipS = z.strictObject({
  id, at: ms.optional(), dur: ms.optional(), span: z.tuple([id, id]).optional(), fx: z.array(FxRef).max(12),
});
export const OverlayClipS = z.strictObject({ ...visual, effect: z.string().max(60), params: Params.optional() });
export const TextClipS = z.strictObject({
  ...visual, text: z.string().max(DOC_LIMITS.text).optional(), params: Params.optional(),
  counter: z.strictObject({ from: z.number(), to: z.number(), suffix: z.string().max(20).optional(), dur: ms }).optional(),
  style: z.string().max(60),
  reveal: z.strictObject({ by: z.enum(["letters", "words", "lines"]), effect: z.string().max(60), stagger: ms.optional() }).optional(),
  fill: Fill.optional(), stroke: z.looseObject({}).optional(), glow: NumS.optional(),
});
export const CaptionClipS = z.strictObject({ ...visual, from: id, style: z.string().max(60), params: Params.optional(), emphasis: z.tuple([z.number().int(), z.number().int()]).optional() });
export const ShapeClipS = z.strictObject({
  ...visual, space: z.enum(["2d", "3d"]).optional(),
  shape: z.strictObject({
    preset: z.string().max(60).optional(), asset: id.optional(),
    path: z.array(z.tuple([ms, z.number(), z.number()])).max(512).optional(),
    morph: z.array(z.strictObject({ t: ms, to: z.string().max(60) })).max(32).optional(),
    fill: Fill.optional(), stroke: z.looseObject({}).optional(), extrude: z.number().min(0).max(1).optional(),
  }),
});
export const AudioClipS = z.strictObject({
  id, asset: z.string().max(80), src: z.tuple([ms, ms]).optional(), at: ms.optional(), anchor: Anchor.optional(),
  gain: NumS.optional(), fade: z.tuple([ms, ms]).optional(), dur: ms.optional(),
});

const tb = { id, locked: z.boolean().optional(), muted: z.boolean().optional() };
const clips = <T extends z.ZodType>(c: T) => z.array(c).max(DOC_LIMITS.clipsPerTrack);
export const TrackS = z.discriminatedUnion("kind", [
  z.strictObject({ ...tb, kind: z.literal("video"), magnetic: z.boolean().optional(), clips: clips(VideoClipS) }),
  z.strictObject({ ...tb, kind: z.literal("adjustment"), clips: clips(AdjustmentClipS) }),
  z.strictObject({ ...tb, kind: z.literal("overlay"), clips: clips(OverlayClipS) }),
  z.strictObject({ ...tb, kind: z.literal("text"), clips: clips(TextClipS) }),
  z.strictObject({ ...tb, kind: z.literal("caption"), clips: clips(CaptionClipS) }),
  z.strictObject({ ...tb, kind: z.literal("shape"), clips: clips(ShapeClipS) }),
  z.strictObject({ ...tb, kind: z.literal("audio"), clips: clips(AudioClipS) }),
]);
export type Track = z.infer<typeof TrackS>;
export type TrackKind = Track["kind"];
export type VideoClip = z.infer<typeof VideoClipS>;
export type AdjustmentClip = z.infer<typeof AdjustmentClipS>;
export type OverlayClip = z.infer<typeof OverlayClipS>;
export type TextClip = z.infer<typeof TextClipS>;
export type CaptionClip = z.infer<typeof CaptionClipS>;
export type ShapeClip = z.infer<typeof ShapeClipS>;
export type AudioClip = z.infer<typeof AudioClipS>;
export type Clip = Track["clips"][number];
export type FxRef = z.infer<typeof FxRef>;

export const TransitionS = z.strictObject({ between: z.tuple([id, id]), effect: z.string().max(60), dur: ms, params: Params.optional() });
export const CompositionS = z.strictObject({
  v: z.literal(2),
  canvas: z.strictObject({ w: z.number().int().min(64).max(4096), h: z.number().int().min(64).max(4096), fps: z.number().int().min(1).max(120) }),
  assets: z.record(z.string().max(48), AssetS),
  grade: z.strictObject({ lut: z.string().max(60), amount: NumS }).optional(),
  tracks: z.array(TrackS).max(DOC_LIMITS.tracks),
  transitions: z.array(TransitionS).max(400),
});
export type Composition = z.infer<typeof CompositionS>;

export const BriefS = z.strictObject({
  platform: z.enum(["tiktok", "reels", "shorts", "other"]),
  prompt: z.string().max(2000).optional(), targetDur: ms.optional(),
  style: z.string().max(200).optional(), lang: z.string().max(12).optional(),
});
export type Brief = z.infer<typeof BriefS>;

/* ────────────────────────── Projet, versions, réglages ────────────────────────── */
export const ProjectCreateS = z.strictObject({ name: z.string().min(1).max(120), brief: BriefS.optional(), example: z.boolean().optional() });
export const ProjectPatchS = z.strictObject({
  rev: z.number().int().min(0), doc: CompositionS.optional(), name: z.string().min(1).max(120).optional(),
  brief: BriefS.optional(), thumb: z.string().max(30_000).optional(), force: z.boolean().optional(),
});
export type ProjectSummary = { id: string; name: string; rev: number; thumb?: string; updatedAt: string; createdAt: string; brief: Brief };
export type ProjectFull = ProjectSummary & { doc: Composition };
export type VersionKind = "ai" | "auto" | "manual";

export const PlanS = z.strictObject({
  storageGB: z.number().min(0), dailyAnalyses: z.number().int().min(0), watermark: z.boolean(),
  maxProxyMinutes: z.number().min(1).max(120), signupCredits: z.number().min(0),
});
export const SettingsS = z.strictObject({
  rates: z.strictObject({ analysisPerMinute: z.number().min(0), generation: z.number().min(0), storagePerGBMonth: z.number().min(0) }),
  tokens: z.strictObject({ usdPerMTokIn: z.number().min(0), usdPerMTokOut: z.number().min(0), usdPerGBMonth: z.number().min(0), usdPerCredit: z.number().min(0) }),
  plans: z.record(z.string().max(20), PlanS),
  packs: z.array(z.strictObject({ id: z.string().max(30), label: z.string().max(60), credits: z.number().int().min(1), price: z.number().min(0), currency: z.string().max(5) })).max(12),
  inactivityDays: z.number().int().min(1).max(3650),
  disabledEffects: z.array(z.string().max(60)).max(500),
});
export type Settings = z.infer<typeof SettingsS>;
export const DEFAULT_SETTINGS: Settings = {
  rates: { analysisPerMinute: 10, generation: 25, storagePerGBMonth: 5 },
  tokens: { usdPerMTokIn: 0.5, usdPerMTokOut: 3, usdPerGBMonth: 0.015, usdPerCredit: 0.02 },
  plans: {
    free: { storageGB: 2, dailyAnalyses: 3, watermark: true, maxProxyMinutes: 10, signupCredits: 30 },
    pro: { storageGB: 50, dailyAnalyses: 30, watermark: false, maxProxyMinutes: 30, signupCredits: 0 },
  },
  packs: [
    { id: "p100", label: "100 crédits", credits: 100, price: 9, currency: "USD" },
    { id: "p500", label: "500 crédits", credits: 500, price: 39, currency: "USD" },
    { id: "p2000", label: "2000 crédits", credits: 2000, price: 129, currency: "USD" },
  ],
  inactivityDays: 60,
  disabledEffects: [],
};

/* ────────────────────────── Contrat d'effet (section 11.1) ────────────────────────── */
export type EffectKind =
  | "fx" | "mesh" | "overlay" | "transition" | "caption_style" | "text_style"
  | "shape_preset" | "motion_preset" | "lut" | "sfx";
export interface EffectProps { texture: unknown; params: Record<string, unknown>; t: Ms; size: { w: number; h: number } }
export interface DrawArgs {
  g: CanvasRenderingContext2D; w: number; h: number; t: Ms; dur: Ms; text: string;
  words?: { t: string; s: Ms; e: Ms }[]; emphasis?: [number, number]; params: Record<string, any>;
  reveal?: { by: "letters" | "words" | "lines"; stagger: Ms };
}
export interface MotionOut { scale?: number; opacity?: number; dx?: number; dy?: number; rot?: number }
export interface EffectDef<P extends z.ZodObject<any> = z.ZodObject<any>> {
  id: string; kind: EffectKind; status: "active" | "deprecated"; describe: string;
  params?: P; cost: "light" | "heavy";
  shader?: string; mesh?: { segments: [number, number]; vertex: string };
  Component?: ComponentType<EffectProps>; engine?: "canvas" | "sdf" | "extrude";
  draw?: (a: DrawArgs) => void;                       // text_style / caption_style (moteur canvas)
  motion?: (a: { t: Ms; dur: Ms; params: Record<string, any> }) => MotionOut; // motion_preset
  url?: string; duration?: Ms; fonts?: string[];
}
export function defineEffect<P extends z.ZodObject<any>>(d: EffectDef<P>): EffectDef<P> {
  return { ...d, params: d.params ?? (z.object({}) as unknown as P) };
}

export interface ParamSpec { key: string; type: "number" | "color" | "string" | "boolean" | "enum"; min: number; max: number; def: any; options?: string[] }
const specCache = new WeakMap<object, ParamSpec[]>();
/** Spécifications de paramètres tirées du zod de l'effet (formulaire Inspector + catalogue IA). */
export function paramSpecs(def: EffectDef): ParamSpec[] {
  const key = def.params ?? def;
  const hit = specCache.get(key);
  if (hit) return hit;
  let specs: ParamSpec[] = [];
  try {
    const js = z.toJSONSchema(def.params ?? z.object({}), { io: "input", unrepresentable: "any" }) as any;
    specs = Object.entries<any>(js.properties ?? {}).map(([k, p]) => {
      if (p.enum) return { key: k, type: "enum", min: 0, max: 0, def: p.default ?? p.enum[0], options: p.enum.map(String) } as ParamSpec;
      if (p.type === "number" || p.type === "integer")
        return { key: k, type: "number", min: p.minimum ?? -1e6, max: p.maximum ?? 1e6, def: p.default ?? p.minimum ?? 0 } as ParamSpec;
      if (p.type === "boolean") return { key: k, type: "boolean", min: 0, max: 0, def: p.default ?? false } as ParamSpec;
      const isCol = typeof p.default === "string" && /^#[0-9a-f]{6}$/i.test(p.default);
      return { key: k, type: isCol ? "color" : "string", min: 0, max: 0, def: p.default ?? "" } as ParamSpec;
    });
  } catch { specs = []; }
  specCache.set(key, specs);
  return specs;
}
/** Ramène les valeurs dans les bornes (jamais de rejet) ; complète avec les valeurs par défaut. */
export function coerceParams(def: EffectDef, raw: Record<string, unknown> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const s of paramSpecs(def)) {
    const v = raw?.[s.key];
    if (s.type === "number") out[s.key] = typeof v === "number" && Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : s.def;
    else if (s.type === "color") out[s.key] = typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : s.def;
    else if (s.type === "boolean") out[s.key] = typeof v === "boolean" ? v : s.def;
    else if (s.type === "enum") out[s.key] = typeof v === "string" && s.options!.includes(v) ? v : s.def;
    else out[s.key] = typeof v === "string" ? v : s.def;
  }
  return out;
}

/* ────────────────────────── Sortie IA (7.4) : seule la partie qui lui appartient ────────────────────────── */
export const AiOutputS = z.strictObject({
  words: z.record(z.string(), z.array(WordS)).default({}),
  descs: z.record(z.string(), z.string().max(500)).optional(),
  grade: CompositionS.shape.grade,
  tracks: z.array(TrackS).max(DOC_LIMITS.tracks),
  transitions: z.array(TransitionS).default([]),
});
export type AiOutput = z.infer<typeof AiOutputS>;

/* ────────────────────────── Fabriques et migration ────────────────────────── */
export function emptyComposition(): Composition {
  return { v: 2, canvas: { ...DEFAULTS.canvas }, assets: {}, tracks: [], transitions: [] };
}
/**
 * Migre un document vers la version courante ET le répare : MongoDB peut avoir supprimé des objets/tableaux vides
 * (assets, transitions, clips). Lève si la version est inconnue (plus récente) ou le document irrécupérable.
 */
export function migrate(raw: unknown): Composition {
  const r: any = typeof raw === "object" && raw ? { ...(raw as object) } : {};
  if (r.v !== undefined && r.v !== 1 && r.v !== 2) throw new Error(`Version de document inconnue (${r.v}).`);
  r.v = 2;
  r.canvas = { ...DEFAULTS.canvas, ...(r.canvas ?? {}) };
  r.assets ??= {};
  r.transitions ??= [];
  r.tracks = (r.tracks ?? []).map((t: any) => ({ ...t, clips: t.clips ?? [] }));
  return CompositionS.parse(r);
}

/** Exemple 5.6 (doit passer la validation). */
export const EXAMPLE_DOC: Composition = {
  v: 2,
  canvas: { w: 1080, h: 1920, fps: 30 },
  assets: {
    r1: { type: "video", w: 1920, h: 1080, dur: 42500, fps: 30, hasAudio: true, bytes: 85_000_000, fp: "example-r1",
      words: [{ t: "Voici", s: 0, e: 320 }, { t: "pourquoi", s: 340, e: 700 }] },
    r2: { type: "video", w: 1080, h: 1920, dur: 18000, fps: 30, hasAudio: true, bytes: 42_000_000, fp: "example-r2" },
  },
  grade: { lut: "teal_orange", amount: 0.7 },
  tracks: [
    { id: "v1", kind: "video", magnetic: true, clips: [
      { id: "c1", asset: "r1", src: [0, 3200], speed: 1,
        transform: { scale: { kf: [[0, 1], [3200, 1.15, "outCubic"]] } }, mesh: { id: "cloth_wave_v1", params: { amp: 0.05 } } },
      { id: "c2", asset: "r2", src: [5000, 9000] },
    ] },
    { id: "adj1", kind: "adjustment", clips: [{ id: "a1", span: ["c1", "c2"], fx: [{ id: "bw" }] }] },
    { id: "txt", kind: "text", clips: [
      { id: "t1", anchor: { clip: "c1", words: [1, 1] }, text: "Pourquoi", style: "clean_title",
        reveal: { by: "letters", effect: "rise", stagger: 40 }, motion: { preset: "pop_in" } },
    ] },
    { id: "cap", kind: "caption", clips: [{ id: "k1", from: "c1", style: "minimal_clean", emphasis: [1, 1] }] },
    { id: "ov", kind: "overlay", clips: [{ id: "o1", effect: "frame_neon_v1", params: { color: "#00F0FF" }, at: 0, dur: 3200, blend: "add" }] },
  ],
  transitions: [{ between: ["c1", "c2"], effect: "glitch_cut", dur: 200 }],
};
