//src/components/Timeline.tsx
/**
 * Timeline.tsx — pistes empilées, clips déplaçables/rognables, playhead, zoom, snapping, mute/lock, mots des sous-titres.
 * Contient : <Timeline/> (règle, pistes, clips, glisser/rogner par pointer events, ripple magnétique).
 * Ne contient PAS : calculs de temps (engine.ts) ni modification directe du document (tout passe par les actions du store).
 */
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { layoutDoc, wordsOf, srcToTimeline, type Placed } from "@/lib/engine";
import { useEditor } from "@/lib/store";
import type { Track, TrackKind, VideoClip } from "@/lib/schema";
import { fmt } from "./Preview";
import { audioPeaks, getFile } from "@/lib/media";

const KIND: Record<TrackKind, { label: string; bar: string }> = {
  video: { label: "Vidéo", bar: "bg-k-video" }, adjustment: { label: "Effets", bar: "bg-k-adjustment" }, overlay: { label: "Overlay", bar: "bg-k-overlay" },
  text: { label: "Texte", bar: "bg-k-text" }, caption: { label: "Sous-titres", bar: "bg-k-caption" }, shape: { label: "Formes", bar: "bg-k-shape" }, audio: { label: "Audio", bar: "bg-k-audio" },
};
const ROW = 38, HEAD = 196, SNAP_PX = 8, RULER = 24;

