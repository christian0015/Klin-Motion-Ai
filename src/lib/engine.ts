//src/lib/engine.ts
/**
 * engine.ts — maths du temps et résolution de la timeline (pur, déterministe).
 * Contient : evalNum/evalCol (keyframes), srcToTimeline/timelineToSrc, layoutDoc (piste magnétique,
 *            ancres, spans), buildFrameState, validate, removeClip, splitClipAt, originalDoc, bruit seedé.
 * Ne contient PAS : rendu, UI, accès réseau, Date.now(), Math.random().
 */
import {
  DEFAULTS, type Clip, type Col, type Composition, type MotionOut, type Num, type Track, type TrackKind,
  type Transform, type VideoClip, type Word, type Ms,
} from "./schema";

export interface Warning { clipId?: string; code: string; msg: string }

/* ────────────────────────── Interpolation ────────────────────────── */
const EASE: Record<string, (x: number) => number> = {
  linear: (x) => x,
  inQuad: (x) => x * x, outQuad: (x) => 1 - (1 - x) * (1 - x),
  inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  inCubic: (x) => x ** 3, outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outBack: (x) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2),
  outExpo: (x) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  hold: () => 0,
};
export const EASES = Object.keys(EASE);
export const ease = (name: string | undefined, x: number) => (EASE[name ?? "linear"] ?? EASE.linear)(Math.min(1, Math.max(0, x)));

export const isKf = (n: unknown): n is { kf: [number, number, string?][] } => typeof n === "object" && n !== null && "kf" in n;

/** Valeur d'un Num au temps t (relatif au début du clip). */
export function evalNum(n: Num | undefined, t: Ms, def: number): number {
  if (n === undefined) return def;
  if (typeof n === "number") return n;
  const k = n.kf;
  if (t <= k[0][0]) return k[0][1];
  for (let i = 0; i < k.length - 1; i++) {
    const [t0, v0] = k[i], [t1, v1, e] = k[i + 1];
    if (t <= t1) return v0 + (v1 - v0) * ease(e, t1 === t0 ? 1 : (t - t0) / (t1 - t0));
  }
  return k[k.length - 1][1];
}
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
export function evalCol(c: Col | undefined, t: Ms, def: string): string {
  if (c === undefined) return def;
  if (typeof c === "string") return c;
  const k = c.kf;
  if (t <= k[0][0]) return k[0][1];
  for (let i = 0; i < k.length - 1; i++) {
    const [t0, c0] = k[i], [t1, c1] = k[i + 1];
    if (t <= t1) {
      const a = hex(c0), b = hex(c1), f = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      return "#" + a.map((v, j) => Math.round(v + (b[j] - v) * f).toString(16).padStart(2, "0")).join("");
    }
  }
  return k[k.length - 1][1];
}
/** Bruit seedé (jamais Math.random) : même entrée → même sortie. */
export function seeded(seed: string | number, frame: number): number {
  let h = 2166136261 ^ frame;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/* ────────────────────────── Vitesse : source ↔ timeline ────────────────────────── */
const speedAt = (sp: Num | undefined, t: Ms) => Math.min(16, Math.max(0.05, evalNum(sp, t, DEFAULTS.speed)));
/** ∫0^d speed(τ)dτ — exact si constante, trapèzes par segment si rampe. */
export function speedIntegral(sp: Num | undefined, d: Ms): number {
  if (d <= 0) return 0;
  if (!isKf(sp)) return speedAt(sp, 0) * d;
  const cuts = [0, ...sp.kf.map((k) => k[0]).filter((x) => x > 0 && x < d), d];
  let sum = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1], N = 16;
    for (let s = 0; s < N; s++) {
      const x0 = a + ((b - a) * s) / N, x1 = a + ((b - a) * (s + 1)) / N;
      sum += ((speedAt(sp, x0) + speedAt(sp, x1)) / 2) * (x1 - x0);
    }
  }
  return sum;
}
/** Durée timeline nécessaire pour parcourir `srcLen` ms de source. */
export function timelineLenFor(sp: Num | undefined, srcLen: Ms): Ms {
  if (srcLen <= 0) return 0;
  if (!isKf(sp)) return Math.round(srcLen / speedAt(sp, 0));
  let lo = 0, hi = srcLen / 0.05;
  for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (speedIntegral(sp, mid) < srcLen) lo = mid; else hi = mid; }
  return Math.round(hi);
}
type Timed = { at: Ms; src: [Ms, Ms]; speed?: Num };
/** UNIQUE paire de conversions source ↔ timeline (règle 5.5.1). */
export const srcToTimeline = (c: Timed, srcMs: Ms): Ms => Math.round(c.at + timelineLenFor(c.speed, srcMs - c.src[0]));
export const timelineToSrc = (c: Timed, tMs: Ms): Ms => Math.round(c.src[0] + speedIntegral(c.speed, tMs - c.at));

