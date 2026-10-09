//src/components/GeneratePanel.tsx
/**
 * GeneratePanel.tsx — génération de médias par IA : fenêtre « Générer » (image ou vidéo courte, coût affiché AVANT de confirmer),
 *                     suivi des tâches, et liste des illustrations SUGGÉRÉES par l'IA (rien n'est généré sans clic).
 * Contient : <GenerateButton/> (fenêtre) et <Suggestions/> (propositions de l'analyse). Les règles de prix viennent de lib/generate.ts.
 * Ne contient PAS : appels à Google (serveur), stockage (serveur), placement dans la timeline (store.importGenerated).
 */
"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/media";
import { IMAGE_ASPECTS, VIDEO_ASPECTS, VIDEO_SECONDS } from "@/lib/generate";
import { useEditor, type GeneratedResult } from "@/lib/store";
import type { Suggestion } from "@/lib/schema";

export interface GenInfo { enabled: boolean; imageCredits: number; videoCreditsPerSec: number; maxVideoSec: number; videoEnabled: boolean; videoPaidOnly: boolean }
type Aspect = (typeof IMAGE_ASPECTS)[number];
interface Req { kind: "image" | "video"; prompt: string; aspect: Aspect; seconds?: 4 | 6 | 8 }

/** Lance une génération, suit la tâche, puis ajoute le média au projet. Un seul endroit pour les deux usages (fenêtre et suggestions). */
async function generate(req: Req, at: number | undefined, onStep: (msg: string, p: number) => void): Promise<{ ok: boolean; msg?: string }> {
  const projectId = useEditor.getState().projectId;
  try {
    const { jobId } = await api("generate", "POST", { projectId, ...req });
    for (let i = 0; i < 160; i++) {
      await new Promise((r) => setTimeout(r, req.kind === "image" ? 2000 : 5000));
      const j = await api(`jobs/${jobId}`);
      onStep(j.message ?? "Génération en cours…", j.progress ?? 0);
      if (j.status === "failed") return { ok: false, msg: j.error ?? "La génération a échoué : crédits remboursés." };
      if (j.status === "done" && j.result) return await useEditor.getState().importGenerated(j.result as GeneratedResult, at);
    }
    return { ok: false, msg: "La génération prend plus de temps que prévu : elle apparaîtra dans vos médias si elle aboutit." };
  } catch (e) { return { ok: false, msg: e instanceof ApiError ? e.message : (e as Error).message }; }
}

