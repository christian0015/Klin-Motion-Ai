//src/components/Preview.tsx
/**
 * Preview.tsx — canvas R3F (contexte WebGL) qui exécute le Compositor, + transport (lecture, pause, scrub) et comparaison A/B.
 * Contient : <Preview/>, Stage (boucle de rendu), horloge maître de lecture, formatage du temps.
 * Ne contient PAS : maths de timeline (engine.ts), shaders (render.tsx), état (store.ts).
 * L'horloge de lecture est la seule source de temps de l'UI ; le rendu lui-même reste pur (renderFrame(doc, t)).
 */
"use client";
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Compositor, PreviewSource, ensureFonts } from "@/lib/render";
import { buildFrameState, layoutDoc, type Layout } from "@/lib/engine";
import { useEditor } from "@/lib/store";
import type { Composition } from "@/lib/schema";

const PREVIEW_W = 540; // résolution réduite en preview (budget mobile) ; l'export rend en pleine résolution
const layouts = new WeakMap<Composition, Layout>();
const layoutOf = (d: Composition) => { let l = layouts.get(d); if (!l) { l = layoutDoc(d); layouts.set(d, l); } return l; };

export const fmt = (ms: number) => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.floor((s * 100) % 100)).padStart(2, "0")}`; };

interface Callbacks { onMissing: (id: string) => void; onProblem: (id: string, msg: string) => void }

/** `cb` est une ref : changer de fonction ne doit JAMAIS recréer le Compositor ni la source vidéo (sinon écran noir en lecture). */
function Stage({ cb }: { cb: React.MutableRefObject<Callbacks> }) {
  const gl = useThree((s) => s.gl);
  const projectId = useEditor((s) => s.projectId);
  const comp = useRef<Compositor | null>(null), src = useRef<PreviewSource | null>(null);
  useEffect(() => {
    const c = useEditor.getState().doc.canvas;
    comp.current = new Compositor(gl, PREVIEW_W, Math.round((PREVIEW_W * c.h) / c.w));
    src.current = new PreviewSource(projectId, () => useEditor.getState().doc, (id) => cb.current.onMissing(id), (id, m) => cb.current.onProblem(id, m));
    void ensureFonts(useEditor.getState().doc);
    return () => { src.current?.dispose(); comp.current?.dispose(); comp.current = null; src.current = null; };
  }, [gl, projectId, cb]);

  // Priorité 1 : désactive le rendu automatique de R3F (on dessine nous-mêmes)
  useFrame((_, dt) => {
    const st = useEditor.getState(), cp = comp.current, sc = src.current; if (!cp || !sc) return;
    let doc = st.doc;
    if (st.compare.on) doc = (st.compare.side === "a" ? st.compare.a : st.compare.b) ?? st.doc;
    const layout = layoutOf(doc);
    let t = st.t;
    if (st.playing) {
      t += dt * 1000;
      if (t >= layout.duration) { t = layout.duration; st.setPlaying(false); sc.pauseAll(); }
      st.setT(t);
    }
    const h = Math.round((PREVIEW_W * doc.canvas.h) / doc.canvas.w); cp.setSize(PREVIEW_W, h);
    cp.disabled = new Set(st.disabled);
    const state = buildFrameState(doc, layout, Math.round(t));
    sc.sync(state, layout, st.playing, doc);
    cp.render(doc, Math.round(t), sc, { layout, state });
  }, 1);
  return null;
}

export default function Preview({ onMissing, onProblem }: Callbacks) {
  const cb = useRef<Callbacks>({ onMissing, onProblem }); cb.current = { onMissing, onProblem };
  const doc = useEditor((s) => s.doc), t = useEditor((s) => s.t), playing = useEditor((s) => s.playing), compare = useEditor((s) => s.compare);
  const { setT, setPlaying, setCompare } = useEditor.getState();
  const active = compare.on ? ((compare.side === "a" ? compare.a : compare.b) ?? doc) : doc;
  const dur = useMemo(() => layoutOf(active).duration, [active]);
  const toggle = () => { if (!playing && t >= dur - 30) setT(0); setPlaying(!playing); };
  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-3">
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
        <div className="relative max-h-full overflow-hidden rounded-xl border border-line bg-black shadow-2xl" style={{ aspectRatio: `${doc.canvas.w} / ${doc.canvas.h}`, height: "100%", maxWidth: "100%" }}>
          <Canvas dpr={1} frameloop="always" gl={{ antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true }} style={{ width: "100%", height: "100%" }}>
            <Stage cb={cb} />
          </Canvas>
          {dur === 0 && <div className="absolute inset-0 grid place-items-center p-6 text-center"><p className="font-display text-3xl text-ink/90">Votre film commence ici</p></div>}
          {compare.on && <span className="chip absolute left-2 top-2 bg-black/70 text-ink">{compare.side === "a" ? compare.labelA : compare.labelB}</span>}
        </div>
      </div>
      <div className="flex w-full max-w-xl items-center gap-3">
        <button className="btn btn-primary !px-3" onClick={toggle} aria-label={playing ? "Pause" : "Lecture"} title="Espace">
          {playing ? <svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="1" width="3.5" height="12" fill="currentColor" /><rect x="8.5" y="1" width="3.5" height="12" fill="currentColor" /></svg> : <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 1l10 6-10 6z" fill="currentColor" /></svg>}
        </button>
        <input type="range" min={0} max={Math.max(1, dur)} value={Math.min(t, dur)} onChange={(e) => { setPlaying(false); setT(+e.target.value); }} className="flex-1" aria-label="Position" />
        <span className="w-28 text-right font-mono text-xs text-muted">{fmt(t)} / {fmt(dur)}</span>
      </div>
      {compare.on && (
        <div className="flex items-center gap-2 text-sm">
          <button className={`btn ${compare.side === "a" ? "btn-primary" : ""}`} onClick={() => setCompare({ side: "a" })}>{compare.labelA}</button>
          <button className={`btn ${compare.side === "b" ? "btn-primary" : ""}`} onClick={() => setCompare({ side: "b" })}>{compare.labelB}</button>
          <button className="btn btn-ghost" onClick={() => setCompare({ on: false })}>Fermer la comparaison</button>
        </div>
      )}
    </div>
  );
}
