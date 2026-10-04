//src/components/Timeline.tsx
/**
 * Timeline.tsx — pistes empilées, clips déplaçables/rognables, playhead, zoom, snapping, mute/lock, mots des sous-titres.
 * Contient : <Timeline/> (règle, pistes, clips, glisser/rogner par pointer events, ripple magnétique).
 * Ne contient PAS : calculs de temps (engine.ts) ni modification directe du document (tout passe par les actions du store).
 */
"use client";
import { useMemo, useRef } from "react";
import { layoutDoc, wordsOf, srcToTimeline, type Placed } from "@/lib/engine";
import { useEditor } from "@/lib/store";
import type { TrackKind, VideoClip } from "@/lib/schema";
import { fmt } from "./Preview";

const KIND: Record<TrackKind, { label: string; bar: string }> = {
  video: { label: "Vidéo", bar: "bg-k-video" }, adjustment: { label: "Effets", bar: "bg-k-adjustment" }, overlay: { label: "Overlay", bar: "bg-k-overlay" },
  text: { label: "Texte", bar: "bg-k-text" }, caption: { label: "Sous-titres", bar: "bg-k-caption" }, shape: { label: "Formes", bar: "bg-k-shape" }, audio: { label: "Audio", bar: "bg-k-audio" },
};
const ROW = 38, HEAD = 112, SNAP_PX = 8;

export default function Timeline() {
  const doc = useEditor((s) => s.doc), t = useEditor((s) => s.t), zoom = useEditor((s) => s.zoom), selection = useEditor((s) => s.selection);
  const act = useEditor.getState();
  const layout = useMemo(() => layoutDoc(doc), [doc]);
  const scroller = useRef<HTMLDivElement>(null);
  const width = Math.max(layout.duration + 4000, 12000) * zoom;
  const ticks = useMemo(() => { const step = zoom > 0.15 ? 1000 : zoom > 0.05 ? 2000 : zoom > 0.025 ? 5000 : 10000; return Array.from({ length: Math.ceil((layout.duration + 4000) / step) + 1 }, (_, i) => i * step); }, [layout.duration, zoom]);

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
        if (p.magnetic) {
          const mid = start + startDur / 2 + dt;
          const others = layout.list.filter((q) => q.trackId === p.trackId && q.id !== p.id);
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
        <select className="field !w-auto !py-0.5 !text-xs" value="" onChange={(e) => { if (e.target.value) act.addTrack(e.target.value as TrackKind); }} aria-label="Ajouter une piste">
          <option value="">+ Piste</option>{(Object.keys(KIND) as TrackKind[]).map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}
        </select>
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: width + HEAD, minHeight: "100%" }}>
          {/* règle */}
          <div className="sticky top-0 z-20 flex h-6 cursor-col-resize border-b border-line bg-panel" onPointerDown={seek}>
            <div className="sticky left-0 z-30 w-28 shrink-0 border-r border-line bg-panel" />
            <div className="relative flex-1">{ticks.map((ms) => <span key={ms} className="absolute top-0 h-full border-l border-line pl-1 font-mono text-[10px] text-muted" style={{ left: ms * zoom }}>{ms / 1000}s</span>)}</div>
          </div>
          {doc.tracks.length === 0 && <p className="p-6 text-sm text-muted">Aucune piste. Ajoutez un rush depuis le panneau de gauche.</p>}
          {[...doc.tracks].map((tr, ti) => ({ tr, ti })).reverse().map(({ tr, ti }) => (
            <div key={tr.id} className="flex border-b border-line/60" style={{ height: ROW }}>
              <div className="sticky left-0 z-10 flex w-28 shrink-0 items-center justify-between gap-1 border-r border-line bg-panel px-2 text-xs">
                <span className="truncate"><i className={`mr-1.5 inline-block h-2 w-2 rounded-sm align-middle ${KIND[tr.kind].bar}`} />{KIND[tr.kind].label}</span>
                <span className="flex gap-0.5">
                  <button className={`rounded px-1 ${tr.muted ? "text-accent" : "text-muted"}`} onClick={() => act.toggleTrack(tr.id, "muted")} aria-label="Muet" title="Muet">M</button>
                  <button className={`rounded px-1 ${tr.locked ? "text-accent" : "text-muted"}`} onClick={() => act.toggleTrack(tr.id, "locked")} aria-label="Verrouiller" title="Verrouiller">V</button>
                </span>
              </div>
              <div className="relative flex-1" onPointerDown={seek}>
                {layout.list.filter((p) => p.trackIdx === ti && p.ok).map((p) => {
                  const sel = selection === p.id;
                  const warn = layout.warnings.some((w) => w.clipId === p.id);
                  return (
                    <div key={p.id} onPointerDown={(e) => drag(e, p, "move")}
                      className={`absolute top-1 flex h-[30px] select-none items-center overflow-hidden rounded-md text-[11px] font-medium text-black/80 ${KIND[tr.kind].bar} ${sel ? "ring-2 ring-ink" : ""} ${tr.locked ? "opacity-50" : "cursor-grab"} ${tr.muted ? "opacity-40" : ""}`}
                      style={{ left: p.at * zoom, width: Math.max(6, p.dur * zoom) }} title={warn ? "Voir les avertissements" : p.id}>
                      <span className="pointer-events-none truncate px-2">{label(p, doc)}</span>
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

function label(p: Placed, doc: ReturnType<typeof useEditor.getState>["doc"]): string {
  const c: any = p.clip;
  if (p.kind === "video") return doc.assets[c.asset]?.type === "video" ? ((doc.assets[c.asset] as any).name ?? c.asset) : c.asset;
  if (p.kind === "text") return c.text ?? c.style;
  if (p.kind === "caption") return "Sous-titres";
  if (p.kind === "overlay") return c.effect;
  if (p.kind === "adjustment") return (c.fx ?? []).map((f: any) => f.id).join(", ") || "Calque";
  return c.asset ?? c.id;
}
/** Positions (ms relatives au clip) des mots d'un sous-titre : ils sont visibles dans la timeline. */
function captionTicks(p: Placed, doc: ReturnType<typeof useEditor.getState>["doc"]): number[] {
  const L = layoutDoc(doc), src = L.byId[(p.clip as any).from]; if (!src) return [];
  const vc = src.clip as VideoClip, tm = { at: src.at, src: vc.src, speed: vc.speed };
  return wordsOf(doc, vc.asset).filter((w) => w.s >= vc.src[0] && w.e <= vc.src[1]).map((w) => srcToTimeline(tm, w.s) - p.at);
}
