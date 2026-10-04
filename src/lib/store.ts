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
import { api, ApiError, probeAudio, probeImage, remember, uploadBlob } from "./media";
import { removeClip, splitClipAt, layoutDoc, timelineLenFor, wordsOf } from "./engine";
import type { Brief, Composition, EffectKind, Track, VideoClip, Word } from "./schema";
import { activeEffects, registry } from "@/effects";

enablePatches();

export type Status = "idle" | "importing" | "proxying" | "analyzing" | "ready" | "exporting" | "error";
export type SaveState = "saved" | "dirty" | "saving" | "failed" | "conflict";
export type SyncState = { state: "local" | "uploading" | "synced" | "missing" | "downloading"; progress: number; error?: string };
export interface VersionMeta { id: string; kind: "ai" | "auto" | "manual"; label?: string; createdAt: string; meta?: { tokensIn?: number; tokensOut?: number; model?: string; latencyMs?: number; fallback?: boolean } }
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
  addDefaultClip: (trackId: string, pick?: { assetId?: string }) => { ok: boolean; msg?: string; id?: string };
  placeAsset: (assetId: string) => { ok: boolean; msg?: string; id?: string };
  importImage: (file: File) => Promise<{ ok: boolean; msg?: string }>;
  importAudio: (file: File, trackId?: string) => Promise<{ ok: boolean; msg?: string }>;
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
  compare: { on: false, side: "a", a: null, b: null, labelA: "Avant", labelB: "Après" }, disabled: [], problems: {},
  setProblem: (assetId, msg) => set((st) => { const p = { ...st.problems }; if (msg) p[assetId] = msg; else delete p[assetId]; return { problems: p }; }),
  setDisabled: (disabled) => set({ disabled }),

  load: (p) => set({ projectId: p.id, name: p.name, rev: p.rev, brief: p.brief, doc: p.doc, savedDoc: p.doc, past: [], future: [], selection: null, t: 0, playing: false, save: "saved", status: "ready", message: "" }),

  apply: (label, recipe, gesture = false) => {
    const s = get();
    const [doc, patches, inverse] = produceWithPatches(s.doc, recipe);
    if (!patches.length) return;
    let past = s.past;
    if (gesture && s.gestureOpen && past.length) {
      const top = past[past.length - 1];
      past = [...past.slice(0, -1), { ...top, patches: [...top.patches, ...patches], inverse: [...inverse, ...top.inverse] }];
    } else past = [...past, { label, patches, inverse }].slice(-MAX_UNDO);
    set({ doc, past, future: [], gestureOpen: gesture, save: "dirty" });
  },
  /** Modification qui ne passe pas dans l'historique (métadonnées techniques : remote, proxy, mots corrigés par l'app). */
  silent: (recipe) => { const [doc, patches] = produceWithPatches(get().doc, recipe); if (patches.length) set({ doc, save: "dirty" }); },
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
    const ids = L.list.filter((p) => (p.kind === "video" || p.kind === "audio") && (p.clip as { asset?: string }).asset === assetId).map((p) => p.id);
    get().apply("Supprimer le rush", (d) => { for (const id of ids) removeClip(d as Composition, L, id); delete d.assets[assetId]; });
    set((st) => { const sync = { ...st.sync }, problems = { ...st.problems }; delete sync[assetId]; delete problems[assetId]; return { sync, problems, selection: st.selection && ids.includes(st.selection) ? null : st.selection }; });
  },
  /** Ajoute à la piste un élément PAR DÉFAUT au playhead (premier effet du registre pour ce type). Retourne un message si impossible. */
  addDefaultClip: (trackId, pick) => {
    const { doc, t, selection } = get(), tr = doc.tracks.find((x) => x.id === trackId);
    if (!tr) return { ok: false, msg: "Piste introuvable." };
    const L = layoutDoc(doc), id = nanoid(6), first = (k: EffectKind) => activeEffects(get().disabled, k)[0]?.id;
    const none = (what: string) => ({ ok: false, msg: `Aucun effet « ${what} » disponible dans le catalogue.` });
    let clip: Record<string, unknown>, msg: string | undefined, placeholder: { assetId: string; words: Word[] } | undefined;
    switch (tr.kind) {
      case "video": {
        const media = Object.entries(doc.assets).filter(([, a]) => a.type === "video" || a.type === "image");
        const aid = pick?.assetId ?? (media.find(([, a]) => a.type === "video") ?? media[0])?.[0];
        const a = aid ? doc.assets[aid] : undefined;
        if (!aid || (a?.type !== "video" && a?.type !== "image")) return { ok: false, msg: "Ajoutez d'abord un rush ou une image (panneau « Médias »)." };
        if (a.type === "image") clip = { id, asset: aid, src: [0, 3000], fit: "contain", ...(tr.magnetic ? {} : { at: t, dur: 3000 }) };
        else clip = tr.magnetic ? { id, asset: aid, src: [0, a.dur] } : { id, asset: aid, src: [0, Math.min(a.dur, 5000)], at: t };
        break;
      }
      case "text": { const style = first("text_style"); if (!style) return none("style de texte"); clip = { id, text: "Votre texte", style, at: t, dur: 2000, ...(registry.has("pop_in") ? { motion: { preset: "pop_in" } } : {}) }; break; }
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
      case "overlay": { const effect = first("overlay"); if (!effect) return none("overlay"); clip = { id, effect, at: t, dur: 2000, blend: "add" }; break; }
      case "adjustment": { const fx = first("fx"); if (!fx) return none("effet d'image"); clip = { id, at: t, dur: 3000, fx: [{ id: fx }] }; break; }
      case "audio": {
        const snd = pick?.assetId ? ([pick.assetId, doc.assets[pick.assetId]] as const) : Object.entries(doc.assets).find(([, a]) => a.type === "audio");
        const a = snd?.[1];
        if (!snd || a?.type !== "audio") return { ok: false, msg: "Pour l'audio, utilisez le bouton ♪ de la piste : il importe un fichier son." };
        clip = { id, asset: snd[0], src: [0, a.dur], at: t, dur: a.dur, gain: 1 };
        break;
      }
      default: return { ok: false, msg: "Ce type de piste n'est pas encore disponible (phase 2)." };
    }
    get().apply("Ajouter un élément", (d) => {
      (d.tracks.find((x) => x.id === trackId)!.clips as unknown[]).push(clip);
      if (placeholder) { const a = d.assets[placeholder.assetId]; if (a?.type === "video") a.words = placeholder.words; }
    });
    set({ selection: id });
    return { ok: true, id, msg };
  },
  /** Appliquer un résultat IA / restaurer une version = UN SEUL patch. */
  replaceDoc: (doc, label) => get().apply(label, (d) => { d.canvas = doc.canvas; d.assets = doc.assets as any; d.grade = doc.grade; d.tracks = doc.tracks as any; d.transitions = doc.transitions as any; }),

  /** Place un média sur une piste adaptée (vidéo → piste magnétique ; image → piste vidéo libre ; audio → piste audio), en la créant si besoin. */
  placeAsset: (assetId) => {
    const st = get(), a = st.doc.assets[assetId];
    if (!a || (a.type !== "video" && a.type !== "image" && a.type !== "audio")) return { ok: false, msg: "Média introuvable." };
    const tracks = st.doc.tracks, kind = a.type === "audio" ? "audio" : "video", magnetic = a.type === "video";
    const existing = magnetic ? tracks.find((t) => t.kind === "video" && t.magnetic) : kind === "video" ? [...tracks].reverse().find((t) => t.kind === "video" && !t.magnetic) : tracks.find((t) => t.kind === "audio");
    let id = existing?.id;
    if (!id) {
      const newId = magnetic && !tracks.some((t) => t.id === "v1") ? "v1" : nanoid(5); id = newId;
      st.apply("Ajouter une piste", (d) => { const t = { id: newId, kind, clips: [], ...(kind === "video" ? { magnetic } : {}) } as Track; if (magnetic) d.tracks.unshift(t); else d.tracks.push(t); });
    }
    return get().addDefaultClip(id, { assetId });
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
    const mime = file.type && /^(video|audio|image)\/[\w.+-]+$/.test(file.type) ? file.type : kind === "audio" ? "audio/mpeg" : kind === "image" ? "image/png" : "video/mp4";
    try {
      const key = await uploadBlob(file, { projectId: get().projectId, assetId, kind: "original", type: mime, fp }, (p) => get().setSync(assetId, { progress: p }));
      get().silent((d) => { const a = d.assets[assetId]; if (a && (a.type === "video" || a.type === "audio" || a.type === "image")) a.remote = key; });
      get().setSync(assetId, { state: "synced", progress: 1, error: undefined });
      return undefined;
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 503 ? "Stockage cloud non configuré : le fichier reste local sur cet appareil." : e instanceof ApiError && e.status === 402 ? "Quota de stockage atteint : le fichier reste local." : "Envoi cloud interrompu : le fichier reste disponible en local.";
      get().setSync(assetId, { state: "local", progress: 0, error: msg });
      return msg;
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
