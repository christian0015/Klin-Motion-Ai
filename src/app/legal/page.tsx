//src/app/legal/page.tsx
/**
 * legal/page.tsx — confidentialité + conditions + remboursements (une page). Indispensable pour l'écran de consentement Google
 * et pour vendre des crédits. ⚠ Texte de départ : à faire relire et à compléter (éditeur, adresse, contact, droit applicable).
 */
import Link from "next/link";

export const metadata = { title: "Confidentialité, conditions et remboursements" };

const H = ({ id, children }: { id: string; children: React.ReactNode }) => <h2 id={id} className="mt-14 scroll-mt-8 font-display text-5xl leading-none">{children}</h2>;

export default function Legal() {
  return (
    <main className="mx-auto max-w-2xl px-5 pb-24 pt-8 leading-relaxed [&_p]:mt-4 [&_p]:text-ink/85 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ul]:text-ink/85">
      <Link href="/" className="font-display text-4xl">MotionIA</Link>
      <h1 className="mt-10 font-display text-7xl leading-none">Vos données, nos règles</h1>
      <p className="text-sm text-muted">Dernière mise à jour : octobre 2026. [À compléter : raison sociale, adresse, e-mail de contact.]</p>

      <H id="confidentialite">Confidentialité</H>
      <p>Nous collectons le strict nécessaire : votre nom, votre adresse e-mail et votre photo de profil fournis par Google à la connexion, vos projets, et des mesures d'usage (projets créés, analyses, exports) pour améliorer le produit. Nous ne stockons aucun mot de passe.</p>
      <p><b>Vos vidéos.</b> L'édition, la prévisualisation et l'export se font dans votre navigateur, à partir des fichiers de votre appareil. Une copie de sauvegarde est envoyée dans un espace de stockage privé qui vous est réservé, accessible uniquement par des liens temporaires.</p>
      <p><b>Analyse par l'IA.</b> Pour monter vos vidéos, nous envoyons une version réduite (basse résolution, son conservé) de vos rushs, ainsi que votre texte de brief, à un prestataire tiers : Google (API Gemini). Vos originaux ne sont jamais envoyés à ce prestataire. Consultez sa politique de confidentialité pour la durée de conservation de son côté.</p>
      <ul><li>Durée de conservation : vos rushs sont supprimés après une période d'inactivité prolongée (60 jours par défaut, indiquée dans votre compte).</li><li>Suppression : depuis votre tableau de bord, « Supprimer mon compte » efface votre compte, vos projets, vos versions et vos fichiers stockés.</li><li>Vos droits : accès, rectification, suppression et portabilité sur simple demande à l'adresse de contact.</li></ul>

      <H id="conditions">Conditions d'utilisation</H>
      <p>Vous restez propriétaire de vos contenus et garantissez avoir les droits sur les vidéos, sons et textes que vous importez. Vous ne devez pas importer de contenu illicite. Nous pouvons suspendre un compte en cas d'abus (fraude, contenu illégal, usage excessif du service).</p>
      <p>Le montage proposé par l'IA est une base de travail : vous êtes responsable du résultat que vous publiez. Le service est fourni « en l'état » ; nous mettons tout en œuvre pour sa disponibilité sans pouvoir la garantir.</p>
      <p>Les crédits servent à payer l'analyse par l'IA. Ils n'ont pas de valeur monétaire, ne sont pas transférables et ne sont pas échangeables contre de l'argent.</p>

      <H id="remboursements">Remboursements</H>
      <ul><li>Une analyse qui échoue est remboursée automatiquement en crédits.</li><li>Les crédits achetés et non utilisés peuvent être remboursés sur demande dans les 14 jours suivant l'achat.</li><li>Les crédits déjà consommés par une analyse réussie ne sont pas remboursables.</li></ul>
      <p className="mt-10"><Link href="/" className="text-muted underline">Retour à l'accueil</Link></p>
    </main>
  );
}