export default function Timeline() {
  const doc = useEditor((s) => s.doc), t = useEditor((s) => s.t), zoom = useEditor((s) => s.zoom), selection = useEditor((s) => s.selection);
  const act = useEditor.getState();
  const layout = useMemo(() => layoutDoc(doc), [doc]);
  const scroller = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null), audioTarget = useRef<string>("");
  const [notice, setNotice] = useState(""), [dropTrack, setDropTrack] = useState<{ id: string; ok: boolean } | null>(null);
  const projectId = useEditor((s) => s.projectId), [peaks, setPeaks] = useState<Record<string, Float32Array>>({}), pending = useRef(new Set<string>());
  /** Forme d'onde des sons : calculée une fois par fichier, en arrière-plan. */
  useEffect(() => {
    for (const [id, a] of Object.entries(doc.assets)) {
      if (a.type !== "audio" || peaks[id] || pending.current.has(id)) continue;
      pending.current.add(id);
      void (async () => {
        try { const b = await getFile(projectId, id, a as { fp?: string; remote?: string }); if (!b) return; const p = await audioPeaks(b, a.fp ?? id); setPeaks((x) => ({ ...x, [id]: p })); }
        catch { /* pas de forme d'onde : le clip reste affiché normalement */ } finally { pending.current.delete(id); }
      })();
    }
  }, [doc.assets, projectId, peaks]);
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(""), 6000); };
  /** « + » d'une piste : ajoute l'élément par défaut du type (ou ouvre le sélecteur de fichier son pour l'audio). */
  const addTo = (trackId: string, kind: TrackKind) => {
    if (kind === "audio") { audioTarget.current = trackId; fileRef.current?.click(); return; }
    const r = act.addDefaultClip(trackId); if (r.msg) flash(r.msg);
  };
  /** Menu « + Piste » : la piste est créée AVEC son élément par défaut ; si c'est impossible, rien n'est créé (pas de piste vierge). */
  const addTrackWithDefault = (kind: TrackKind) => {
    if (kind === "audio") { audioTarget.current = ""; fileRef.current?.click(); return; }
    const id = act.addTrack(kind), r = act.addDefaultClip(id);
    if (!r.ok) act.undo();
    if (r.msg) flash(r.msg);
  };
  const onAudioFile = async (file?: File) => {
    if (!file) return;
    const created = !audioTarget.current, trackId = audioTarget.current || act.addTrack("audio");
    const r = await act.importAudio(file, trackId);
    if (!r.ok && created) act.undo();
    flash(r.ok ? "Audio ajouté." : (r.msg ?? "Audio illisible."));
  };

  const width = Math.max(layout.duration + 4000, 12000) * zoom;
  const ticks = useMemo(() => { const step = zoom > 0.15 ? 1000 : zoom > 0.05 ? 2000 : zoom > 0.025 ? 5000 : 10000; return Array.from({ length: Math.ceil((layout.duration + 4000) / step) + 1 }, (_, i) => i * step); }, [layout.duration, zoom]);

  /** Index (dans doc.tracks) de la piste sous le pointeur. La liste est affichée à l'envers : le dessus (dernier index) est en haut. */
  const trackAt = (clientY: number): number | null => {
    const el = scroller.current; if (!el) return null;
    const row = Math.floor((clientY - el.getBoundingClientRect().top + el.scrollTop - RULER) / ROW), n = useEditor.getState().doc.tracks.length;
    return row >= 0 && row < n ? n - 1 - row : null;
  };
  const xToMs = (clientX: number) => { const el = scroller.current!; return Math.max(0, (clientX - el.getBoundingClientRect().left + el.scrollLeft - HEAD) / zoom); };
  /** Glisser la poignée d'une piste : change son rang d'empilement (le haut de la liste = premier plan). */
  const dragTrack = (e: React.PointerEvent, id: string) => {
    e.stopPropagation(); e.preventDefault();
    const move = (ev: PointerEvent) => { const ti = trackAt(ev.clientY); if (ti !== null) act.reorderTrack(id, ti); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); act.endGesture(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const fits = (assetId: string | null, kind: TrackKind) => { const a = assetId ? doc.assets[assetId] : undefined; return !!a && ((kind === "video" && (a.type === "video" || a.type === "image")) || (kind === "audio" && a.type === "audio") || (kind === "shape" && a.type === "svg")); };
  const onDragOverTrack = (e: React.DragEvent, tr: Track) => {
    const id = useEditor.getState().dragAsset; if (!id) return;
    const ok = fits(id, tr.kind) && !tr.locked;
    if (ok) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
    setDropTrack({ id: tr.id, ok });
  };
  const onDropTrack = (e: React.DragEvent, tr: Track) => {
    e.preventDefault(); e.stopPropagation();
    const id = e.dataTransfer.getData("application/x-motionia-asset") || useEditor.getState().dragAsset;
    setDropTrack(null); act.setDragAsset(null); if (!id) return;
    const r = act.dropAsset(id, tr.id, xToMs(e.clientX)); if (r.msg) flash(r.msg);
  };
  /** Dépôt hors d'une piste (zone vide) : le média va sur une piste adaptée, créée si besoin. */
  const onDropEmpty = (e: React.DragEvent) => {
    e.preventDefault(); const id = e.dataTransfer.getData("application/x-motionia-asset") || useEditor.getState().dragAsset;
    setDropTrack(null); act.setDragAsset(null); if (!id) return;
    const r = act.placeAsset(id, xToMs(e.clientX)); if (r.msg) flash(r.msg);
  };

  const seek = (e: React.PointerEvent) => {
    const el = scroller.current!, x = e.clientX - el.getBoundingClientRect().left + el.scrollLeft - HEAD;
    act.setPlaying(false); act.setT(x / zoom);
    const move = (ev: PointerEvent) => act.setT((ev.clientX - el.getBoundingClientRect().left + el.scrollLeft - HEAD) / zoom);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  /** Glisser un clip (déplacement / rognage) avec snapping sur playhead, bords des clips et début. */
  const drag = (e: React.PointerEvent, p: Placed, mode: "move" | "l" | "r") => {
    e.stopPropagation(); act.select(p.id); act.setPlaying(false);
    const track = doc.tracks[p.trackIdx]; if (track.locked) return;
    const x0 = e.clientX, start = p.at, startDur = p.dur;
    const edges = [0, useEditor.getState().t, ...layout.list.filter((q) => q.id !== p.id && q.ok).flatMap((q) => [q.at, q.at + q.dur])];
    const snap = (v: number) => { let best = v, d = SNAP_PX / zoom; for (const c of edges) if (Math.abs(c - v) < d) { d = Math.abs(c - v); best = c; } return best; };
    let last = 0;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / zoom;
      const cur = layoutDoc(useEditor.getState().doc).byId[p.id]; if (!cur) return;
      if (mode === "move") {
        // Le pointeur est-il sur une AUTRE piste du même type ? Alors le clip y passe (piste principale : à la bonne place).
        const ti = trackAt(ev.clientY), target = ti !== null ? useEditor.getState().doc.tracks[ti] : undefined;
        if (target && target.id !== cur.trackId && target.kind === cur.kind && !target.locked) { act.moveClipToTrack(p.id, target.id, start + dt); return; }
        if (cur.magnetic) {
          const mid = start + startDur / 2 + dt;
          const others = layoutDoc(useEditor.getState().doc).list.filter((q) => q.trackId === cur.trackId && q.id !== p.id);
          act.reorderMagnetic(p.id, others.filter((q) => q.at + q.dur / 2 < mid).length);
        } else {
          let s = start + dt; const sn = snap(s), en = snap(s + startDur) - startDur;
          s = Math.abs(sn - s) <= Math.abs(en - s) ? sn : en;
          act.moveClip(p.id, s - cur.at);
        }
      } else if (mode === "l") { const ns = snap(start + dt); act.trimClip(p.id, "l", ns - cur.at); }
      else { const ne = snap(start + startDur + dt); act.trimClip(p.id, "r", ne - (cur.at + cur.dur)); }
      last = dt;
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); act.endGesture(); void last; };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted">
        <span className="font-mono text-ink">{fmt(t)}</span>
        <span className="mx-1 h-3 w-px bg-line" />
        <button className="btn !px-2 !py-0.5" onClick={() => act.setZoom(zoom / 1.4)} aria-label="Dézoomer">−</button>
        <input type="range" min={0.01} max={0.5} step={0.005} value={zoom} onChange={(e) => act.setZoom(+e.target.value)} className="w-24" aria-label="Zoom" />
        <button className="btn !px-2 !py-0.5" onClick={() => act.setZoom(zoom * 1.4)} aria-label="Zoomer">+</button>
        <span className="mx-1 h-3 w-px bg-line" />
        <button className="btn !px-2 !py-0.5" onClick={act.splitAtPlayhead} title="S">Couper</button>
        <button className="btn !px-2 !py-0.5" onClick={act.deleteSelected} disabled={!selection} title="Suppr">Supprimer</button>
        <select className="field !w-auto !py-0.5 !text-xs" value="" onChange={(e) => { if (e.target.value) addTrackWithDefault(e.target.value as TrackKind); }} aria-label="Ajouter une piste">
          <option value="">+ Piste (avec un élément)</option>{(Object.keys(KIND) as TrackKind[]).map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}
        </select>
        {notice && <span role="status" className="ml-2 truncate text-warn">{notice}</span>}
        <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => { void onAudioFile(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: width + HEAD, minHeight: "100%" }} onDragOver={(e) => { if (useEditor.getState().dragAsset) e.preventDefault(); }} onDrop={onDropEmpty}>
          {/* règle */}
          <div className="sticky top-0 z-20 flex h-6 cursor-col-resize border-b border-line bg-panel" onPointerDown={seek}>
            <div className="sticky left-0 z-30 shrink-0 border-r border-line bg-panel" style={{ width: HEAD }} />
            <div className="relative flex-1">{ticks.map((ms) => <span key={ms} className="absolute top-0 h-full border-l border-line pl-1 font-mono text-[10px] text-muted" style={{ left: ms * zoom }}>{ms / 1000}s</span>)}</div>
          </div>
          {doc.tracks.length === 0 && <p className="p-6 text-sm text-muted">Aucune piste. Ajoutez un média depuis le panneau de gauche, ou glissez-le ici.</p>}
          {[...doc.tracks].map((tr, ti) => ({ tr, ti })).reverse().map(({ tr, ti }) => (
            <div key={tr.id} className="flex border-b border-line/60" style={{ height: ROW }}>
              <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-line bg-panel px-1.5 text-xs" style={{ width: HEAD }}>
                <span onPointerDown={(e) => dragTrack(e, tr.id)} className="cursor-grab select-none px-0.5 text-muted hover:text-ink" title="Glisser pour réordonner (le haut de la liste est au premier plan)" aria-label="Réordonner la piste">⠿</span>
                <span className="flex flex-col leading-none">
                  <button className="text-[9px] text-muted hover:text-ink disabled:opacity-25" disabled={ti === doc.tracks.length - 1} onClick={() => act.moveTrack(tr.id, "up")} aria-label="Monter la piste (vers le premier plan)" title="Monter (premier plan)">▲</button>
                  <button className="text-[9px] text-muted hover:text-ink disabled:opacity-25" disabled={ti === 0} onClick={() => act.moveTrack(tr.id, "down")} aria-label="Descendre la piste (vers l'arrière-plan)" title="Descendre (arrière-plan)">▼</button>
                </span>
                <span className="min-w-0 flex-1 truncate"><i className={`mr-1.5 inline-block h-2 w-2 rounded-sm align-middle ${KIND[tr.kind].bar}`} />{KIND[tr.kind].label}</span>
                <span className="flex gap-0.5">
                  <button className="rounded bg-raised px-1.5 font-semibold text-accent-2" onClick={() => addTo(tr.id, tr.kind)} aria-label={tr.kind === "audio" ? "Importer un fichier audio" : "Ajouter un élément"} title={tr.kind === "audio" ? "Importer un fichier audio" : "Ajouter un élément par défaut au playhead"}>{tr.kind === "audio" ? "♪" : "+"}</button>
                  {tr.clips.length === 0 && <button className="rounded px-1 text-muted hover:text-bad" onClick={() => act.removeTrack(tr.id)} aria-label="Supprimer la piste vide" title="Supprimer la piste vide">×</button>}
                  <button className={`rounded px-1 ${tr.muted ? "text-accent" : "text-muted"}`} onClick={() => act.toggleTrack(tr.id, "muted")} aria-label="Muet" title="Muet">M</button>
                  <button className={`rounded px-1 ${tr.locked ? "text-accent" : "text-muted"}`} onClick={() => act.toggleTrack(tr.id, "locked")} aria-label="Verrouiller" title="Verrouiller">V</button>
                </span>
              </div>
              <div className={`relative flex-1 ${dropTrack?.id === tr.id ? (dropTrack.ok ? "bg-accent-2/15 outline outline-1 -outline-offset-1 outline-accent-2" : "bg-bad/10") : ""}`} onPointerDown={seek}
                onDragOver={(e) => onDragOverTrack(e, tr)} onDragLeave={() => setDropTrack(null)} onDrop={(e) => onDropTrack(e, tr)}>
                {layout.list.filter((p) => p.trackIdx === ti && p.ok).map((p) => {
                  const sel = selection === p.id;
                  const warn = layout.warnings.some((w) => w.clipId === p.id);
                  return (
                    <div key={p.id} onPointerDown={(e) => drag(e, p, "move")}
                      className={`absolute top-1 flex h-[30px] select-none items-center overflow-hidden rounded-md text-[11px] font-medium text-black/80 ${KIND[tr.kind].bar} ${sel ? "ring-2 ring-ink" : ""} ${tr.locked ? "opacity-50" : "cursor-grab"} ${tr.muted ? "opacity-40" : ""}`}
                      style={{ left: p.at * zoom, width: Math.max(6, p.dur * zoom) }} title={warn ? "Voir les avertissements" : p.id}>
                      {tr.kind === "audio" && (() => { const c: any = p.clip, a: any = doc.assets[c.asset], pk = peaks[c.asset]; return pk && a?.dur ? <Wave peaks={pk} from={(c.src?.[0] ?? 0) / a.dur} to={(c.src?.[1] ?? a.dur) / a.dur} /> : null; })()}
                      <span className="pointer-events-none relative truncate px-2">{label(p, doc)}</span>
                      {tr.kind === "caption" && captionTicks(p, doc).map((x, i) => <i key={i} className="pointer-events-none absolute bottom-0 h-1.5 w-px bg-black/50" style={{ left: x * zoom }} />)}
                      {warn && <span className="absolute right-1 top-0.5 text-[10px]">⚠</span>}
                      <span onPointerDown={(e) => drag(e, p, "l")} className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize bg-black/25" />
                      <span onPointerDown={(e) => drag(e, p, "r")} className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize bg-black/25" />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="pointer-events-none absolute top-0 z-30 h-full w-px bg-accent" style={{ left: HEAD + t * zoom }}><i className="absolute -left-[5px] top-0 h-2.5 w-2.5 rounded-full bg-accent" /></div>
        </div>
      </div>
    </div>
  );
}

/** Forme d'onde d'un clip audio : 160 colonnes, la tranche [from, to] (0..1) du fichier. */
function Wave({ peaks, from, to }: { peaks: Float32Array; from: number; to: number }) {
  const n = 160, i0 = from * peaks.length, span = Math.max(1, (to - from) * peaks.length), d: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i0 + (i / n) * span), b = Math.max(a + 1, Math.floor(i0 + ((i + 1) / n) * span)); let m = 0;
    for (let k = a; k < b && k < peaks.length; k++) if (peaks[k] > m) m = peaks[k];
    const h = Math.min(14, m * 30); d.push(`M${i},${15 - h}V${15 + h}`);
  }
  return <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full opacity-60" viewBox={`0 0 ${n} 30`} preserveAspectRatio="none"><path d={d.join("")} stroke="currentColor" strokeWidth="0.8" fill="none" vectorEffect="non-scaling-stroke" /></svg>;
}

function label(p: Placed, doc: ReturnType<typeof useEditor.getState>["doc"]): string {
  const c: any = p.clip;
  if (p.kind === "video") return (doc.assets[c.asset] as { name?: string } | undefined)?.name ?? c.asset;
  if (p.kind === "text") return c.text ?? c.style;
  if (p.kind === "caption") return "Sous-titres";
  if (p.kind === "overlay") return c.effect;
  if (p.kind === "adjustment") return (c.fx ?? []).map((f: any) => f.id).join(", ") || "Calque";
  return (doc.assets[c.asset] as { name?: string } | undefined)?.name ?? c.asset ?? c.id;
}
/** Positions (ms relatives au clip) des mots d'un sous-titre : ils sont visibles dans la timeline. */
function captionTicks(p: Placed, doc: ReturnType<typeof useEditor.getState>["doc"]): number[] {
  const L = layoutDoc(doc), src = L.byId[(p.clip as any).from]; if (!src) return [];
  const vc = src.clip as VideoClip, tm = { at: src.at, src: vc.src, speed: vc.speed };
  return wordsOf(doc, vc.asset).filter((w) => w.s >= vc.src[0] && w.e <= vc.src[1]).map((w) => srcToTimeline(tm, w.s) - p.at);
}
