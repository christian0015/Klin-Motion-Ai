//src/app/dashboard/page.tsx
/** dashboard/page.tsx — page protégée côté serveur (pas de middleware) ; le contenu est dans <Dashboard/>. */
import { redirect } from "next/navigation";
import { requireUser } from "@/auth";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mes projets" };

export default async function Page() {
  const user = await requireUser().catch(() => null);
  if (!user) redirect("/");
  return <Dashboard />;
}
