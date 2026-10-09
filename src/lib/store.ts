//src/lib/store.ts
/**
 * store.ts — état de l'éditeur : projet, sélection, playhead, undo/redo (patches immer), versions, statuts, sauvegarde.
 * Contient : useEditor (zustand), actions d'édition (toutes via un recipe immer), sauvegarde auto avec `rev`.
 * Ne contient PAS : rendu, appels de montage IA (Editor.tsx orchestre), maths du temps (engine.ts).
 * Règle : l'UI est une vue du JSON. Toute modification passe par `apply` ; aucun composant ne duplique le document.
 */
import { create } from "zustand";
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from "immer";
import { nanoid } from "nanoid";
import { api, ApiError, fingerprint, probe, probeAudio, probeImage, remember, uploadBlob } from "./media";
import { parseSvg } from "./svg";
import { removeClip, splitClipAt, layoutDoc, timelineLenFor, wordsOf } from "./engine";
import { normalizeTimes } from "./normalize";
import type { Asset, Brief, Composition, EffectKind, Suggestion, Track, VideoClip, Word } from "./schema";
import { activeEffects, registry } from "@/effects";

enablePatches();

export type Status = "idle" | "importing" | "proxying" | "analyzing" | "ready" | "exporting" | "error";
export type SaveState = "saved" | "dirty" | "saving" | "failed" | "conflict";
export type SyncState = { state: "local" | "uploading" | "synced" | "missing" | "downloading"; progress: number; error?: string };
export interface VersionMeta { id: string; kind: "ai" | "auto" | "manual"; label?: string; createdAt: string; meta?: { tokensIn?: number; tokensOut?: number; model?: string; latencyMs?: number; fallback?: boolean } }
export interface GeneratedResult { assetId: string; key: string; mime: string; bytes: number; kind: "image" | "video"; name: string; prompt: string }
interface Entry { label: string; patches: Patch[]; inverse: Patch[] }
export interface Compare { on: boolean; side: "a" | "b"; a: Composition | null; b: Composition | null; labelA: string; labelB: string }

interface EditorState {
  projectId: string; name: string; rev: number; brief: Brief; doc: Composition; savedDoc: Composition | null;
  past: Entry[]; future: Entry[]; gestureOpen: boolean;
  selection: string | null; t: number; playing: boolean; zoom: number;
  status: Status; progress: number; message: string; save: SaveState;
  sync: Record<string, SyncState>; versions: VersionMeta[]; compare: Compare; disabled: string[]; problems: Record<string, string>;
  setProblem: (assetId: string, msg?: string) => void;
  setDisabled: (d: string[]) => void;
  load: (p: { id: string; name: string; rev: number; brief: Brief; doc: Composition }) => void;
  apply: (label: string, recipe: (d: Draft<Composition>) => void, gesture?: boolean) => void;
  silent: (recipe: (d: Draft<Composition>) => void) => void;
  endGesture: () => void; undo: () => void; redo: () => void;
  select: (id: string | null) => void; setT: (t: number) => void; setPlaying: (p: boolean) => void; setZoom: (z: number) => void;
  setStatus: (s: Status, progress?: number, message?: string) => void;
  setSync: (assetId: string, s: Partial<SyncState>) => void;
  setBrief: (b: Partial<Brief>) => void; rename: (n: string) => void;
  splitAtPlayhead: () => void; deleteSelected: () => void;
  moveClip: (id: string, deltaMs: number) => void; reorderMagnetic: (id: string, index: number) => void; trimClip: (id: string, edge: "l" | "r", deltaMs: number) => void;
  toggleTrack: (trackId: string, key: "locked" | "muted") => void; addTrack: (kind: Track["kind"]) => string; removeTrack: (trackId: string) => void; removeAsset: (assetId: string) => void;
  addDefaultClip: (trackId: string, pick?: { assetId?: string; at?: number }) => { ok: boolean; msg?: string; id?: string };
  placeAsset: (assetId: string, at?: number) => { ok: boolean; msg?: string; id?: string };
  /** Ordre des pistes = ordre d'empilement (index 0 = dessous). */
  moveTrack: (trackId: string, dir: "up" | "down") => void; reorderTrack: (trackId: string, index: number) => void;
  /** Déplace un clip vers une AUTRE piste du même type (gère les pistes magnétiques). */
  moveClipToTrack: (clipId: string, trackId: string, atMs?: number) => boolean;
  /** Dépose un média (glissé depuis la liste) sur une piste, à un instant donné. */
  dropAsset: (assetId: string, trackId: string, atMs: number) => { ok: boolean; msg?: string };
  dragAsset: string | null; setDragAsset: (id: string | null) => void;
  replaceClipAsset: (clipId: string, assetId: string) => { ok: boolean; msg?: string };
  setTransition: (fromId: string, effectId: string | null, dur?: number) => { ok: boolean; msg?: string };
  /** Applique n'importe quel effet du catalogue (image, look, transition, overlay, déformation, animation, style, son…) à la sélection. */
  applyEffect: (effectId: string) => { ok: boolean; msg?: string };
  importImage: (file: File) => Promise<{ ok: boolean; msg?: string }>;
  importAudio: (file: File, trackId?: string) => Promise<{ ok: boolean; msg?: string }>;
  importSvg: (file: File) => Promise<{ ok: boolean; msg?: string }>;
  suggestions: Suggestion[]; setSuggestions: (s: Suggestion[]) => void;
  importGenerated: (res: GeneratedResult, at?: number) => Promise<{ ok: boolean; msg?: string }>;
  syncAsset: (assetId: string, file: Blob, fp: string) => Promise<string | undefined>;
  replaceDoc: (doc: Composition, label: string) => void;
  loadVersions: () => Promise<void>; saveNow: (force?: boolean) => Promise<void>;
  setCompare: (c: Partial<Compare>) => void;
}

