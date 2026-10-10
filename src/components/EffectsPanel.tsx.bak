//src/components/EffectsPanel.tsx
/**
 * EffectsPanel.tsx — bibliothèque de TOUS les effets du catalogue, groupés par type, avec recherche ; « Appliquer » agit sur la sélection.
 * Contient : <EffectsPanel/>. Les groupes vides n'apparaissent pas (un type sans effet disponible n'est pas affiché).
 * Ne contient PAS : la logique d'application (store.applyEffect) ni la liste des effets (registre src/effects/index.ts).
 */
"use client";
import { useMemo, useState } from "react";
import { activeEffects } from "@/effects";
import { layoutDoc } from "@/lib/engine";
import type { EffectKind } from "@/lib/schema";
import { useEditor } from "@/lib/store";

const GROUPS: { kind: EffectKind; label: string; how: string }[] = [
  { kind: "fx", label: "Effets d'image", how: "Sur le clip sélectionné, sinon un calque d'effets au playhead" },
  { kind: "lut", label: "Looks (étalonnage)", how: "Sur tout le projet" },
  { kind: "transition", label: "Transitions", how: "Entre le clip sélectionné et le suivant (piste principale)" },
  { kind: "overlay", label: "Overlays", how: "Nouvelle couche au playhead" },
  { kind: "mesh", label: "Déformations", how: "Sur le clip sélectionné" },
  { kind: "motion_preset", label: "Animations", how: "Sur le clip sélectionné" },
  { kind: "text_style", label: "Styles de texte", how: "Sur le texte sélectionné, sinon un nouveau texte" },
  { kind: "caption_style", label: "Styles de sous-titres", how: "Sur les sous-titres sélectionnés, sinon une nouvelle piste" },
  { kind: "shape_preset", label: "Formes et gabarits", how: "Nouvelle forme au playhead" },
  { kind: "audio_fx", label: "Effets audio", how: "Sur le clip sélectionné qui a du son" },
  { kind: "sfx", label: "Sons (effets sonores)", how: "Nouveau son au playhead" },
];

export default function EffectsPanel() {
  const disabled = useEditor((s) => s.disabled), doc = useEditor((s) => s.doc), sel = useEditor((s) => s.selection);
  const [q, setQ] = useState(""), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const p = useMemo(() => (sel ? layoutDoc(doc).byId[sel] : undefined), [doc, sel]);
  const groups = GROUPS.map((g) => ({ ...g, items: activeEffects(disabled, g.kind).filter((e) => !q.trim() || `${e.id} ${e.describe}`.toLowerCase().includes(q.trim().toLowerCase())) })).filter((g) => g.items.length);
  const apply = (id: string) => { const r = useEditor.getState().applyEffect(id); setMsg({ ok: r.ok, text: r.ok ? "Effet appliqué (Ctrl+Z pour annuler)." : r.msg ?? "Impossible d'appliquer cet effet." }); };
  return (
    <div className="space-y-3 p-3 text-xs">
      <input className="field" placeholder="Rechercher un effet…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher un effet" />
      <p className="rounded border border-line bg-raised px-2 py-1.5 text-muted">{p ? <>Cible : <b className="text-ink">{p.kind} · {p.id}</b></> : "Aucun clip sélectionné : certains effets créent un nouvel élément au playhead."}</p>
      {msg && <p role="status" className={`rounded border px-2 py-1.5 ${msg.ok ? "border-ok/40 text-ok" : "border-warn/40 text-warn"}`}>{msg.text}</p>}
      {!groups.length && <p className="text-muted">Aucun effet ne correspond.</p>}
      {groups.map((g) => (
        <details key={g.kind} open={!!q.trim() || g.kind === "fx"} className="rounded-lg border border-line">
          <summary className="cursor-pointer select-none px-2.5 py-2 font-medium">{g.label} <span className="chip ml-1">{g.items.length}</span></summary>
          <p className="px-2.5 pb-1 text-[11px] text-muted">{g.how}</p>
          <ul className="divide-y divide-line">
            {g.items.map((e) => (
              <li key={e.id} className="flex items-start gap-2 px-2.5 py-2">
                <div className="min-w-0 flex-1"><p className="font-mono text-[11px]">{e.id}{e.cost === "heavy" && <span className="chip ml-1.5">lourd</span>}</p><p className="mt-0.5 text-muted">{e.describe}</p></div>
                <button className="btn !px-2 !py-1" onClick={() => apply(e.id)}>Appliquer</button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
