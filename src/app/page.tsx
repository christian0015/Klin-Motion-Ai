//src/app/page.tsx
/**
 * page.tsx — Landing : promesse, démo (placeholder), « comment ça marche » en 3 étapes, offre gratuite, tarifs en crédits,
 *            bouton Google, liens légaux. Mobile d'abord.
 * Les couleurs et polices viennent de globals.css (jetons @theme) ; rien n'est codé en dur ici.
 * Le moment mémorable : le titre arrive en aberration chromatique (classe .chroma) puis se recolle.
 */
import Link from "next/link";
import { signIn } from "@/auth";
import { requireUser } from "@/auth";
import { getSettings } from "@/lib/db";
import { DEFAULT_SETTINGS } from "@/lib/schema";

export const dynamic = "force-dynamic";

async function login() { "use server"; await signIn("google", { redirectTo: "/dashboard" }); }

export default async function Landing() {
  const user = await requireUser().catch(() => null);
  const s = await getSettings().catch(() => DEFAULT_SETTINGS);
  const free = s.plans.free?.signupCredits ?? 0;
  const Cta = ({ label = "Continuer avec Google" }: { label?: string }) => user
    ? <Link href="/dashboard" className="btn btn-primary !px-6 !py-3 !text-base">Ouvrir mes projets</Link>
    : <form action={login}><button type="submit" className="btn btn-primary !px-6 !py-3 !text-base"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden><path fill="#14060b" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.8 1.1 8 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z" /></svg>{label}</button></form>;

  return (
    <div className="stage-glow">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <span className="font-display text-4xl leading-none">MotionIA</span>
        <nav className="flex items-center gap-4 text-sm text-muted"><a href="#tarifs" className="hover:text-ink">Tarifs</a><Link href="/legal" className="hover:text-ink">Confidentialité</Link>{user && <Link href="/dashboard" className="btn !py-1.5">Mes projets</Link>}</nav>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-24 pt-10 lg:grid-cols-[1.25fr_1fr] lg:pt-20">
        <div>
          <h1 className="chroma font-display text-[clamp(3.6rem,11vw,8.2rem)] leading-[0.9]">Déposez vos rushs, récupérez un film.</h1>
          <p className="mt-8 max-w-xl text-lg leading-relaxed text-muted">Vous parlez à la caméra, vous décrivez ce que vous voulez : l'IA coupe, sous-titre et habille le montage avec un look cinéma. Vous retouchez ensuite chaque détail, directement dans l'éditeur.</p>
          <div className="mt-9 flex flex-wrap items-center gap-4"><Cta /><span className="text-sm text-muted">{free > 0 ? `${free} crédits offerts pour essayer, sans carte bancaire.` : "Connexion en un clic avec Google."}</span></div>
        </div>
        {/* démo : placeholder à remplacer par une vraie capture / vidéo */}
        <div aria-hidden className="mx-auto w-full max-w-[22rem]">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[1.6rem] border border-line bg-[linear-gradient(160deg,#2a1d3a,#0f1a2b_55%,#3a1d2c)] shadow-[0_30px_80px_-20px_rgba(255,79,123,.35)]">
            <div className="absolute inset-0 opacity-70" style={{ background: "radial-gradient(circle at 50% 35%, rgba(255,216,160,.55), transparent 45%)" }} />
            <div className="absolute inset-x-5 bottom-[26%] text-center text-[1.7rem] font-extrabold leading-tight tracking-tight [text-shadow:0_2px_0_rgba(0,0,0,.7)]">Voici <span className="text-[#ffd84d]">pourquoi</span> ça marche</div>
            <div className="absolute inset-3 rounded-[1.2rem] border-2 border-accent-2/70 shadow-[0_0_24px_rgba(66,227,255,.45),inset_0_0_24px_rgba(66,227,255,.25)]" />
          </div>
          <div className="mt-3 space-y-1.5">
            {[["bg-k-video", "w-[92%]"], ["bg-k-text", "ml-[18%] w-[22%]"], ["bg-k-caption", "w-[88%]"], ["bg-k-audio", "ml-[6%] w-[60%]"]].map(([c, w], i) => <div key={i} className="h-2.5 rounded-sm bg-raised"><div className={`h-full rounded-sm ${c} ${w}`} /></div>)}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-20">
        <h2 className="font-display text-6xl leading-none">Du rush au montage en trois temps</h2>
        <ol className="mt-12 grid gap-10 md:grid-cols-3">
          {[["1", "Déposez vos vidéos", "Vos fichiers restent sur votre appareil pour éditer vite. Une copie part en arrière-plan dans votre espace privé."], ["2", "Dites ce que vous voulez", "Une phrase suffit : « montage punchy, sous-titres jaunes, ambiance cinéma ». L'IA transcrit, coupe et choisit les effets."], ["3", "Retouchez et exportez", "Chaque coupe, chaque mot, chaque effet se règle à la main. L'export MP4 se fait dans votre navigateur."]].map(([n, t, d]) => (
            <li key={n}><p className="font-display text-5xl text-accent">{n}</p><h3 className="mt-2 text-lg font-semibold">{t}</h3><p className="mt-2 leading-relaxed text-muted">{d}</p></li>))}
        </ol>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.2fr]">
          <h2 className="font-display text-6xl leading-none">Pensé pour ceux qui parlent à la caméra</h2>
          <ul className="space-y-4 text-lg leading-relaxed">
            {["Sous-titres mot à mot, corrigeables au clavier", "Cuts sur les silences et les hésitations", "Effets, déformations et overlays qui se mettent à jour sans que vous fassiez rien", "Comparaison avant / après et historique complet : vous ne perdez jamais une version", "Vos rushs ne quittent pas votre appareil pour être montés : rendu et export côté navigateur"].map((t) => <li key={t} className="border-b border-line pb-4 text-ink/90">{t}</li>)}
          </ul>
        </div>
      </section>

      <section id="tarifs" className="mx-auto max-w-6xl px-5 py-20">
        <h2 className="font-display text-6xl leading-none">Payez seulement ce que vous analysez</h2>
        <p className="mt-4 max-w-2xl text-muted">Le montage, la retouche et l'export sont gratuits. Seule l'analyse par l'IA consomme des crédits : environ {s.rates.analysisPerMinute} par minute de rushs, remboursés si elle échoue.</p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="panel p-5"><p className="text-sm text-muted">Offre gratuite</p><p className="mt-2 text-3xl font-semibold">{free} crédits</p><p className="mt-2 text-sm text-muted">{s.plans.free?.storageGB} Go de stockage, export avec filigrane.</p></div>
          {s.packs.map((p) => <div key={p.id} className="panel p-5"><p className="text-sm text-muted">{p.label}</p><p className="mt-2 text-3xl font-semibold">{p.price} {p.currency}</p><p className="mt-2 text-sm text-muted">{(p.price / p.credits * 100).toFixed(1)} {p.currency} les 100 crédits.</p></div>)}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-28 pt-8 text-center">
        <p className="font-display text-7xl leading-none">À vous de jouer.</p>
        <div className="mt-8 flex justify-center"><Cta label="Commencer gratuitement" /></div>
      </section>

      <footer className="border-t border-line px-5 py-8 text-sm text-muted"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3"><span>© {new Date().getFullYear()} MotionIA</span><nav className="flex gap-5"><Link href="/legal#confidentialite" className="hover:text-ink">Confidentialité</Link><Link href="/legal#conditions" className="hover:text-ink">Conditions</Link><Link href="/legal#remboursements" className="hover:text-ink">Remboursements</Link></nav></div></footer>
    </div>
  );
}
