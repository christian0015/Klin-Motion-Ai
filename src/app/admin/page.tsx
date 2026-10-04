//src/app/admin/page.tsx
/** admin/page.tsx — espace admin : le rôle est relu en base côté serveur (jamais lu depuis le jeton). UI dans <Admin/>. */
import { notFound, redirect } from "next/navigation";
import { requireAdmin, requireUser } from "@/auth";
import Admin from "@/components/Admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Administration" };

export default async function Page() {
  const user = await requireUser().catch(() => null);
  if (!user) redirect("/");
  if (!(await requireAdmin().catch(() => null))) notFound();
  return <Admin />;
}
