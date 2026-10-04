//src/auth.ts
/**
 * auth.ts — configuration Auth.js (Google, sessions JWT 7 j, révocation par sessionVersion).
 * Contient : handlers/signIn/signOut, requireUser (session + suspended + sessionVersion, cache 60 s),
 *            requireAdmin (rôle relu en base à chaque appel, jamais depuis le jeton).
 * Ne contient PAS : routes API (api/[[...path]]), logique de crédits.
 * Le JWT ne contient que userId et sessionVersion. Cookies : réglages Auth.js par défaut (httpOnly, Secure, SameSite=Lax).
 */
import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import { ObjectId } from "mongodb";
import { connect, nativeClient, getSettings, User, logEvent } from "@/lib/db";

declare module "next-auth" { interface Session { user: { id: string; sv: number } & DefaultSession["user"] } }
declare module "@auth/core/jwt" { interface JWT { uid?: string; sv?: number } }

const admins = () => (process.env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  adapter: MongoDBAdapter(nativeClient() as any),
  providers: [Google],
  session: { strategy: "jwt" as const, maxAge: 7 * 24 * 3600, updateAge: 24 * 3600 },
  trustHost: true,
  pages: { signIn: "/", error: "/" },
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        await connect();
        const u = await User.findById(user.id).select("sessionVersion").lean();
        token.uid = user.id; token.sv = u?.sessionVersion ?? 0;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.uid ?? ""; session.user.sv = token.sv ?? 0;
      return session;
    },
  },
  events: {
    // Rôle et crédits de bienvenue posés à l'inscription
    async createUser({ user }) {
      await connect();
      const s = await getSettings();
      const isAdmin = admins().includes((user.email ?? "").toLowerCase());
      const credits = s.plans.free?.signupCredits ?? 0;
      await User.updateOne({ _id: new ObjectId(user.id) }, { $set: { role: isAdmin ? "admin" : "user", plan: "free", credits, storageBytes: 0, suspended: false, sessionVersion: 0, prefs: {}, createdAt: new Date() } });
      if (credits) await (await import("@/lib/db")).Ledger.create({ userId: user.id, kind: "grant", action: "signup", credits });
      await logEvent(user.id, "signup");
    },
    // Promotion si l'email a été ajouté à ADMIN_EMAILS après l'inscription
    async signIn({ user }) {
      if (user?.id && admins().includes((user.email ?? "").toLowerCase())) { await connect(); await User.updateOne({ _id: new ObjectId(user.id) }, { $set: { role: "admin" } }); }
      if (user?.id) await User.updateOne({ _id: new ObjectId(user.id) }, { $set: { lastActiveAt: new Date() } });
    },
  },
}));

export interface SessionUser { id: string; email?: string | null; name?: string | null; image?: string | null }
const flagCache = new Map<string, { at: number; sv: number; suspended: boolean }>();

/** Utilisateur connecté et valide, ou null. Vérifie suspended + sessionVersion (cache 60 s). */
export async function requireUser(): Promise<SessionUser | null> {
  const s = await auth();
  const id = s?.user?.id;
  if (!id) return null;
  let f = flagCache.get(id);
  if (!f || Date.now() - f.at > 60_000) {
    await connect();
    const u = await User.findById(id).select("sessionVersion suspended").lean();
    if (!u) return null;
    f = { at: Date.now(), sv: u.sessionVersion ?? 0, suspended: !!u.suspended };
    flagCache.set(id, f);
  }
  if (f.suspended || f.sv !== s!.user.sv) return null;
  return { id, email: s!.user.email, name: s!.user.name, image: s!.user.image };
}
/** Admin : le rôle est TOUJOURS relu en base (jamais lu depuis le jeton). */
export async function requireAdmin(): Promise<SessionUser | null> {
  const u = await requireUser();
  if (!u) return null;
  const row = await User.findById(u.id).select("role").lean();
  return row?.role === "admin" ? u : null;
}
export const invalidateFlags = (id: string) => flagCache.delete(id);