/* ────────────────────────── Layout ────────────────────────── */
export interface Placed {
  id: string; trackId: string; trackIdx: number; kind: TrackKind; clip: Clip;
  at: Ms; dur: Ms; ok: boolean; magnetic: boolean;
}
export interface Layout { byId: Record<string, Placed>; list: Placed[]; duration: Ms; warnings: Warning[] }

export function wordsOf(doc: Composition, assetId: string): Word[] {
  const a = doc.assets[assetId];
  return a && (a.type === "video" || a.type === "audio") ? a.words ?? [] : [];
}

export function layoutDoc(doc: Composition): Layout {
  const byId: Record<string, Placed> = {};
  const warnings: Warning[] = [];
  const list: Placed[] = [];
  const put = (t: Track, ti: number, clip: Clip, at: Ms, dur: Ms, ok = true) => {
    const p: Placed = { id: clip.id, trackId: t.id, trackIdx: ti, kind: t.kind, clip, at, dur, ok, magnetic: !!(t.kind === "video" && t.magnetic) };
    byId[clip.id] = p; list.push(p); return p;
  };
  const trans = new Map(doc.transitions.map((x) => [x.between.join("|"), x]));

  // Passe 1 : vidéos (magnétique ou at+dur)
  doc.tracks.forEach((t, ti) => {
    if (t.kind !== "video") return;
    let cursor = 0, prev: Placed | null = null;
    for (const c of t.clips) {
      const len = timelineLenFor(c.speed, Math.max(0, c.src[1] - c.src[0]));
      if (t.magnetic) {
        const tr = prev ? trans.get(`${prev.id}|${c.id}`) : undefined;
        const ov = tr && prev ? Math.min(tr.dur, Math.floor(prev.dur / 2), Math.floor(len / 2)) : 0;
        const at = Math.max(0, cursor - ov);
        prev = put(t, ti, c, at, len); cursor = at + len;
      } else {
        prev = put(t, ti, c, c.at ?? 0, c.dur !== undefined ? Math.min(c.dur, len) || c.dur : len);
      }
    }
  });
  const anchorOf = (c: any): { start: Ms; end: Ms } | null | undefined => {
    const a = c.anchor;
    if (!a) return undefined;
    const vp = byId[a.clip];
    if (!vp || vp.kind !== "video") { warnings.push({ clipId: c.id, code: "anchor_missing", msg: `Ancre vers un clip introuvable (${a.clip}).` }); return null; }
    const vc = vp.clip as VideoClip, ws = wordsOf(doc, vc.asset);
    const wi = ws[a.words[0]], wj = ws[a.words[1]];
    if (!wi || !wj || wi.s < vc.src[0] - 1 || wj.e > vc.src[1] + 1) {
      warnings.push({ clipId: c.id, code: "anchor_out_of_range", msg: "Les mots ancrés sortent du clip source : élément non rendu." }); return null;
    }
    const tm = { at: vp.at, src: vc.src, speed: vc.speed };
    const start = srcToTimeline(tm, wi.s) + (a.offset ?? 0);
    return { start, end: a.dur !== undefined ? start + a.dur : srcToTimeline(tm, wj.e) };
  };
  // Passe 2a : tout sauf adjustment/caption/video
  doc.tracks.forEach((t, ti) => {
    if (t.kind === "video" || t.kind === "adjustment" || t.kind === "caption") return;
    for (const c of t.clips as any[]) {
      const an = anchorOf(c);
      if (an === null) put(t, ti, c, 0, 0, false);
      else if (an) put(t, ti, c, an.start, Math.max(1, an.end - an.start));
      else if (t.kind === "audio") {
        const src: [Ms, Ms] | undefined = c.src; const len = src ? src[1] - src[0] : (c.dur ?? 0);
        put(t, ti, c, c.at ?? 0, c.dur ?? len);
      } else put(t, ti, c, c.at ?? 0, c.dur ?? DEFAULTS.clipDur);
    }
  });
  // Passe 2b : captions et adjustments (référencent d'autres clips)
  doc.tracks.forEach((t, ti) => {
    if (t.kind === "caption") for (const c of t.clips) {
      const src = byId[c.from];
      if (!src) { warnings.push({ clipId: c.id, code: "caption_missing", msg: `Caption : clip source introuvable (${c.from}).` }); put(t, ti, c, 0, 0, false); }
      else put(t, ti, c, src.at, src.dur);
    }
    if (t.kind === "adjustment") for (const c of t.clips) {
      if (c.span) {
        const a = byId[c.span[0]], b = byId[c.span[1]];
        if (!a || !b) { warnings.push({ clipId: c.id, code: "span_missing", msg: "Calque d'effet : clips de span introuvables." }); put(t, ti, c, 0, 0, false); }
        else { const s = Math.min(a.at, b.at), e = Math.max(a.at + a.dur, b.at + b.dur); put(t, ti, c, s, e - s); }
      } else put(t, ti, c, c.at ?? 0, c.dur ?? DEFAULTS.clipDur);
    }
  });
  const duration = list.reduce((m, p) => (p.ok && p.kind !== "adjustment" ? Math.max(m, p.at + p.dur) : m), 0);
  return { byId, list, duration, warnings };
}