const EMPTY: Composition = { v: 2, canvas: { w: 1080, h: 1920, fps: 30 }, assets: {}, tracks: [], transitions: [] };
const MAX_UNDO = 200;

export const useEditor = create<EditorState>()((set, get) => ({
  projectId: "", name: "", rev: 0, brief: { platform: "tiktok" }, doc: EMPTY, savedDoc: null,
  past: [], future: [], gestureOpen: false, selection: null, t: 0, playing: false, zoom: 0.08,
  status: "idle", progress: 0, message: "", save: "saved", sync: {}, versions: [],
  compare: { on: false, side: "a", a: null, b: null, labelA: "Avant", labelB: "Après" }, disabled: [], problems: {}, dragAsset: null, setDragAsset: (dragAsset) => set({ dragAsset }), suggestions: [], setSuggestions: (suggestions) => set({ suggestions }),
  setProblem: (assetId, msg) => set((st) => { const p = { ...st.problems }; if (msg) p[assetId] = msg; else delete p[assetId]; return { problems: p }; }),
  setDisabled: (disabled) => set({ disabled }),

  load: (p) => set({ projectId: p.id, name: p.name, rev: p.rev, brief: p.brief, doc: p.doc, savedDoc: p.doc, past: [], future: [], selection: null, t: 0, playing: false, save: "saved", status: "ready", message: "" }),

  apply: (label, recipe, gesture = false) => {
    const s = get();
    const [doc, patches, inverse] = produceWithPatches(s.doc, (d) => { recipe(d); normalizeTimes(d); });
    if (!patches.length) return;
    let past = s.past;
    if (gesture && s.gestureOpen && past.length) {
      const top = past[past.length - 1];
      past = [...past.slice(0, -1), { ...top, patches: [...top.patches, ...patches], inverse: [...inverse, ...top.inverse] }];
    } else past = [...past, { label, patches, inverse }].slice(-MAX_UNDO);
    set({ doc, past, future: [], gestureOpen: gesture, save: "dirty" });
  },
  /** Modification qui ne passe pas dans l'historique (métadonnées techniques : remote, proxy, mots corrigés par l'app). */
  silent: (recipe) => { const [doc, patches] = produceWithPatches(get().doc, (d) => { recipe(d); normalizeTimes(d); }); if (patches.length) set({ doc, save: "dirty" }); },
  endGesture: () => set({ gestureOpen: false }),
  undo: () => {
    const { past, doc, future } = get(); const e = past[past.length - 1]; if (!e) return;
    set({ doc: applyPatches(doc, e.inverse), past: past.slice(0, -1), future: [...future, e], gestureOpen: false, save: "dirty" });
  },
  redo: () => {
    const { future, doc, past } = get(); const e = future[future.length - 1]; if (!e) return;
    set({ doc: applyPatches(doc, e.patches), future: future.slice(0, -1), past: [...past, e], gestureOpen: false, save: "dirty" });
  },

  select: (id) => set({ selection: id }),
  setT: (t) => set({ t: Math.max(0, Math.round(t)) }),
  setPlaying: (playing) => set({ playing }),
  setZoom: (zoom) => set({ zoom: Math.min(0.5, Math.max(0.01, zoom)) }),
  setStatus: (status, progress = 0, message = "") => set({ status, progress, message }),
  setSync: (assetId, s) => set((st) => ({ sync: { ...st.sync, [assetId]: { ...({ state: "local", progress: 0 } as SyncState), ...st.sync[assetId], ...s } } })),
  setBrief: (b) => { set((st) => ({ brief: { ...st.brief, ...b }, save: "dirty" })); },
  rename: (name) => set({ name, save: "dirty" }),

  splitAtPlayhead: () => {
    const { doc, t, selection, apply } = get();
    const L = layoutDoc(doc);
    const target = selection && L.byId[selection] ? L.byId[selection] : [...L.list].reverse().find((p) => p.kind === "video" && t > p.at && t < p.at + p.dur);
    if (!target) return;
    apply("Couper", (d) => { const id = splitClipAt(d as Composition, L, target.id, t, nanoid(6)); if (id) queueMicrotask(() => get().select(id)); });
  },
  deleteSelected: () => {
    const { doc, selection, apply } = get(); if (!selection) return;
    const L = layoutDoc(doc); if (!L.byId[selection]) return;
    apply("Supprimer", (d) => removeClip(d as Composition, L, selection)); set({ selection: null });
  },
  moveClip: (id, delta) => {
    const L = layoutDoc(get().doc), p = L.byId[id]; if (!p || p.magnetic) return;
    get().apply("Déplacer", (d) => {
      for (const t of d.tracks) { const c: any = (t.clips as any[]).find((x) => x.id === id); if (!c) continue;
        if (c.anchor) { c.dur = p.dur; delete c.anchor; }
        c.at = Math.max(0, Math.round(p.at + delta)); }
    }, true);
  },
  reorderMagnetic: (id, index) => {
    get().apply("Réordonner", (d) => {
      for (const t of d.tracks) { if (t.kind !== "video") continue; const i = t.clips.findIndex((c) => c.id === id); if (i < 0) continue;
        const [c] = t.clips.splice(i, 1); t.clips.splice(Math.min(Math.max(0, index), t.clips.length), 0, c); }
    }, true);
  },
  trimClip: (id, edge, delta) => {
    const L = layoutDoc(get().doc), p = L.byId[id]; if (!p) return;
    get().apply("Rogner", (d) => {
      for (const t of d.tracks) { const c: any = (t.clips as any[]).find((x) => x.id === id); if (!c) continue;
        if (t.kind === "video" || (t.kind === "audio" && c.src)) {
          const v = c as VideoClip, max = (d.assets[v.asset] as any)?.dur ?? 3_600_000;
          const sp = typeof v.speed === "number" ? v.speed : 1, ds = Math.round(delta * sp);
          if (edge === "l") { const ns = Math.min(v.src[1] - 100, Math.max(0, v.src[0] + ds)); if (!(t.kind === "video" && t.magnetic)) { v.at = Math.max(0, (v.at ?? p.at) + Math.round((ns - v.src[0]) / sp)); } v.src[0] = ns; }
          else v.src[1] = Math.max(v.src[0] + 100, Math.min(max, v.src[1] + ds));
          if (!(t.kind === "video" && t.magnetic)) { v.dur = timelineLenFor(v.speed, v.src[1] - v.src[0]); }
        } else {
          if (c.anchor) { c.at = p.at; c.dur = p.dur; delete c.anchor; }
          if (edge === "l") { const na = Math.max(0, (c.at ?? p.at) + delta); c.dur = Math.max(100, (c.dur ?? p.dur) - (na - (c.at ?? p.at))); c.at = na; }
          else c.dur = Math.max(100, (c.dur ?? p.dur) + delta);
        }
      }
    }, true);
  },
  toggleTrack: (trackId, key) => get().apply(key === "locked" ? "Verrouiller" : "Muet", (d) => { const t = d.tracks.find((x) => x.id === trackId); if (t) t[key] = !t[key]; }),
  addTrack: (kind) => {
    const id = nanoid(5);
    get().apply("Ajouter une piste", (d) => { d.tracks.push({ id, kind, clips: [], ...(kind === "video" ? { magnetic: false } : {}) } as Track); });
    return id;
  },
  removeTrack: (trackId) => get().apply("Supprimer la piste", (d) => { const i = d.tracks.findIndex((t) => t.id === trackId); if (i >= 0 && d.tracks[i].clips.length === 0) d.tracks.splice(i, 1); }),
  /** Supprime un rush : ses clips (ancres figées, sous-titres liés retirés), l'asset, et son état de synchronisation. */
  removeAsset: (assetId) => {
    const L = layoutDoc(get().doc);
    const ids = L.list.filter((p) => ((p.kind === "video" || p.kind === "audio") && (p.clip as { asset?: string }).asset === assetId) || (p.kind === "shape" && (p.clip as { shape?: { asset?: string } }).shape?.asset === assetId)).map((p) => p.id);
    get().apply("Supprimer le rush", (d) => { for (const id of ids) removeClip(d as Composition, L, id); delete d.assets[assetId]; });
    set((st) => { const sync = { ...st.sync }, problems = { ...st.problems }; delete sync[assetId]; delete problems[assetId]; return { sync, problems, selection: st.selection && ids.includes(st.selection) ? null : st.selection }; });
  },
  /** Ajoute à la piste un élément PAR DÉFAUT au playhead (premier effet du registre pour ce type). Retourne un message si impossible. */
  addDefaultClip: (trackId, pick) => {
    const { doc, t, selection } = get(), tr = doc.tracks.find((x) => x.id === trackId);
    if (!tr) return { ok: false, msg: "Piste introuvable." };
    const at = pick?.at ?? t, L = layoutDoc(doc), id = nanoid(6), first = (k: EffectKind) => activeEffects(get().disabled, k)[0]?.id;
    const none = (what: string) => ({ ok: false, msg: `Aucun effet « ${what} » disponible dans le catalogue.` });
    let clip: Record<string, unknown>, msg: string | undefined, placeholder: { assetId: string; words: Word[] } | undefined;
    switch (tr.kind) {
      case "video": {
        const media = Object.entries(doc.assets).filter(([, a]) => a.type === "video" || a.type === "image");
        const aid = pick?.assetId ?? (media.find(([, a]) => a.type === "video") ?? media[0])?.[0];
        const a = aid ? doc.assets[aid] : undefined;
        if (!aid || (a?.type !== "video" && a?.type !== "image")) return { ok: false, msg: "Ajoutez d'abord un rush ou une image (panneau « Médias »)." };
        if (a.type === "image") clip = { id, asset: aid, src: [0, 3000], fit: "contain", ...(tr.magnetic ? {} : { at, dur: 3000 }) };
        else clip = tr.magnetic ? { id, asset: aid, src: [0, a.dur] } : { id, asset: aid, src: [0, Math.min(a.dur, 5000)], at };
        break;
      }
      case "text": { const style = first("text_style"); if (!style) return none("style de texte"); clip = { id, text: "Votre texte", style, at, dur: 2000, ...(registry.has("pop_in") ? { motion: { preset: "pop_in" } } : {}) }; break; }
      case "caption": {
        const sel = selection ? L.byId[selection] : undefined;
        const src = (sel?.kind === "video" ? sel : undefined) ?? [...L.list].reverse().find((p) => p.kind === "video" && p.ok && t >= p.at && t < p.at + p.dur) ?? L.list.find((p) => p.kind === "video" && p.ok);
        if (!src) return { ok: false, msg: "Les sous-titres suivent un clip vidéo : ajoutez d'abord un rush." };
        const style = first("caption_style"); if (!style) return none("style de sous-titres");
        clip = { id, from: src.id, style };
        const vc = src.clip as VideoClip;
        if (!wordsOf(doc, vc.asset).length) {
          // Pas de transcription : 3 mots d'exemple, visibles et éditables tout de suite (l'analyse IA les remplace par la vraie parole)
          const span = Math.max(30, Math.min(1800, vc.src[1] - vc.src[0])), cut = [0, 0.3, 0.7, 1].map((k) => vc.src[0] + Math.round(span * k));
          placeholder = { assetId: vc.asset, words: ["Vos", "sous-titres", "ici"].map((t, i) => ({ t, s: cut[i], e: cut[i + 1] })) };
          msg = "Sous-titres d'exemple ajoutés : modifiez les mots dans l'Inspector, ou lancez « Monter avec l'IA » pour la vraie transcription.";
        }
        break;
      }
      case "overlay": { const effect = first("overlay"); if (!effect) return none("overlay"); clip = { id, effect, at, dur: 2000, blend: "add" }; break; }
      case "adjustment": { const fx = first("fx"); if (!fx) return none("effet d'image"); clip = { id, at, dur: 3000, fx: [{ id: fx }] }; break; }
      case "audio": {
        const snd = pick?.assetId ? ([pick.assetId, doc.assets[pick.assetId]] as const) : Object.entries(doc.assets).find(([, a]) => a.type === "audio");
        const a = snd?.[1];
        if (!snd || a?.type !== "audio") return { ok: false, msg: "Pour l'audio, utilisez le bouton ♪ de la piste : il importe un fichier son." };
        clip = { id, asset: snd[0], src: [0, a.dur], at, dur: a.dur, gain: 1 };
        break;
      }
      case "shape": {
        const svgId = pick?.assetId && doc.assets[pick.assetId]?.type === "svg" ? pick.assetId : undefined, preset = first("shape_preset");
        if (!svgId && !preset) return none("forme");
        clip = { id, shape: svgId ? { asset: svgId } : { preset }, at, dur: 2500 };
        break;
      }
      default: return { ok: false, msg: "Ce type de piste n'est pas disponible." };
    }
    const insertAt = tr.kind === "video" && tr.magnetic && pick?.at !== undefined ? L.list.filter((q) => q.trackId === tr.id && q.at + q.dur / 2 < at).length : -1;   // dépôt sur la piste principale : à la bonne place
    get().apply("Ajouter un élément", (d) => {
      const arr = d.tracks.find((x) => x.id === trackId)!.clips as unknown[]; if (insertAt >= 0) arr.splice(insertAt, 0, clip); else arr.push(clip);
      if (placeholder) { const a = d.assets[placeholder.assetId]; if (a?.type === "video") a.words = placeholder.words; }
    });
    set({ selection: id });
    return { ok: true, id, msg };
  },
  /** Appliquer un résultat IA / restaurer une version = UN SEUL patch. */
  replaceDoc: (doc, label) => get().apply(label, (d) => { d.canvas = doc.canvas; d.assets = doc.assets as any; d.grade = doc.grade; d.tracks = doc.tracks as any; d.transitions = doc.transitions as any; }),

  /** Place un média sur une piste adaptée (vidéo → piste magnétique ; image → piste vidéo libre ; audio → piste audio), en la créant si besoin. */
  placeAsset: (assetId, at) => {
    const st = get(), a = st.doc.assets[assetId];
    if (!a || (a.type !== "video" && a.type !== "image" && a.type !== "audio" && a.type !== "svg")) return { ok: false, msg: "Média introuvable." };
    const tracks = st.doc.tracks, kind = a.type === "audio" ? "audio" : a.type === "svg" ? "shape" : "video", magnetic = a.type === "video";
    const existing = magnetic ? tracks.find((t) => t.kind === "video" && t.magnetic) : kind === "video" ? [...tracks].reverse().find((t) => t.kind === "video" && !t.magnetic) : tracks.find((t) => t.kind === kind);
    let id = existing?.id;
    if (!id) {
      const newId = magnetic && !tracks.some((t) => t.id === "v1") ? "v1" : nanoid(5); id = newId;
      st.apply("Ajouter une piste", (d) => { const t = { id: newId, kind, clips: [], ...(kind === "video" ? { magnetic } : {}) } as Track; if (magnetic) d.tracks.unshift(t); else d.tracks.push(t); });
    }
    return get().addDefaultClip(id, { assetId, at });
  },
  importImage: async (file) => {
    try {
      const p = await probeImage(file); await remember(p.fp, file);
      const aid = nanoid(6);
      get().apply("Ajouter une image", (d) => { d.assets[aid] = { type: "image", name: file.name, w: p.w, h: p.h, fp: p.fp, bytes: file.size }; });
      get().setSync(aid, { state: "local", progress: 0 });
      const r = get().placeAsset(aid); void get().syncAsset(aid, file, p.fp); return r;
    } catch (e) { return { ok: false, msg: (e as Error).message }; }
  },
  /** Un média généré par l'IA est déjà dans R2 : on le télécharge (URL signée), on lit ses dimensions, on l'ajoute au projet et on le place. */
  importGenerated: async (res, at) => {
    try {
      const st = get(), { url } = await api("upload/sign", "POST", { projectId: st.projectId, assetId: res.assetId, kind: "original", action: "get", size: Math.max(1, res.bytes), type: res.mime });
      const blob = await (await fetch(url)).blob(), fp = `gen-${res.assetId}`;
      const file = new File([blob], `${res.name.replace(/[^\w.-]+/g, "_")}.${res.kind === "image" ? "jpg" : "mp4"}`, { type: res.mime });
      const desc = res.prompt.slice(0, 500);
      if (res.kind === "image") {
        const p = await probeImage(file);
        get().apply("Ajouter une image générée", (d) => { d.assets[res.assetId] = { type: "image", name: res.name, desc, w: p.w, h: p.h, fp, bytes: res.bytes, remote: res.key }; });
      } else {
        const p = await probe(file);
        get().apply("Ajouter une vidéo générée", (d) => { d.assets[res.assetId] = { type: "video", name: res.name, desc, w: p.w, h: p.h, dur: p.dur, fps: p.fps, rot: p.rot, hasAudio: p.hasAudio, bytes: res.bytes, fp, remote: res.key }; });
      }
      await remember(fp, file); get().setSync(res.assetId, { state: "synced", progress: 1 });
      if (at !== undefined) set({ t: Math.max(0, Math.round(at)) });
      return get().placeAsset(res.assetId);
    } catch (e) { return { ok: false, msg: (e as Error).message }; }
  },
  /** Un fichier SVG devient une forme dessinable (tracé progressif) : il est lu et validé tout de suite, jamais inséré dans la page. */
  importSvg: async (file) => {
    try {
      const p = parseSvg(await file.text()), fp = await fingerprint(file), aid = nanoid(6);
      await remember(fp, file);
      get().apply("Ajouter un SVG", (d) => { d.assets[aid] = { type: "svg", name: file.name, w: Math.max(1, Math.round(p.w)), h: Math.max(1, Math.round(p.h)), fp, bytes: file.size }; });
      get().setSync(aid, { state: "local", progress: 0 });
      const r = get().placeAsset(aid); void get().syncAsset(aid, file, fp); return r;
    } catch (e) { return { ok: false, msg: (e as Error).message }; }
  },
  importAudio: async (file, trackId) => {
    try {
      const p = await probeAudio(file); await remember(p.fp, file);
      const aid = nanoid(6);
      get().apply("Ajouter un audio", (d) => { d.assets[aid] = { type: "audio", name: file.name, dur: p.dur, fp: p.fp, bytes: file.size }; });
      get().setSync(aid, { state: "local", progress: 0 });
      const r = trackId ? get().addDefaultClip(trackId, { assetId: aid }) : get().placeAsset(aid);
      void get().syncAsset(aid, file, p.fp); return r;
    } catch (e) { return { ok: false, msg: (e as Error).message }; }
  },
  /** Envoi cloud d'un média (vidéo, image, audio), non bloquant ; retourne un message d'erreur si l'envoi échoue (le fichier reste local). */
  syncAsset: async (assetId, file, fp) => {
    get().setSync(assetId, { state: "uploading", progress: 0, error: undefined });
    const kind = get().doc.assets[assetId]?.type;
    const mime = file.type && /^(video|audio|image)\/[\w.+-]+$/.test(file.type) ? file.type : kind === "audio" ? "audio/mpeg" : kind === "image" ? "image/png" : kind === "svg" ? "image/svg+xml" : "video/mp4";
    try {
      const key = await uploadBlob(file, { projectId: get().projectId, assetId, kind: "original", type: mime, fp }, (p) => get().setSync(assetId, { progress: p }));
      get().silent((d) => { const a = d.assets[assetId]; if (a && (a.type === "video" || a.type === "audio" || a.type === "image" || a.type === "svg")) a.remote = key; });
      get().setSync(assetId, { state: "synced", progress: 1, error: undefined });
      return undefined;
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 503 ? "Stockage cloud non configuré : le fichier reste local sur cet appareil." : e instanceof ApiError && e.status === 402 ? "Quota de stockage atteint : le fichier reste local." : "Envoi cloud interrompu : le fichier reste disponible en local.";
      get().setSync(assetId, { state: "local", progress: 0, error: msg });
      return msg;
    }
  },

  moveTrack: (trackId, dir) => get().apply("Réordonner les pistes", (d) => {
    const i = d.tracks.findIndex((t) => t.id === trackId), j = dir === "up" ? i + 1 : i - 1;
    if (i < 0 || j < 0 || j >= d.tracks.length) return;
    const [t] = d.tracks.splice(i, 1); d.tracks.splice(j, 0, t);
  }),
  reorderTrack: (trackId, index) => get().apply("Réordonner les pistes", (d) => {
    const i = d.tracks.findIndex((t) => t.id === trackId), j = Math.min(Math.max(0, index), d.tracks.length - 1);
    if (i < 0 || i === j) return;
    const [t] = d.tracks.splice(i, 1); d.tracks.splice(j, 0, t);
  }, true),
  moveClipToTrack: (clipId, trackId, atMs) => {
    const st = get(), L = layoutDoc(st.doc), p = L.byId[clipId], dst = st.doc.tracks.find((t) => t.id === trackId);
    if (!p || !dst || dst.locked || dst.id === p.trackId || dst.kind !== p.kind) return false;
    const dstMagnetic = dst.kind === "video" && !!dst.magnetic, at = Math.max(0, Math.round(atMs ?? p.at));
    const idx = dstMagnetic ? L.list.filter((q) => q.trackId === dst.id && q.at + q.dur / 2 < at + p.dur / 2).length : -1;
    st.apply("Changer de piste", (d) => {
      let moved: any;
      for (const t of d.tracks) { const i = (t.clips as any[]).findIndex((c) => c.id === clipId); if (i >= 0) { moved = (t.clips as any[]).splice(i, 1)[0]; break; } }
      if (!moved) return;
      if (p.kind === "video") { if (dstMagnetic) { delete moved.at; delete moved.dur; } else { moved.at = at; if (p.magnetic) moved.dur = p.dur; } }
      const arr = d.tracks.find((t) => t.id === trackId)!.clips as any[]; if (idx >= 0) arr.splice(idx, 0, moved); else arr.push(moved);
      if (p.magnetic || dstMagnetic) d.transitions = d.transitions.filter((x) => !x.between.includes(clipId));   // une transition n'existe qu'entre deux clips voisins d'une piste principale
    }, true);
    return true;
  },
  dropAsset: (assetId, trackId, atMs) => {
    const st = get(), a = st.doc.assets[assetId], tr = st.doc.tracks.find((t) => t.id === trackId);
    if (!a || !tr) return { ok: false, msg: "Média ou piste introuvable." };
    if (tr.locked) return { ok: false, msg: "Cette piste est verrouillée." };
    const fits = (tr.kind === "video" && (a.type === "video" || a.type === "image")) || (tr.kind === "audio" && a.type === "audio") || (tr.kind === "shape" && a.type === "svg");
    if (!fits) return { ok: false, msg: "Ce média ne va pas sur cette piste : vidéos et images vont sur une piste vidéo, les sons sur une piste audio, les dessins SVG sur une piste Formes." };
    return get().addDefaultClip(trackId, { assetId, at: Math.max(0, Math.round(atMs)) });
  },
  replaceClipAsset: (clipId, assetId) => {
    const st = get(), a: Asset | undefined = st.doc.assets[assetId], L = layoutDoc(st.doc), p = L.byId[clipId];
    if (!a || !p) return { ok: false, msg: "Média ou clip introuvable." };
    const okType = (p.kind === "video" && (a.type === "video" || a.type === "image")) || (p.kind === "audio" && a.type === "audio");
    if (!okType) return { ok: false, msg: p.kind === "audio" ? "Choisissez un fichier audio." : "Choisissez une vidéo ou une image." };
    const keep = Math.max(500, Math.round(p.dur));
    st.apply("Remplacer le média", (d) => {
      for (const t of d.tracks) {
        const c: any = (t.clips as any[]).find((x) => x.id === clipId); if (!c) continue;
        c.asset = assetId;
        if (a.type === "image") { c.src = [0, keep]; delete c.speed; delete c.volume; delete c.afx; c.fit ??= "contain"; }
        else if (a.type === "video") { const sp = typeof c.speed === "number" ? c.speed : 1; c.src = [0, Math.min(a.dur, Math.max(500, Math.round(keep * sp)))]; if (!a.hasAudio) delete c.afx; }
        else { const len = Math.min(a.dur, c.src ? c.src[1] - c.src[0] : a.dur); c.src = [0, len]; if (c.dur !== undefined) c.dur = Math.min(c.dur, len); }
        if (p.kind === "video" && c.dur !== undefined) c.dur = keep;   // la durée affichée du clip est conservée
      }
    });
    const dependents = L.list.some((q) => (q.clip as any).anchor?.clip === clipId || (q.clip as any).from === clipId);
    return { ok: true, msg: dependents ? "Média remplacé. Les sous-titres et textes ancrés à ce clip suivent désormais les mots du nouveau média." : undefined };
  },
  setTransition: (fromId, effectId, dur = 400) => {
    const st = get(), L = layoutDoc(st.doc), p = L.byId[fromId];
    if (!p || !p.magnetic) return { ok: false, msg: "Une transition se place entre deux clips de la piste vidéo principale : sélectionnez un clip de cette piste." };
    const clips = st.doc.tracks[p.trackIdx].clips, next = clips[clips.findIndex((c) => c.id === fromId) + 1];
    if (!next) return { ok: false, msg: "Ce clip est le dernier de la piste : une transition relie un clip au suivant." };
    st.apply("Transition", (d) => {
      d.transitions = d.transitions.filter((x) => !(x.between[0] === fromId && x.between[1] === next.id));
      if (effectId) d.transitions.push({ between: [fromId, next.id], effect: effectId, dur: Math.max(50, Math.round(dur)) });
    });
    return { ok: true };
  },
  applyEffect: (effectId) => {
    const def = registry.get(effectId); if (!def) return { ok: false, msg: "Effet introuvable." };
    const st = get(), L = layoutDoc(st.doc), p = st.selection ? L.byId[st.selection] : undefined, t = st.t;
    const ensure = (kind: Track["kind"]) => [...st.doc.tracks].reverse().find((x) => x.kind === kind)?.id ?? get().addTrack(kind);
    const push = (trackId: string, clip: Record<string, unknown>, label: string) => { get().apply(label, (d) => { (d.tracks.find((x) => x.id === trackId)!.clips as unknown[]).push(clip); }); set({ selection: clip.id as string }); return { ok: true }; };
    const onClip = (label: string, fn: (c: any) => void) => { get().apply(label, (d) => { for (const tr of d.tracks) { const c = (tr.clips as any[]).find((x) => x.id === p!.id); if (c) fn(c); } }); return { ok: true }; };
    const visual = !!p && ["video", "text", "caption"].includes(p.kind);
    const needClip = (what: string) => ({ ok: false, msg: `Sélectionnez ${what} dans la timeline, puis cliquez sur « Appliquer ».` });
    switch (def.kind) {
      case "fx":
        if (p && (visual || p.kind === "adjustment")) return onClip("Ajouter un effet", (c) => { c.fx = [...(c.fx ?? []), { id: effectId }].slice(0, 12); });
        return push(ensure("adjustment"), { id: nanoid(6), at: t, dur: 3000, fx: [{ id: effectId }] }, "Calque d'effets");   // rien de sélectionné : calque d'effets au playhead
      case "lut": get().apply("Look global", (d) => { d.grade = { lut: effectId, amount: d.grade?.amount ?? 0.7 }; }); return { ok: true };
      case "transition": return p ? get().setTransition(p.id, effectId) : needClip("un clip de la piste vidéo principale (suivi d'un autre clip)");
      case "overlay": return push(ensure("overlay"), { id: nanoid(6), effect: effectId, at: t, dur: 2000, blend: "add" }, "Overlay");
      case "mesh": return visual ? onClip("Déformation", (c) => { c.mesh = { id: effectId }; }) : needClip("un clip vidéo, texte ou sous-titres");
      case "motion_preset": return visual ? onClip("Animation", (c) => { c.motion = { preset: effectId }; }) : needClip("un clip vidéo, texte ou sous-titres");
      case "text_style":
        if (p?.kind === "text") return onClip("Style de texte", (c) => { c.style = effectId; });
        return push(ensure("text"), { id: nanoid(6), text: "Votre texte", style: effectId, at: t, dur: 2000 }, "Texte");
      case "caption_style": {
        if (p?.kind === "caption") return onClip("Style de sous-titres", (c) => { c.style = effectId; });
        const r = get().addDefaultClip(ensure("caption")); if (r.ok && r.id) get().apply("Style de sous-titres", (d) => { for (const tr of d.tracks) { const c = (tr.clips as any[]).find((x) => x.id === r.id); if (c) c.style = effectId; } });
        return r;
      }
      case "audio_fx": {
        const hasSound = !!p && (p.kind === "audio" || (p.kind === "video" && (st.doc.assets[(p.clip as VideoClip).asset] as { hasAudio?: boolean } | undefined)?.hasAudio));
        return hasSound ? onClip("Effet audio", (c) => { c.afx = [...(c.afx ?? []), { id: effectId }].slice(0, 8); }) : needClip("un clip vidéo avec du son, ou un clip audio");
      }
      case "sfx": return push(ensure("audio"), { id: nanoid(6), asset: `sfx:${effectId}`, at: t, dur: def.duration ?? 1000, gain: 1 }, "Effet sonore");
      case "shape_preset": {
        if (effectId === "svg_draw_v1") {   // ce gabarit dessine un fichier : il faut un SVG importé
          const svg = Object.entries(st.doc.assets).find(([, a]) => a.type === "svg");
          if (!svg) return { ok: false, msg: "Importez d'abord un fichier SVG (onglet Médias), puis glissez-le sur une piste Formes." };
          return get().placeAsset(svg[0]);
        }
        if (p?.kind === "shape") return onClip("Forme", (c) => { c.shape = { ...(c.shape?.asset ? { asset: c.shape.asset } : {}), preset: effectId }; });
        return push(ensure("shape"), { id: nanoid(6), shape: { preset: effectId }, at: t, dur: 2500 }, "Forme");
      }
      default: return { ok: false, msg: "Ce type d'élément n'est pas applicable." };
    }
  },

  loadVersions: async () => {
    const { projectId } = get(); if (!projectId) return;
    const r = await api<{ items: VersionMeta[] }>(`projects/${projectId}/versions`); set({ versions: r.items });
  },
  setCompare: (c) => set((st) => ({ compare: { ...st.compare, ...c } })),

  /** Sauvegarde (debounce géré par l'éditeur). `rev` = concurrence optimiste ; 409 → état « conflict ». */
  saveNow: async (force = false) => {
    const s = get(); if (!s.projectId || s.save === "saving") return;
    set({ save: "saving" }); const sent = s.doc;
    try {
      const r = await api<{ rev: number }>(`projects/${s.projectId}`, "PATCH", { rev: s.rev, doc: sent, name: s.name, brief: s.brief, force });
      set((st) => ({ rev: r.rev, savedDoc: sent, save: st.doc === sent ? "saved" : "dirty" }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) set({ save: "conflict" });
      else set({ save: "failed" });
    }
  },
}));