export function GenerateButton({ gen, credits, onDone, say }: { gen: GenInfo; credits: number; onDone: () => void; say: (k: "ok" | "err", m: string) => void }) {
  const [open, setOpen] = useState(false), [kind, setKind] = useState<"image" | "video">("image"), [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<Aspect>("9:16"), [seconds, setSeconds] = useState<4 | 6 | 8>(4), [busy, setBusy] = useState(""), [pct, setPct] = useState(0);
  if (!gen.enabled) return null;
  const secs = Math.min(seconds, gen.maxVideoSec) as 4 | 6 | 8;
  const cost = kind === "image" ? gen.imageCredits : Math.max(1, Math.round(gen.videoCreditsPerSec * secs));
  const aspects = kind === "video" ? VIDEO_ASPECTS : IMAGE_ASPECTS;
  const submit = async () => {
    setBusy("Envoi…"); setPct(0.02);
    const r = await generate({ kind, prompt, aspect: aspects.includes(aspect as never) ? aspect : "9:16", ...(kind === "video" ? { seconds: secs } : {}) }, undefined, (m, p) => { setBusy(m); setPct(p); });
    setBusy(""); if (r.ok) { say("ok", "Média généré et ajouté à la timeline."); setOpen(false); setPrompt(""); onDone(); } else say("err", r.msg ?? "La génération a échoué.");
  };
  return (
    <>
      <button className="btn w-full" onClick={() => setOpen(true)}>✨ Générer une image ou une vidéo</button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Générer un média">
          <div className="panel w-full max-w-md p-5">
            <h2 className="font-display text-4xl">Générer avec l'IA</h2>
            <div className="mt-4 flex gap-2">
              <button className={`btn flex-1 ${kind === "image" ? "btn-primary" : ""}`} onClick={() => setKind("image")} disabled={!!busy}>Image</button>
              <button className={`btn flex-1 ${kind === "video" ? "btn-primary" : ""}`} onClick={() => gen.videoEnabled && setKind("video")} disabled={!!busy || !gen.videoEnabled} title={gen.videoEnabled ? "" : gen.videoPaidOnly ? "Réservée aux comptes ayant acheté des crédits" : "Indisponible"}>Vidéo courte</button>
            </div>
            {!gen.videoEnabled && <p className="mt-2 text-xs text-muted">{gen.videoPaidOnly ? "La vidéo est réservée aux comptes ayant acheté des crédits." : "La vidéo n'est pas disponible actuellement."}</p>}
            <label className="mt-4 block text-xs"><span className="mb-1 block text-muted">Décrivez le visuel (en anglais, c'est plus précis)</span>
              <textarea className="field min-h-24" maxLength={600} disabled={!!busy} placeholder="A minimalist illustration of a rocket launching over a pastel sunrise, flat style" value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
            <div className="mt-3 flex gap-3 text-xs">
              <label className="flex-1"><span className="mb-1 block text-muted">Format</span><select className="field" value={aspects.includes(aspect as never) ? aspect : "9:16"} disabled={!!busy} onChange={(e) => setAspect(e.target.value as Aspect)}>{aspects.map((a) => <option key={a}>{a}</option>)}</select></label>
              {kind === "video" && <label className="flex-1"><span className="mb-1 block text-muted">Durée</span><select className="field" value={secs} disabled={!!busy} onChange={(e) => setSeconds(Number(e.target.value) as 4 | 6 | 8)}>{VIDEO_SECONDS.filter((x) => x <= gen.maxVideoSec).map((x) => <option key={x} value={x}>{x} s</option>)}</select></label>}
            </div>
            <p className={`mt-4 text-sm ${credits < cost ? "text-bad" : ""}`}><b>{cost} crédits</b> <span className="text-muted">· solde {credits}</span></p>
            <p className="mt-1 text-[11px] text-muted">Les médias générés contiennent un filigrane invisible (SynthID) posé par Google. Évitez les personnes réelles identifiables et les marques. Crédits remboursés si la génération échoue.</p>
            {busy && <div className="mt-3"><p className="flex items-center gap-2 text-sm"><i className="spinner" />{busy}</p><div className="mt-2 h-1.5 overflow-hidden rounded bg-line"><div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(pct * 100)}%` }} /></div></div>}
            <div className="mt-5 flex gap-2"><button className="btn flex-1" onClick={() => setOpen(false)} disabled={!!busy}>Fermer</button><button className="btn btn-primary flex-1" onClick={submit} disabled={!!busy || prompt.trim().length < 3 || credits < cost}>Générer</button></div>
          </div>
        </div>
      )}
    </>
  );
}

/** Illustrations proposées par l'IA après l'analyse : l'utilisateur coche, voit le coût, et seulement alors on génère. */
export function Suggestions({ gen, credits, onDone, say }: { gen: GenInfo; credits: number; onDone: () => void; say: (k: "ok" | "err", m: string) => void }) {
  const list = useEditor((s) => s.suggestions), set = useEditor.getState().setSuggestions;
  const [busy, setBusy] = useState<number | null>(null), [note, setNote] = useState("");
  if (!gen.enabled || !list.length) return null;
  const run = async (s: Suggestion, i: number) => {
    setBusy(i);
    const r = await generate({ kind: "image", prompt: s.prompt, aspect: s.aspect ?? "9:16" }, s.at, (m) => setNote(m));
    setBusy(null); setNote("");
    if (r.ok) { set(useEditor.getState().suggestions.filter((_, k) => k !== i)); say("ok", "Illustration ajoutée à la timeline."); onDone(); } else say("err", r.msg ?? "La génération a échoué.");
  };
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 p-2 text-xs">
      <p className="mb-1.5 font-medium">Illustrations suggérées par l'IA</p>
      <ul className="space-y-2">
        {list.map((s, i) => s.kind === "image" && (
          <li key={i} className="rounded border border-line bg-panel p-2">
            <textarea className="field !py-1 !text-[11px]" rows={2} maxLength={600} value={s.prompt} disabled={busy !== null} onChange={(e) => set(list.map((x, k) => (k === i ? { ...x, prompt: e.target.value } : x)))} />
            {s.reason && <p className="mt-1 text-muted">{s.reason}</p>}
            <div className="mt-1.5 flex items-center gap-2">
              <button className="btn btn-primary !px-2 !py-0.5" disabled={busy !== null || credits < gen.imageCredits} onClick={() => void run(s, i)}>{busy === i ? note || "Génération…" : `Générer · ${gen.imageCredits} crédits`}</button>
              <button className="btn btn-ghost !px-2 !py-0.5 text-muted" disabled={busy !== null} onClick={() => set(list.filter((_, k) => k !== i))}>Ignorer</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
