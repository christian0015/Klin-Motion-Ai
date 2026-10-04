//src/components/Dashboard.tsx
/**
 * Dashboard.tsx — profil, crédits et consommation, stockage, liste des projets (création/suppression), suppression de compte.
 * Contient : <Dashboard/> (client, données via /api/me et /api/projects), états de chargement, d'erreur et vides.
 * Ne contient PAS : logique de crédits (billing.ts) ni accès base. La page serveur dashboard/page.tsx garde l'accès.
 */
"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { ApiError, api } from "@/lib/media";

interface Me { id: string; name?: string; email?: string; image?: string; plan: string; role: string; credits: number; storageBytes: number; prefs: { platform?: string; lang?: string };
  limits: { storageGB: number; dailyAnalyses: number; analysesToday: number; watermark: boolean }; packs: { id: string; label: string; credits: number; price: number; currency: string }[];
  rates: { analysisPerMinute: number }; ledger: { id: string; kind: string; action: string; credits: number; costUsd?: number; tokensIn?: number; tokensOut?: number; bytes?: number; ts: string }[] }
interface Proj { id: string; name: string; updatedAt: string; thumb?: string; brief: { platform: string } }

const ACTIONS: Record<string, string> = { signup: "Crédits de bienvenue", analysis_reserve: "Analyse IA (réservation)", analysis: "Analyse IA (coût réel)", analysis_refund: "Remboursement d'analyse", analysis_settle: "Ajustement d'analyse", analysis_failed: "Analyse échouée", storage: "Stockage", egress: "Téléchargement", purchase: "Achat de crédits", admin_grant: "Crédits offerts", admin_remove: "Crédits retirés" };

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null), [projects, setProjects] = useState<Proj[] | null>(null), [err, setErr] = useState(""), [msg, setMsg] = useState("");
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [more, setMore] = useState(false), [page, setPage] = useState(0);
  const load = useCallback(async () => {
    setErr("");
    try { const [m, p] = await Promise.all([api<Me>("me"), api("projects?page=0")]); setMe(m); setProjects(p.items); setMore(p.more); setPage(0); }
    catch (e) { if (e instanceof ApiError && e.status === 401) router.replace("/"); else setErr(e instanceof ApiError && e.status === 429 ? `Trop de requêtes, réessayez dans ${e.retryAfter || 30} s.` : (e as Error).message); }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  const create = async (example = false) => {
    setBusy(true);
    try { const r = await api("projects", "POST", { name: name.trim() || (example ? "Projet d'exemple" : "Nouveau projet"), brief: { platform: (me?.prefs.platform as any) ?? "tiktok", lang: me?.prefs.lang }, example }); router.push(`/editor/${r.id}`); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const remove = async (p: Proj) => { if (!confirm(`Supprimer « ${p.name} » et ses fichiers ? Cette action est définitive.`)) return; try { await api(`projects/${p.id}`, "DELETE"); setProjects((l) => l?.filter((x) => x.id !== p.id) ?? null); } catch (e) { setErr((e as Error).message); } };
  const savePrefs = async (patch: object) => { try { await api("me", "PATCH", patch); setMsg("Préférences enregistrées."); void load(); } catch (e) { setErr((e as Error).message); } };
  const buy = async (packId: string) => { try { await api("billing/checkout", "POST", { packId }); setMsg("Le paiement en ligne n'est pas encore ouvert : écrivez-nous avec le pack souhaité et nous créditons votre compte."); } catch (e) { setErr((e as Error).message); } };
  const deleteAccount = async () => { if (prompt("Cette action supprime votre compte, vos projets et vos fichiers. Tapez SUPPRIMER pour confirmer.") !== "SUPPRIMER") return; try { await api("me", "DELETE"); location.href = "/"; } catch (e) { setErr((e as Error).message); } };
  const loadMore = async () => { const r = await api(`projects?page=${page + 1}`); setProjects((l) => [...(l ?? []), ...r.items]); setMore(r.more); setPage(page + 1); };

  const gb = (b: number) => (b / 1024 ** 3).toFixed(2);
  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-6">
      <header className="flex items-center justify-between gap-3">
        <Link href="/" className="font-display text-4xl">MotionIA</Link>
        <div className="flex items-center gap-3 text-sm">
          {me?.role === "admin" && <Link className="btn !py-1" href="/admin">Admin</Link>}
          {me?.image && /* eslint-disable-next-line @next/next/no-img-element */ <img src={me.image} alt="" width={32} height={32} className="rounded-full" referrerPolicy="no-referrer" />}
          <button className="btn !py-1" onClick={() => void signOut({ callbackUrl: "/" })}>Se déconnecter</button>
        </div>
      </header>

      {err && <div role="alert" className="mt-4 flex items-center justify-between rounded-lg border border-bad/40 bg-bad/10 px-4 py-2 text-sm text-bad">{err}<button className="btn !py-0.5" onClick={() => void load()}>Réessayer</button></div>}
      {msg && <div role="status" className="mt-4 rounded-lg border border-ok/40 bg-ok/10 px-4 py-2 text-sm text-ok">{msg}</div>}

      <h1 className="mt-10 font-display text-6xl leading-none">Vos projets</h1>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <input className="field !w-64" placeholder="Nom du nouveau projet" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
        <button className="btn btn-primary" onClick={() => create()} disabled={busy}>Créer un projet</button>
        <button className="btn" onClick={() => create(true)} disabled={busy}>Essayer avec un exemple</button>
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects === null && !err && [0, 1, 2].map((i) => <div key={i} className="skeleton h-40" />)}
        {projects?.length === 0 && <p className="col-span-full panel p-8 text-center font-display text-3xl text-muted">Aucun projet pour l'instant. Créez le premier : déposez vos rushs, l'IA s'occupe du montage.</p>}
        {projects?.map((p) => (
          <article key={p.id} className="panel group overflow-hidden">
            <Link href={`/editor/${p.id}`} className="block">
              <div className="grid h-28 place-items-center bg-raised">{p.thumb ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={p.thumb} alt="" className="h-full w-full object-cover" /> : <span className="font-display text-4xl text-muted">{p.name.slice(0, 1)}</span>}</div>
              <div className="p-3"><h2 className="truncate font-medium">{p.name}</h2><p className="text-xs text-muted">{p.brief?.platform} · modifié le {new Date(p.updatedAt).toLocaleDateString("fr-FR")}</p></div>
            </Link>
            <div className="flex justify-end border-t border-line px-2 py-1"><button className="btn btn-ghost !py-0.5 text-xs text-muted hover:text-bad" onClick={() => remove(p)}>Supprimer</button></div>
          </article>
        ))}
      </div>
      {more && <button className="btn mt-4" onClick={loadMore}>Voir plus</button>}

      <div className="mt-16 grid gap-6 lg:grid-cols-[1.2fr_1fr]" id="credits">
        <section className="panel p-5">
          <h2 className="font-display text-4xl">Crédits et consommation</h2>
          {!me ? <div className="skeleton mt-4 h-24" /> : (
            <>
              <p className="mt-3 text-4xl font-semibold">{me.credits} <span className="text-base font-normal text-muted">crédits</span></p>
              <p className="mt-1 text-sm text-muted">Une analyse coûte environ {me.rates.analysisPerMinute} crédits par minute de rushs. Les crédits non utilisés d'une analyse échouée sont remboursés.</p>
              <div className="mt-4 flex flex-wrap gap-2">{me.packs.map((p) => <button key={p.id} className="btn" onClick={() => buy(p.id)}>{p.label} · {p.price} {p.currency}</button>)}</div>
              <h3 className="mt-6 text-sm font-semibold">Historique</h3>
              <ul className="mt-2 divide-y divide-line text-sm">
                {me.ledger.filter((l) => l.credits !== 0 || l.action === "analysis").slice(0, 12).map((l) => (
                  <li key={l.id} className="flex items-center justify-between py-1.5"><span>{ACTIONS[l.action] ?? l.action}<span className="ml-2 text-xs text-muted">{new Date(l.ts).toLocaleDateString("fr-FR")}{l.tokensIn ? ` · ${l.tokensIn + (l.tokensOut ?? 0)} tokens` : ""}</span></span>
                    <span className={l.kind === "spend" ? "text-bad" : "text-ok"}>{l.credits ? `${l.kind === "spend" ? "−" : "+"}${l.credits}` : ""}</span></li>
                ))}
                {me.ledger.length === 0 && <li className="py-2 text-muted">Aucun mouvement.</li>}
              </ul>
            </>
          )}
        </section>
        <section className="panel space-y-4 p-5">
          <h2 className="font-display text-4xl">Profil</h2>
          {!me ? <div className="skeleton h-40" /> : (
            <>
              <label className="block text-sm"><span className="mb-1 block text-muted">Nom affiché</span><input className="field" defaultValue={me.name} maxLength={80} onBlur={(e) => e.target.value && e.target.value !== me.name && savePrefs({ name: e.target.value })} /></label>
              <label className="block text-sm"><span className="mb-1 block text-muted">Plateforme par défaut</span>
                <select className="field" value={me.prefs.platform ?? "tiktok"} onChange={(e) => savePrefs({ prefs: { platform: e.target.value } })}><option value="tiktok">TikTok</option><option value="reels">Reels</option><option value="shorts">Shorts</option><option value="other">Autre</option></select></label>
              <label className="block text-sm"><span className="mb-1 block text-muted">Langue parlée par défaut</span><input className="field" defaultValue={me.prefs.lang ?? ""} maxLength={12} placeholder="fr, en, ar…" onBlur={(e) => e.target.value !== (me.prefs.lang ?? "") && savePrefs({ prefs: { lang: e.target.value } })} /></label>
              <dl className="grid grid-cols-2 gap-2 text-sm"><dt className="text-muted">Offre</dt><dd className="text-right capitalize">{me.plan}</dd><dt className="text-muted">Stockage</dt><dd className="text-right">{gb(me.storageBytes)} / {me.limits.storageGB} Go</dd><dt className="text-muted">Analyses aujourd'hui</dt><dd className="text-right">{me.limits.analysesToday} / {me.limits.dailyAnalyses}</dd><dt className="text-muted">Export</dt><dd className="text-right">{me.limits.watermark ? "avec filigrane" : "sans filigrane"}</dd></dl>
              <div className="flex items-center justify-between border-t border-line pt-4 text-sm"><Link href="/legal" className="text-muted underline">Confidentialité et conditions</Link><button className="btn text-bad" onClick={deleteAccount}>Supprimer mon compte</button></div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
