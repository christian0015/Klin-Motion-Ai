//src/components/Admin.tsx
/**
 * Admin.tsx — espace admin : vue d'ensemble (coûts, revenus, marge, santé), utilisateurs, tarifs et quotas, effets (interrupteur),
 *             jobs. Le propriétaire gère tout ici : il ne fait que mettre les clés et ajouter des effets.
 * Contient : <Admin/> et ses onglets. Données via /api/admin/* (rôle vérifié côté serveur à chaque appel).
 * Ne contient PAS : logique de crédits ou d'accès base.
 */
"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/media";
import type { Settings } from "@/lib/schema";

const usd = (n: number) => `${n.toFixed(n < 1 ? 3 : 2)} $`;
const Stat = ({ k, v, sub }: { k: string; v: string; sub?: string }) => <div className="panel p-4"><dt className="text-xs text-muted">{k}</dt><dd className="mt-1 text-2xl font-semibold">{v}</dd>{sub && <p className="text-xs text-muted">{sub}</p>}</div>;

export default function Admin() {
  const [tab, setTab] = useState<"overview" | "users" | "pricing" | "effects" | "jobs">("overview");
  const [stats, setStats] = useState<any>(null), [err, setErr] = useState(""), [ok, setOk] = useState("");
  const loadStats = useCallback(() => api("admin/stats").then(setStats).catch((e) => setErr(e.message)), []);
  useEffect(() => { void loadStats(); }, [loadStats]);
  const flash = (m: string) => { setOk(m); setTimeout(() => setOk(""), 4000); };

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-6">
      <header className="flex items-center justify-between"><Link href="/dashboard" className="font-display text-4xl">MotionIA</Link><span className="chip">Administration</span></header>
      <h1 className="mt-8 font-display text-6xl leading-none">Espace admin</h1>
      <nav className="mt-6 flex flex-wrap gap-1 border-b border-line">{([["overview", "Vue d'ensemble"], ["users", "Utilisateurs"], ["pricing", "Tarifs et quotas"], ["effects", "Effets"], ["jobs", "Jobs"]] as const).map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`px-4 py-2 text-sm ${tab === k ? "border-b-2 border-accent" : "text-muted"}`}>{l}</button>)}</nav>
      {err && <p role="alert" className="mt-4 rounded-lg border border-bad/40 bg-bad/10 px-4 py-2 text-sm text-bad">{err}</p>}
      {ok && <p role="status" className="mt-4 rounded-lg border border-ok/40 bg-ok/10 px-4 py-2 text-sm text-ok">{ok}</p>}
      {!stats && !err && <div className="skeleton mt-6 h-40" />}
      {stats && tab === "overview" && <Overview s={stats} />}
      {stats && tab === "users" && <Users plans={Object.keys(stats.settings.plans)} flash={flash} setErr={setErr} />}
      {stats && tab === "pricing" && <Pricing settings={stats.settings} flash={flash} setErr={setErr} reload={loadStats} />}
      {stats && tab === "effects" && <Effects s={stats} flash={flash} setErr={setErr} reload={loadStats} />}
      {tab === "jobs" && <Jobs flash={flash} setErr={setErr} />}
    </div>
  );
}