/* ────────────────────────── État d'une image ────────────────────────── */
export interface Layer { p: Placed; local: Ms; srcMs?: number; inTransition?: boolean }
export interface ActiveTransition { from: Layer; to: Layer; progress: number; effect: string; params?: Record<string, any> }
export interface FrameState { t: Ms; layers: Layer[]; transitions: ActiveTransition[] }

export function buildFrameState(doc: Composition, layout: Layout, t: Ms): FrameState {
  const layers: Layer[] = [];
  for (const p of layout.list) {
    if (!p.ok || p.kind === "audio") continue;
    if (t < p.at || t >= p.at + Math.max(1, p.dur)) continue;
    const l: Layer = { p, local: t - p.at };
    if (p.kind === "video") l.srcMs = timelineToSrc({ at: p.at, src: (p.clip as VideoClip).src, speed: (p.clip as VideoClip).speed }, t);
    layers.push(l);
  }
  layers.sort((a, b) => a.p.trackIdx - b.p.trackIdx || ((a.p.clip as any).z ?? 0) - ((b.p.clip as any).z ?? 0));
  const transitions: ActiveTransition[] = [];
  for (const x of doc.transitions) {
    const a = layers.find((l) => l.p.id === x.between[0]), b = layers.find((l) => l.p.id === x.between[1]);
    if (a && b) {
      const ov = a.p.at + a.p.dur - b.p.at;
      if (ov > 0) { a.inTransition = b.inTransition = true; transitions.push({ from: a, to: b, progress: Math.min(1, Math.max(0, (t - b.p.at) / ov)), effect: x.effect, params: x.params }); }
    }
  }
  return { t, layers, transitions };
}

export interface TransformValues {
  x: number; y: number; z: number; sx: number; sy: number; rot: number; rx: number; ry: number; rz: number;
  persp: number; opacity: number; has3d: boolean; corners?: [number, number][]; pivot: [number, number];
}
export function resolveTransform(tr: Transform | undefined, local: Ms, m?: MotionOut): TransformValues {
  const sc = tr?.scale;
  const s = sc && typeof sc === "object" && "x" in sc ? sc : undefined;
  const base = s ? 1 : evalNum(sc as Num | undefined, local, 1);
  return {
    x: evalNum(tr?.pos?.x, local, 0.5) + (m?.dx ?? 0), y: evalNum(tr?.pos?.y, local, 0.5) + (m?.dy ?? 0), z: evalNum(tr?.pos?.z, local, 0),
    sx: (s ? evalNum(s.x, local, 1) : base) * (m?.scale ?? 1), sy: (s ? evalNum(s.y, local, 1) : base) * (m?.scale ?? 1),
    rot: evalNum(tr?.rot, local, 0) + (m?.rot ?? 0),
    rx: evalNum(tr?.rot3d?.x, local, 0), ry: evalNum(tr?.rot3d?.y, local, 0), rz: evalNum(tr?.rot3d?.z, local, 0),
    persp: tr?.persp ?? 0, has3d: !!tr?.rot3d, corners: tr?.corners as [number, number][] | undefined,
    pivot: (tr?.pivot as [number, number]) ?? [0.5, 0.5],
    opacity: evalNum(tr?.opacity, local, 1) * (m?.opacity ?? 1),
  };
}

