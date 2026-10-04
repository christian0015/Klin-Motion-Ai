//src/app/editor/[id]/page.tsx
/** editor/[id]/page.tsx — charge le projet côté serveur (propriété vérifiée), migre le document, monte <Editor/>. */
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/auth";
import { Project, connect } from "@/lib/db";
import { migrate } from "@/lib/schema";
import Editor from "@/components/Editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Éditeur" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser().catch(() => null);
  if (!user) redirect("/");
  if (!/^[a-f0-9]{24}$/.test(id)) notFound();
  await connect();
  const p = await Project.findOne({ _id: id, ownerId: user.id }).lean();
  if (!p) notFound();
  let doc;
  try { doc = migrate(p.doc); } catch (e) {
    return (
      <main className="mx-auto max-w-xl px-5 py-24">
        <h1 className="font-display text-6xl leading-none">Projet illisible</h1>
        <p className="mt-6 text-muted">Ce projet existe mais son contenu ne respecte pas le format attendu. Rien n'a été supprimé.</p>
        <pre className="mt-4 overflow-x-auto rounded-lg border border-line bg-panel p-3 text-xs text-bad">{(e as Error).message.slice(0, 600)}</pre>
        <a href="/dashboard" className="btn mt-6">Retour à mes projets</a>
      </main>
    );
  }
  const initial = JSON.parse(JSON.stringify({ id: String(p._id), name: p.name, rev: p.rev ?? 0, brief: p.brief ?? { platform: "tiktok" }, doc }));
  return <Editor initial={initial} />;
}