function Overview({ s }: { s: any }) {
  const jobs = Object.fromEntries(s.jobs.map((j: any) => [j._id, j.n]));
  return (
    <div className="mt-6 space-y-8">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat k="Utilisateurs" v={String(s.users)} /><Stat k="Revenus encaissés" v={usd(s.revenueUsd)} /><Stat k="Coûts mesurés" v={usd(s.costUsd)} sub="IA + stockage (registre)" /><Stat k="Marge" v={usd(s.marginUsd)} />
        <Stat k="Crédits en circulation" v={String(s.creditsOutstanding)} /><Stat k="Stockage utilisé" v={`${(s.storageBytes / 1024 ** 3).toFixed(2)} Go`} /><Stat k="Jobs" v={`${jobs.done ?? 0} ok · ${jobs.failed ?? 0} échecs`} sub={`${(jobs.running ?? 0) + (jobs.queued ?? 0)} en cours`} /><Stat k="Catalogue IA" v={`${s.catalogTokens} tokens`} sub="taille du prompt d'effets" />
      </dl>
      <section><h2 className="mb-2 text-sm font-semibold">Santé</h2>
        <ul className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">{Object.entries(s.health.env).map(([k, v]) => <li key={k} className="flex items-center gap-2"><i className={`h-2 w-2 rounded-full ${v ? "bg-ok" : "bg-bad"}`} /><span className="font-mono text-xs">{k}</span><span className="text-muted">{v ? "présente" : "manquante"}</span></li>)}</ul>
        <p className="mt-3 text-sm text-muted">Modèle d'analyse : <span className="font-mono">{s.health.model}</span> · dernier appel IA : {s.health.lastAiCall ? new Date(s.health.lastAiCall).toLocaleString("fr-FR") : "aucun"}</p>
        {s.health.errors.length > 0 && <ul className="mt-2 space-y-1 text-xs text-bad">{s.health.errors.map((e: any) => <li key={e.id}>{new Date(e.updatedAt).toLocaleString("fr-FR")} — {e.error}</li>)}</ul>}
      </section>
      <section><h2 className="mb-2 text-sm font-semibold">Coûts par action</h2>
        <table className="w-full text-sm"><thead className="text-left text-xs text-muted"><tr><th className="py-1">Action</th><th>Coût</th><th>Tokens in</th><th>Tokens out</th></tr></thead><tbody>{s.costByAction.map((c: any) => <tr key={c._id} className="border-t border-line"><td className="py-1">{c._id}</td><td>{usd(c.usd)}</td><td>{c.tin}</td><td>{c.tout}</td></tr>)}</tbody></table>
        {!s.costByAction.length && <p className="text-sm text-muted">Aucun coût enregistré pour l'instant.</p>}
      </section>
    </div>
  );
}

function Users({ plans, flash, setErr }: { plans: string[]; flash: (m: string) => void; setErr: (m: string) => void }) {
  const [q, setQ] = useState(""), [rows, setRows] = useState<any[] | null>(null);
  const load = useCallback(() => api(`admin/users?q=${encodeURIComponent(q)}`).then((r) => setRows(r.items)).catch((e) => setErr(e.message)), [q, setErr]);
  useEffect(() => { const id = setTimeout(load, 250); return () => clearTimeout(id); }, [load]);
  const patch = async (id: string, body: object, msg: string) => { try { await api(`admin/users/${id}`, "PATCH", body); flash(msg); void load(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="mt-6">
      <input className="field !w-72" placeholder="Rechercher (email, nom)" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[900px] text-sm">
        <thead className="text-left text-xs text-muted"><tr><th className="py-1">Utilisateur</th><th>Offre</th><th>Crédits</th><th>Stockage</th><th>Tokens</th><th>Coût</th><th>Payé</th><th>Marge</th><th /></tr></thead>
        <tbody>{rows?.map((u) => (
          <tr key={u.id} className="border-t border-line align-top">
            <td className="py-2"><p className="font-medium">{u.name ?? "—"} {u.role === "admin" && <span className="chip">admin</span>} {u.suspended && <span className="chip text-bad">suspendu</span>}</p><p className="text-xs text-muted">{u.email}</p></td>
            <td><select className="field !w-auto !py-0.5" value={u.plan} onChange={(e) => patch(u.id, { plan: e.target.value }, "Offre modifiée.")}>{plans.map((p) => <option key={p}>{p}</option>)}</select></td>
            <td>{u.credits}</td><td>{(u.storageBytes / 1024 ** 3).toFixed(2)} Go</td><td className="font-mono text-xs">{u.tokensIn + u.tokensOut}</td><td>{usd(u.costUsd)}</td><td>{usd(u.paidUsd)}</td><td className={u.marginUsd < 0 ? "text-bad" : ""}>{usd(u.marginUsd)}</td>
            <td className="space-x-1 whitespace-nowrap text-right">
              <button className="btn !px-2 !py-0.5 text-xs" onClick={() => { const n = Number(prompt("Crédits à ajouter (négatif pour retirer) ?")); if (Number.isInteger(n) && n !== 0) void patch(u.id, { credits: n }, "Crédits mis à jour."); }}>± crédits</button>
              <button className="btn !px-2 !py-0.5 text-xs" onClick={() => patch(u.id, { suspended: !u.suspended }, u.suspended ? "Compte réactivé." : "Compte suspendu.")}>{u.suspended ? "Réactiver" : "Suspendre"}</button>
              <button className="btn !px-2 !py-0.5 text-xs" onClick={() => patch(u.id, { revokeSessions: true }, "Sessions révoquées.")}>Déconnecter</button>
              <button className="btn !px-2 !py-0.5 text-xs text-bad" onClick={() => { if (confirm(`Supprimer ${u.email} et toutes ses données ?`)) void patch(u.id, { delete: true }, "Compte supprimé."); }}>Supprimer</button>
            </td></tr>))}</tbody></table>
        {rows === null && <div className="skeleton mt-2 h-24" />}{rows?.length === 0 && <p className="mt-3 text-sm text-muted">Aucun utilisateur trouvé.</p>}</div>
    </div>
  );
}

function Pricing({ settings, flash, setErr, reload }: { settings: Settings; flash: (m: string) => void; setErr: (m: string) => void; reload: () => void }) {
  const [s, setS] = useState<Settings>(settings);
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const save = async () => { try { await api("admin/settings", "PATCH", { ai: { ...s.ai, fallbackModels: s.ai.fallbackModels.filter((m) => m.trim()) }, rates: s.rates, tokens: s.tokens, plans: s.plans, packs: s.packs, inactivityDays: s.inactivityDays }); flash("Tarifs enregistrés (actifs immédiatement)."); reload(); } catch (e) { setErr((e as Error).message); } };
  const F = ({ l, v, on, step = 1 }: { l: string; v: number; on: (n: number) => void; step?: number }) => <label className="block text-xs"><span className="mb-1 block text-muted">{l}</span><input type="number" step={step} min={0} className="field" value={v} onChange={(e) => on(num(e.target.value))} /></label>;
  return (
    <div className="mt-6 space-y-8">
      <section><h2 className="mb-1 text-sm font-semibold">Analyse IA : modèle et replis</h2>
        <p className="mb-3 text-xs text-muted">Si le modèle principal est surchargé (erreur 503/429), l'analyse peut être retentée automatiquement : 0 = jamais, jusqu'à 2 replis. Chaque repli utilise le modèle indiqué ci-dessous, ou retente le principal s'il est laissé vide. Les identifiants sont à relire dans la doc Gemini.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block text-xs sm:col-span-2"><span className="mb-1 block text-muted">Modèle principal</span><input className="field font-mono" value={s.ai.model} onChange={(e) => setS({ ...s, ai: { ...s.ai, model: e.target.value } })} /></label>
          <label className="block text-xs"><span className="mb-1 block text-muted">Nombre de replis (0 à 2)</span>
            <select className="field" value={s.ai.maxFallbacks} onChange={(e) => setS({ ...s, ai: { ...s.ai, maxFallbacks: Number(e.target.value) } })}><option value={0}>0 : aucun repli</option><option value={1}>1 repli</option><option value={2}>2 replis</option></select></label>
          <F l="Délai entre essais (ms)" v={s.ai.retryDelayMs} on={(n) => setS({ ...s, ai: { ...s.ai, retryDelayMs: Math.min(15000, n) } })} />
          {[0, 1].map((i) => <label key={i} className={`block text-xs sm:col-span-2 ${s.ai.maxFallbacks > i ? "" : "opacity-40"}`}><span className="mb-1 block text-muted">Modèle du repli {i + 1}</span>
            <input className="field font-mono" placeholder="vide = retenter le principal" disabled={s.ai.maxFallbacks <= i} value={s.ai.fallbackModels[i] ?? ""} onChange={(e) => { const m = [...s.ai.fallbackModels]; m[i] = e.target.value; setS({ ...s, ai: { ...s.ai, fallbackModels: m } }); }} /></label>)}
        </div></section>
      <section><h2 className="mb-3 text-sm font-semibold">Tarifs en crédits</h2><div className="grid gap-3 sm:grid-cols-3">
        <F l="Analyse par minute de vidéo" v={s.rates.analysisPerMinute} on={(n) => setS({ ...s, rates: { ...s.rates, analysisPerMinute: n } })} />
        <F l="Génération (phase 2)" v={s.rates.generation} on={(n) => setS({ ...s, rates: { ...s.rates, generation: n } })} />
        <F l="Stockage par Go et par mois" v={s.rates.storagePerGBMonth} on={(n) => setS({ ...s, rates: { ...s.rates, storagePerGBMonth: n } })} /></div></section>
      <section><h2 className="mb-1 text-sm font-semibold">Coûts réels (pour calculer la marge)</h2><p className="mb-3 text-xs text-muted">À relire dans la grille tarifaire officielle de Gemini et de Cloudflare R2 avant de fixer vos prix.</p><div className="grid gap-3 sm:grid-cols-4">
        <F l="$ / million de tokens entrée" step={0.01} v={s.tokens.usdPerMTokIn} on={(n) => setS({ ...s, tokens: { ...s.tokens, usdPerMTokIn: n } })} />
        <F l="$ / million de tokens sortie" step={0.01} v={s.tokens.usdPerMTokOut} on={(n) => setS({ ...s, tokens: { ...s.tokens, usdPerMTokOut: n } })} />
        <F l="$ / Go / mois (stockage)" step={0.001} v={s.tokens.usdPerGBMonth} on={(n) => setS({ ...s, tokens: { ...s.tokens, usdPerGBMonth: n } })} />
        <F l="Valeur d'un crédit en $" step={0.001} v={s.tokens.usdPerCredit} on={(n) => setS({ ...s, tokens: { ...s.tokens, usdPerCredit: n } })} /></div></section>
      <section><h2 className="mb-3 text-sm font-semibold">Quotas par offre</h2>
        {Object.entries(s.plans).map(([k, p]) => <div key={k} className="mb-3 grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-5"><p className="self-end font-medium capitalize">{k}</p>
          <F l="Stockage (Go)" v={p.storageGB} on={(n) => setS({ ...s, plans: { ...s.plans, [k]: { ...p, storageGB: n } } })} /><F l="Analyses / jour" v={p.dailyAnalyses} on={(n) => setS({ ...s, plans: { ...s.plans, [k]: { ...p, dailyAnalyses: n } } })} />
          <F l="Durée max d'analyse (min)" v={p.maxProxyMinutes} on={(n) => setS({ ...s, plans: { ...s.plans, [k]: { ...p, maxProxyMinutes: Math.max(1, n) } } })} /><F l="Crédits d'inscription" v={p.signupCredits} on={(n) => setS({ ...s, plans: { ...s.plans, [k]: { ...p, signupCredits: n } } })} />
          <label className="flex items-center gap-2 text-xs sm:col-span-5"><input type="checkbox" checked={p.watermark} onChange={(e) => setS({ ...s, plans: { ...s.plans, [k]: { ...p, watermark: e.target.checked } } })} />Filigrane sur l'export</label></div>)}
        <F l="Purge des rushs après (jours d'inactivité)" v={s.inactivityDays} on={(n) => setS({ ...s, inactivityDays: Math.max(1, n) })} /></section>
      <section><h2 className="mb-3 text-sm font-semibold">Packs de crédits</h2>{s.packs.map((p, i) => <div key={p.id} className="mb-2 grid grid-cols-3 gap-3"><p className="self-end text-sm">{p.label}</p><F l="Crédits" v={p.credits} on={(n) => setS({ ...s, packs: s.packs.map((x, j) => (j === i ? { ...x, credits: Math.max(1, n) } : x)) })} /><F l={`Prix (${p.currency})`} v={p.price} step={0.5} on={(n) => setS({ ...s, packs: s.packs.map((x, j) => (j === i ? { ...x, price: n } : x)) })} /></div>)}</section>
      <button className="btn btn-primary" onClick={save}>Enregistrer</button>
    </div>
  );
}

function Effects({ s, flash, setErr, reload }: { s: any; flash: (m: string) => void; setErr: (m: string) => void; reload: () => void }) {
  const toggle = async (id: string, enabled: boolean) => {
    const disabled: string[] = enabled ? [...s.settings.disabledEffects, id] : s.settings.disabledEffects.filter((x: string) => x !== id);
    try { await api("admin/settings", "PATCH", { disabledEffects: disabled }); flash(enabled ? "Effet désactivé : retiré du catalogue IA et de l'éditeur." : "Effet réactivé."); reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="mt-6">
      <p className="mb-3 text-sm text-muted">Catalogue envoyé à l'IA : <b className="text-ink">{s.catalogTokens} tokens</b>. Désactiver un effet bancal le retire du prompt dès la requête suivante, sans redéploiement. Les projets qui l'utilisent l'ignorent avec un avertissement.</p>
      <ul className="divide-y divide-line">{s.effects.map((e: any) => (
        <li key={e.id} className="flex items-center gap-3 py-2.5 text-sm">
          <input type="checkbox" role="switch" aria-label={`Activer ${e.id}`} checked={e.enabled} onChange={() => toggle(e.id, e.enabled)} className="h-4 w-4" />
          <div className="min-w-0 flex-1"><p className="font-mono text-xs">{e.id} <span className="chip ml-1">{e.kind}</span> {e.status === "deprecated" && <span className="chip text-warn">déprécié</span>} {e.cost === "heavy" && <span className="chip">lourd</span>}</p><p className="truncate text-xs text-muted" title={e.describe}>{e.describe}</p></div>
        </li>))}</ul>
    </div>
  );
}

function Jobs({ flash, setErr }: { flash: (m: string) => void; setErr: (m: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const load = useCallback(() => api("admin/jobs").then((r) => setRows(r.items)).catch((e) => setErr(e.message)), [setErr]);
  useEffect(() => { void load(); }, [load]);
  const retry = async (id: string) => { try { await api(`admin/jobs/${id}/retry`, "POST", {}); flash("Job relancé."); void load(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="mt-6 overflow-x-auto"><button className="btn mb-3 !py-1" onClick={load}>Actualiser</button>
      <table className="w-full min-w-[800px] text-sm"><thead className="text-left text-xs text-muted"><tr><th className="py-1">Date</th><th>Utilisateur</th><th>Statut</th><th>Coût</th><th>Message</th><th /></tr></thead>
        <tbody>{rows?.map((j) => <tr key={j.id} className="border-t border-line"><td className="py-1.5 text-xs">{new Date(j.createdAt).toLocaleString("fr-FR")}</td><td>{j.user}</td><td className={j.status === "failed" ? "text-bad" : j.status === "done" ? "text-ok" : ""}>{j.status}{j.fallback ? " (repli)" : ""}</td><td>{usd(j.costUsd ?? 0)}</td><td className="max-w-xs truncate text-xs text-muted" title={j.error ?? j.message}>{j.error ?? j.message}</td><td>{j.status === "failed" && <button className="btn !px-2 !py-0.5 text-xs" onClick={() => retry(j.id)}>Relancer</button>}</td></tr>)}</tbody></table>
      {rows === null && <div className="skeleton h-24" />}{rows?.length === 0 && <p className="text-sm text-muted">Aucun job.</p>}
    </div>
  );
}
