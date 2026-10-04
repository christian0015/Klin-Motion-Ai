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
import { api, ApiError } from "./media";
import { removeClip, splitClipAt, layoutDoc, timelineLenFor } from "./engine";
import type { Brief, Composition, Track, VideoClip } from "./schema";

enablePatches();

export type Status = "idle" | "importing" | "proxying" | "analyzing" | "ready" | "exporting" | "error";
export type SaveState = "saved" | "dirty" | "saving" | "failed" | "conflict";
export type SyncState = { state: "local" | "uploading" | "synced" | "missing" | "downloading"; progress: number };
export interface VersionMeta { id: string; kind: "ai" | "auto" | "manual"; label?: string; createdAt: string; meta?: { tokensIn?: number; tokensOut?: number; model?: string; latencyMs?: number; fallback?: boolean } }
interface Entry { label: string; patches: Patch[]; inverse: Patch[] }
export interface Compare { on: boolean; side: "a" | "b"; a: Composition | null; b: Composition | null; labelA: string; labelB: string }

interface EditorState {
  projectId: string; name: string; rev: number; brief: Brief; doc: Composition; savedDoc: Composition | null;
  past: Entry[]; future: Entry[]; gestureOpen: boolean;
  selection: string | null; t: number; playing: boolean; zoom: number;
  status: Status; progress: number; message: string; save: SaveState;
  sync: Record<string, SyncState>; versions: VersionMeta[]; compare: Compare; disabled: string[];
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
  toggleTrack: (trackId: string, key: "locked" | "muted") => void; addTrack: (kind: Track["kind"]) => void;
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
  compare: { on: false, side: "a", a: null, b: null, labelA: "Avant", labelB: "Après" }, disabled: [],
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
          if (edge === "l") { const ns = Math.min(v.src[1] - 100, Math.max(0, v.src[0] + ds)); if (t.kind === "video" && !t.magnetic) { v.at = Math.max(0, (v.at ?? p.at) + Math.round((ns - v.src[0]) / sp)); } v.src[0] = ns; }
          else v.src[1] = Math.max(v.src[0] + 100, Math.min(max, v.src[1] + ds));
          if (t.kind === "video" && !t.magnetic) { const len = timelineLenFor(v.speed, v.src[1] - v.src[0]); v.dur = len; }
        } else {
          if (c.anchor) { c.at = p.at; c.dur = p.dur; delete c.anchor; }
          if (edge === "l") { const na = Math.max(0, (c.at ?? p.at) + delta); c.dur = Math.max(100, (c.dur ?? p.dur) - (na - (c.at ?? p.at))); c.at = na; }
          else c.dur = Math.max(100, (c.dur ?? p.dur) + delta);
        }
      }
    }, true);
  },
  toggleTrack: (trackId, key) => get().apply(key === "locked" ? "Verrouiller" : "Muet", (d) => { const t = d.tracks.find((x) => x.id === trackId); if (t) t[key] = !t[key]; }),
  addTrack: (kind) => get().apply("Ajouter une piste", (d) => { d.tracks.push({ id: nanoid(5), kind, clips: [], ...(kind === "video" ? { magnetic: false } : {}) } as Track); }),
  /** Appliquer un résultat IA / restaurer une version = UN SEUL patch. */
  replaceDoc: (doc, label) => get().apply(label, (d) => { d.canvas = doc.canvas; d.assets = doc.assets as any; d.grade = doc.grade; d.tracks = doc.tracks as any; d.transitions = doc.transitions as any; }),

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