/* ────────────────────────── Validation ────────────────────────── */
/** `known(id)` : l'effet existe-t-il et est-il actif dans le registre ? (injecté, le moteur ne connaît pas le registre). */
export function validate(doc: Composition, known: (id: string) => boolean, layout = layoutDoc(doc)): Warning[] {
  const w: Warning[] = [...layout.warnings];
  const seen = new Set<string>();
  const unk = (clipId: string | undefined, id: string, what: string) => { if (!known(id)) w.push({ clipId, code: "unknown_effect", msg: `${what} « ${id} » inconnu ou désactivé : ignoré.` }); };
  if (doc.grade) unk(undefined, doc.grade.lut, "Look");
  for (const t of doc.tracks) for (const c of t.clips as any[]) {
    if (seen.has(c.id)) w.push({ clipId: c.id, code: "dup_id", msg: `Identifiant en double : ${c.id}.` }); seen.add(c.id);
    for (const f of c.fx ?? []) unk(c.id, f.id, "Effet");
    if (c.mesh) unk(c.id, c.mesh.id, "Déformation");
    if (c.motion) unk(c.id, c.motion.preset, "Animation");
    if (t.kind === "overlay") unk(c.id, c.effect, "Overlay");
    if (t.kind === "text" || t.kind === "caption") unk(c.id, c.style, "Style");
    if (t.kind === "video" && !doc.assets[c.asset]) w.push({ clipId: c.id, code: "asset_missing", msg: `Rush introuvable (${c.asset}).` });
    if (t.kind === "video" && c.src[1] <= c.src[0]) w.push({ clipId: c.id, code: "empty_src", msg: "Clip vidéo de durée nulle." });
  }
  for (const x of doc.transitions) {
    if (!layout.byId[x.between[0]] || !layout.byId[x.between[1]]) w.push({ code: "transition_missing", msg: "Transition vers un clip introuvable." });
    else unk(undefined, x.effect, "Transition");
  }
  return w;
}

/* ────────────────────────── Opérations de document (appelées dans un recipe immer) ────────────────────────── */
/** Règle 5.5.5 : supprime un clip ; les éléments qui s'y ancraient sont figés en at/dur absolus. */
export function removeClip(doc: Composition, layout: Layout, clipId: string): void {
  for (const t of doc.tracks) for (const c of t.clips as any[]) {
    if (c.anchor?.clip === clipId) { const p = layout.byId[c.id]; if (p) { c.at = p.at; c.dur = p.dur; } delete c.anchor; }
    if (t.kind === "adjustment" && c.span && c.span.includes(clipId)) { const p = layout.byId[c.id]; if (p) { c.at = p.at; c.dur = p.dur; } delete c.span; }
  }
  for (const t of doc.tracks) {
    t.clips = (t.clips as any[]).filter((c) => c.id !== clipId && !(t.kind === "caption" && c.from === clipId)) as any;
  }
  doc.transitions = doc.transitions.filter((x) => !x.between.includes(clipId));
}
/** Coupe un clip au temps timeline `t`. Retourne l'id du nouveau clip (ou null). */
export function splitClipAt(doc: Composition, layout: Layout, clipId: string, t: Ms, newId: string): string | null {
  const p = layout.byId[clipId];
  if (!p || t <= p.at + 20 || t >= p.at + p.dur - 20) return null;
  for (const tr of doc.tracks) {
    const i = (tr.clips as any[]).findIndex((c) => c.id === clipId);
    if (i < 0) continue;
    const c: any = tr.clips[i];
    if (c.anchor || c.span || c.from) return null;
    const b = JSON.parse(JSON.stringify(c));
    b.id = newId;
    if (tr.kind === "video" || (tr.kind === "audio" && c.src)) {
      const mid = timelineToSrc({ at: p.at, src: c.src, speed: c.speed }, t);
      b.src = [mid, c.src[1]]; c.src = [c.src[0], mid];
      if (isKf(c.speed)) { b.speed = c.speed; }
      if (tr.kind === "video" && !tr.magnetic) { b.at = t; c.dur = t - p.at; b.dur = p.at + p.dur - t; }
      else if (tr.kind === "audio") { b.at = t; }
    } else { c.at = p.at; c.dur = t - p.at; b.at = t; b.dur = p.at + p.dur - t; }
    tr.clips.splice(i + 1, 0, b);
    return newId;
  }
  return null;
}
/** « Original » : rushs bruts enchaînés, sans IA ni effets (comparaison A/B). */
export function originalDoc(doc: Composition): Composition {
  const clips = Object.entries(doc.assets).filter(([, a]) => a.type === "video").map(([k, a], i) => ({ id: `o${i}`, asset: k, src: [0, (a as any).dur] as [number, number] }));
  return { ...doc, grade: undefined, transitions: [], tracks: [{ id: "orig", kind: "video", magnetic: true, clips }] };
}
