//src/app/api/auth/[...nextauth]/route.ts
/** Handlers Auth.js + limiteur : 30 req/min/IP, blocage 2 min après 5 échecs de connexion en 5 min par IP. */
import { handlers } from "@/auth";
import { blockFor, clientIp, connect, hit, isBlocked } from "@/lib/db";

async function guarded(req: Request, run: (r: Request) => Promise<Response>): Promise<Response> {
  const ip = clientIp(req.headers);
  try {
    await connect();
    const wait = await isBlocked(`login:${ip}`);
    if (wait) return new Response("Trop d'échecs de connexion. Réessayez dans quelques minutes.", { status: 429, headers: { "Retry-After": String(wait) } });
    const r = await hit(`auth:${ip}`, 30, 60);
    if (!r.ok) return new Response("Trop de requêtes.", { status: 429, headers: { "Retry-After": String(r.retryAfter) } });
  } catch { /* base indisponible : Auth.js gérera l'erreur */ }
  const res = await run(req);
  try {
    const failed = new URL(req.url).pathname.includes("/callback/") && /[?&]error=/.test(res.headers.get("location") ?? "");
    if (failed) { const f = await hit(`loginfail:${ip}`, 5, 300); if (!f.ok) await blockFor(`login:${ip}`, 120); }
  } catch { /* ignore */ }
  return res;
}
export const GET = (req: Request) => guarded(req, handlers.GET as any);
export const POST = (req: Request) => guarded(req, handlers.POST as any);
