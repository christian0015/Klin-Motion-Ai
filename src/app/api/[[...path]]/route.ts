//src/app/api/[[...path]]/route.ts
/**
 * route.ts — TOUTE l'API de MotionIA + garde-fous (guard : origine, JSON, taille, limiteur, auth, rôle).
 * Contient : table des routes, LIMITS, helpers R2 (URL signées, multipart), jobs d'analyse, admin, cron.
 * Ne contient PAS : logique de crédits (billing.ts), prompt/appel IA (gemini.ts), schémas (schema.ts).
 *
 * TABLE DES ROUTES (préfixe /api)
 *   GET    /me                          Profil, crédits, consommation, historique
 *   PATCH  /me                          Préférences { name?, prefs? }
 *   DELETE /me                          Supprime compte + R2 + toutes les données
 *   GET    /projects?page=              Liste (sans doc), 20 par page
 *   POST   /projects                    Crée { name, brief?, example? }
 *   GET    /projects/:id                Projet complet (ETag = rev)
 *   PATCH  /projects/:id                { rev, doc?|name?|brief?|thumb?, force? } → 409 si rev ≠
 *   DELETE /projects/:id
 *   DELETE /projects/:id/assets/:assetId  Supprime les fichiers cloud d'un rush (original + proxy) et libère le stockage
 *   GET    /projects/:id/versions       Métadonnées uniquement
 *   GET    /projects/:id/versions/:vid  Document d'une version (à la demande)
 *   POST   /projects/:id/versions       Version manuelle { label, doc }
 *   POST   /projects/:id/restore/:vid   Restaure (crée une nouvelle version, rien n'est écrasé)
 *   POST   /upload/sign                 { projectId, assetId, kind, action, size, type, ... } → URL signées (put|init|part|complete|done|get)
 *   POST   /analyze/estimate            { projectId } → { tokens, credits, minutes, balance }
 *   POST   /analyze                     { projectId } → { jobId }
 *   GET    /jobs/:id                    Statut, progression, versionId
 *   POST   /generate                    { projectId, kind: image|video, prompt, aspect, seconds? } → { jobId } (crédits réservés)
 *   POST   /events                      { type, projectId? } (export_done…)
 *   POST   /billing/checkout            { type: "pack"|"subscription", id } → { url } (respecte les interrupteurs de l'admin)
 *   POST   /billing/portal              → { url } portail client Polar (factures, résiliation)
 *   POST   /billing/webhook             Polar (signature vérifiée, idempotent)
 *   GET    /admin/stats | /admin/users | /admin/jobs        (admin)
 *   PATCH  /admin/users/:id             crédits, plan, suspension, rôle, révocation, suppression (admin)
 *   PATCH  /admin/settings              tarifs, quotas, effets désactivés (admin)
 *   POST   /admin/jobs/:id/retry        Relance (admin)
 *   POST   /cron/cleanup                Purge d'inactivité + envois orphelins (Bearer CRON_SECRET)
 */
import { after } from "next/server";
import { AwsClient } from "aws4fetch";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireAdmin, requireUser, invalidateFlags, type SessionUser } from "@/auth";
import {
  Job, Ledger, Project, Upload, User, Version, audit, clientIp, connect, getSettings, hit, logEvent,
  nativeClient, saveSettings,
} from "@/lib/db";
import { BillingError, applyBillingEvent, cancelAllRenewals, estimateAnalysis, getProvider, grant, mongoBillingStore, planOf, recordStorage, refund, reserve, resolveCheckout, settle, storageOk } from "@/lib/billing";
import { ANALYSIS, GenError, callGemini, catalogTokens, fallbackDoc, friendlyError, generateImage, mergeAi, pollVideo, startVideo, type MediaInput } from "@/lib/gemini";
import { GenRequestS, checkGenRequest, genCostUsd } from "@/lib/generate";
import { nanoid } from "nanoid";
import { BriefS, CompositionS, EXAMPLE_DOC, migrate, type Composition, ProjectCreateS, ProjectPatchS, SettingsS, DOC_LIMITS, emptyComposition } from "@/lib/schema";
import { EFFECTS } from "@/effects";

export const maxDuration = 300;
export const runtime = "nodejs";

/** Médias réellement placés sur la timeline : vidéos et images (pistes vidéo), sons (pistes audio). Les autres ne sont ni analysés ni facturés. */
const usedAssets = (doc: Composition) => new Set(doc.tracks.flatMap((t) => (t.kind === "video" || t.kind === "audio" ? (t.clips as { asset: string }[]).map((c) => c.asset) : [])));

/** Valeurs de départ des limites (section 9.6). Format : [fenêtre en secondes, maximum]. */
const LIMITS = {
  user: [60, 120], anon: [60, 30], analyze: [600, 3], sign: [600, 60], pay: [600, 10], admin: [60, 60],
  maxActiveJobs: 20, maxBody: 1_100_000, maxOriginal: 4 * 1024 ** 3, maxProxy: 80 * 1024 ** 2, multipartAbove: 50 * 1024 ** 2,
} as const;

/* ────────────────────────── Utilitaires ────────────────────────── */
class HttpError extends Error { constructor(public status: number, msg: string, public extra: Record<string, unknown> = {}, public headers: Record<string, string> = {}) { super(msg); } }
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", ...headers } });
const oid = (s: string | undefined) => { if (!s || !/^[a-f0-9]{24}$/.test(s)) throw new HttpError(400, "Identifiant invalide."); return new ObjectId(s); };
const parse = <T extends z.ZodType>(schema: T, v: unknown): z.infer<T> => {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, "Données invalides : " + r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(racine)"} ${i.message}`).join(" ; "));
  return r.data;
};
const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/);
const toId = (d: any) => ({ ...d, id: String(d._id), _id: undefined, ownerId: undefined });

interface Ctx { req: Request; url: URL; p: string[]; user: SessionUser; body: any; ip: string }
type Handler = (c: Ctx) => Promise<Response | unknown>;
interface Route { m: string; path: string; auth: "user" | "admin" | "none" | "cron" | "webhook"; limit?: readonly [string, number, number]; h: Handler }

/* ────────────────────────── Cloudflare R2 (S3-compatible, bucket privé, URL signées) ────────────────────────── */
const r2cfg = () => {
  const { R2_ACCOUNT_ID: a, R2_ACCESS_KEY_ID: k, R2_SECRET_ACCESS_KEY: s, R2_BUCKET: b } = process.env;
  if (!a || !k || !s || !b) throw new HttpError(503, "Le stockage n'est pas configuré (variables R2_*).");
  return { aws: new AwsClient({ accessKeyId: k, secretAccessKey: s, service: "s3", region: "auto" }), base: `https://${a}.r2.cloudflarestorage.com/${b}` };
};
const keyOf = (userId: string, projectId: string, assetId: string, kind: string) => `u/${userId}/${projectId}/${assetId}/${kind}`;
const enc = (k: string) => k.split("/").map(encodeURIComponent).join("/");
async function presign(method: string, key: string, query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const { aws, base } = r2cfg();
  const u = new URL(`${base}/${enc(key)}`);
  for (const [k, v] of Object.entries({ ...query, "X-Amz-Expires": "900" })) u.searchParams.set(k, v);
  return (await aws.sign(u.toString(), { method, headers, aws: { signQuery: true } })).url;
}
async function r2Head(key: string): Promise<number | null> {
  const { aws, base } = r2cfg(); const r = await aws.fetch(`${base}/${enc(key)}`, { method: "HEAD" });
  return r.ok ? Number(r.headers.get("content-length") ?? 0) : null;
}
async function r2Delete(key: string) { const { aws, base } = r2cfg(); await aws.fetch(`${base}/${enc(key)}`, { method: "DELETE" }); }
async function r2List(prefix: string, max = 1000): Promise<string[]> {
  const { aws, base } = r2cfg(); const keys: string[] = []; let token = "";
  while (keys.length < max) {
    const r = await aws.fetch(`${base}?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`);
    if (!r.ok) break;
    const x = await r.text();
    for (const m of x.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(x);
    if (!next) break; token = next[1];
  }
  return keys;
}
async function r2DeletePrefix(prefix: string) { if (!process.env.R2_BUCKET) return; for (const k of await r2List(prefix, 2000)) await r2Delete(k); }

async function r2Put(key: string, body: Uint8Array, type: string) {
  const { aws, base } = r2cfg(); const r = await aws.fetch(`${base}/${enc(key)}`, { method: "PUT", body: body as unknown as BodyInit, headers: { "Content-Type": type } });
  if (!r.ok) throw new Error("Stockage du média généré impossible.");
}

/* ────────────────────────── Suppression de compte ────────────────────────── */
async function purgeUser(userId: string) {
  const id = new ObjectId(userId);
  try { await r2DeletePrefix(`u/${userId}/`); } catch { /* R2 absent en dev */ }
  const db = (await nativeClient()).db();
  await Promise.all([
    Project.deleteMany({ ownerId: id }), Version.deleteMany({ ownerId: id }), Job.deleteMany({ userId: id }), Upload.deleteMany({ userId: id }),
    Ledger.deleteMany({ userId: id }), db.collection("accounts").deleteMany({ userId: id }), db.collection("sessions").deleteMany({ userId: id }),
  ]);
  await User.deleteOne({ _id: id }); invalidateFlags(userId);
}

/* ────────────────────────── Analyse : job en tâche de fond ────────────────────────── */
async function setJob(jobId: unknown, patch: Record<string, unknown>) { await Job.updateOne({ _id: jobId }, { $set: patch }); }

async function runJob(jobId: string) {
  await connect();
  const job = await Job.findById(jobId).lean(); if (!job) return;
  const uid = String(job.userId);
  try {
    await setJob(jobId, { status: "running", progress: 0.05, message: "Préparation des proxys…" });
    const project = await Project.findOne({ _id: job.projectId, ownerId: job.userId }).lean(); if (!project) throw new Error("Projet introuvable");
    const doc = migrate(project.doc);
    const s = await getSettings();
    const media: MediaInput[] = [], used = usedAssets(doc);
    for (const [id, a] of Object.entries(doc.assets)) {
      if ((a.type !== "video" && a.type !== "image" && a.type !== "audio") || !a.proxy || !used.has(id)) continue;
      if (!a.proxy.startsWith(`u/${uid}/`)) throw new Error("Clé de proxy invalide");
      const { aws, base } = r2cfg();
      const r = await aws.fetch(`${base}/${enc(a.proxy)}`);
      if (!r.ok) throw new Error(`Proxy introuvable pour ${id}`);
      const proxy = await r.blob();
      media.push(a.type === "video" ? { id, type: "video", name: a.name, desc: a.desc, w: a.w, h: a.h, dur: a.dur, fps: a.fps, rot: a.rot, hasAudio: a.hasAudio, proxy }
        : a.type === "image" ? { id, type: "image", name: a.name, desc: a.desc, w: a.w, h: a.h, proxy } : { id, type: "audio", name: a.name, desc: a.desc, dur: a.dur, proxy });
    }
    if (!media.some((m) => m.type === "video")) throw new Error("Aucun proxy vidéo envoyé : relancez l'analyse depuis l'éditeur.");
    let result;
    try {
      result = await callGemini({ media, brief: BriefS.parse(project.brief), disabled: s.disabledEffects, base: doc, ai: s.ai, suggest: s.gen.enabled }, (p, m) => setJob(jobId, { progress: p, message: m }));
    } catch (e: any) {
      if (e?.raw !== undefined) {
        // Réponse invalide après nouvelle tentative → repli séquentiel + remboursement (tokens journalisés)
        const v = await Version.create({ projectId: project._id, ownerId: job.userId, kind: "ai", label: "Repli (montage séquentiel)", doc: fallbackDoc(doc), meta: { fallback: true, raw: String(e.raw).slice(0, 200_000), error: e.message, model: ANALYSIS.model, tokensIn: e.tokensIn, tokensOut: e.tokensOut } });
        await Ledger.create({ userId: job.userId, kind: "spend", action: "analysis_failed", credits: 0, tokensIn: e.tokensIn, tokensOut: e.tokensOut, costUsd: ((e.tokensIn ?? 0) * s.tokens.usdPerMTokIn + (e.tokensOut ?? 0) * s.tokens.usdPerMTokOut) / 1e6, refId: jobId });
        await refund(uid, job.reserved, "analysis_refund", jobId);
        await setJob(jobId, { status: "done", progress: 1, message: "L'IA n'a pas produit de montage valide : montage simple proposé, crédits remboursés.", versionId: v._id, fallback: true });
        return;
      }
      throw e;
    }
    await setJob(jobId, { progress: 0.9, message: "Validation du montage…" });
    const merged = mergeAi(doc, result.ai, s.disabledEffects);
    const v = await Version.create({ projectId: project._id, ownerId: job.userId, kind: "ai", label: "Montage IA", doc: merged, meta: { raw: result.raw.slice(0, 200_000), suggestions: result.ai.suggestions ?? [], fallbackLog: result.log, audioLimited: result.audioLimited, model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut, latencyMs: result.latencyMs, attempts: result.attempts, catalogTokens: catalogTokens(s.disabledEffects) } });
    const { costUsd } = await settle(uid, job.reserved, jobId, result.tokensIn, result.tokensOut);
    await setJob(jobId, { status: "done", progress: 1, message: "Montage prêt.", versionId: v._id, costUsd });
    await logEvent(uid, "analysis_done", { projectId: String(project._id), tokens: result.tokensIn + result.tokensOut });
  } catch (e: any) {
    await refund(uid, job.reserved, "analysis_refund", jobId).catch(() => {});
    await setJob(jobId, { status: "failed", progress: 1, error: friendlyError(e), message: "L'analyse a échoué : crédits remboursés." });
  }
}

/* ────────────────────────── Génération de médias (images, vidéos) ────────────────────────── */
const hasPaid = async (u: any) => (u?.plan ?? "free") !== "free" || !!(await Ledger.exists({ userId: u?._id, action: "purchase" }));

async function failGeneration(job: any, e: unknown) {
  await refund(String(job.userId), job.reserved, "generation_refund", String(job._id)).catch(() => {});
  await setJob(job._id, { status: "failed", progress: 1, error: e instanceof GenError ? e.message : friendlyError(e), message: "La génération a échoué : crédits remboursés." });
}
/** Enregistre le média généré dans R2 (compté dans le stockage de l'utilisateur) et rend le job « done » avec le résultat. */
async function finishGeneration(job: any, s: Awaited<ReturnType<typeof getSettings>>, data: Uint8Array, mime: string) {
  const uid = String(job.userId), assetId = nanoid(6), key = keyOf(uid, String(job.projectId), assetId, "original");
  await r2Put(key, data, mime);
  await Upload.create({ userId: job.userId, projectId: job.projectId, key, size: data.length, done: true });
  await recordStorage(uid, data.length, key, s);
  const costUsd = genCostUsd(s.tokens, job.genKind, job.seconds ?? 0);
  await Ledger.create({ userId: job.userId, kind: "spend", action: "generation", credits: 0, costUsd, refId: String(job._id) });
  await setJob(job._id, { status: "done", progress: 1, message: "Média prêt.", costUsd,
    result: { assetId, key, mime, bytes: data.length, kind: job.genKind, prompt: job.prompt, name: `${job.genKind === "image" ? "Image" : "Vidéo"} IA : ${String(job.prompt).slice(0, 40)}` } });
}
async function runGeneration(jobId: string) {
  await connect();
  const job = await Job.findById(jobId).lean(); if (!job) return;
  try {
    const s = await getSettings();
    await setJob(jobId, { status: "running", progress: 0.1, message: job.genKind === "image" ? "Création de l'image…" : "Lancement de la vidéo…" });
    if (job.genKind === "image") { const img = await generateImage(s.gen.imageModel, job.prompt, job.aspect, s.ai); await finishGeneration(job, s, img.data, img.mime); }
    else {
      const op = await startVideo(s.gen.videoModel, job.prompt, job.aspect, job.seconds, s.ai);
      await setJob(jobId, { externalOp: op, progress: 0.15, message: "La vidéo se génère (1 à 3 minutes)…" });   // la suite est avancée par les interrogations du client
    }
  } catch (e) { await failGeneration(job, e); }
}

/* ────────────────────────── Routes ────────────────────────── */
const R: Route[] = [];
const add = (m: string, path: string, auth: Route["auth"], h: Handler, limit?: Route["limit"]) => R.push({ m, path, auth, h, limit });

// ---- Profil
add("GET", "me", "user", async ({ user }) => {
  const [u, s] = await Promise.all([User.findById(user.id).lean(), getSettings()]);
  const [ledger, today] = await Promise.all([
    Ledger.find({ userId: user.id }).sort({ ts: -1 }).limit(30).lean(),
    Job.countDocuments({ userId: user.id, kind: "analyze", createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
  ]);
  const plan = planOf(u, s);
  return { id: user.id, name: u.name, email: u.email, image: u.image, plan: u.plan ?? "free", role: u.role ?? "user", credits: u.credits ?? 0, storageBytes: u.storageBytes ?? 0,
    prefs: u.prefs ?? {}, analysis: { proxyShortSide: ANALYSIS.proxyShortSide, proxyFps: ANALYSIS.proxyFps, imageProxySide: ANALYSIS.imageProxySide }, disabledEffects: s.disabledEffects, limits: { ...plan, analysesToday: today }, gen: { enabled: s.gen.enabled, imageCredits: s.gen.imageCredits, videoCreditsPerSec: s.gen.videoCreditsPerSec, maxVideoSec: s.gen.maxVideoSec, videoEnabled: s.gen.videoEnabled && (!s.gen.videoPaidOnly || (await hasPaid(u))), videoPaidOnly: s.gen.videoPaidOnly },
    billing: s.billing, provider: getProvider().name, subscription: u.subscription ?? null,
    packs: s.billing.oneTime ? s.packs.map(({ id, label, credits, price, currency }) => ({ id, label, credits, price, currency })) : [],
    subscriptionPlans: s.billing.subscriptions ? s.subscriptionPlans.map(({ id, label, price, currency, creditsPerMonth, plan }) => ({ id, label, price, currency, creditsPerMonth, plan })) : [], rates: s.rates, ledger: ledger.map(toId) };
});
add("PATCH", "me", "user", async ({ user, body }) => {
  const b = parse(z.strictObject({ name: z.string().min(1).max(80).optional(), prefs: z.strictObject({ platform: BriefS.shape.platform.optional(), lang: z.string().max(12).optional() }).optional() }), body);
  const set: Record<string, unknown> = {};
  if (b.name) set.name = b.name;
  if (b.prefs?.platform) set["prefs.platform"] = b.prefs.platform;
  if (b.prefs?.lang) set["prefs.lang"] = b.prefs.lang;
  await User.updateOne({ _id: user.id }, { $set: set }); return { ok: true };
});
add("DELETE", "me", "user", async ({ user }) => { await purgeUser(user.id); return { ok: true }; });

// ---- Projets
add("GET", "projects", "user", async ({ user, url }) => {
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) | 0);
  const rows = await Project.find({ ownerId: user.id }).select("-doc").sort({ updatedAt: -1 }).skip(page * 20).limit(21).lean();
  return { items: rows.slice(0, 20).map(toId), more: rows.length > 20 };
});
add("POST", "projects", "user", async ({ user, body }) => {
  const b = parse(ProjectCreateS, body);
  const n = await Project.countDocuments({ ownerId: user.id }); if (n >= 200) throw new HttpError(402, "Limite de projets atteinte.");
  const u = await User.findById(user.id).select("prefs").lean();
  const brief = b.brief ?? { platform: u?.prefs?.platform ?? "tiktok", lang: u?.prefs?.lang };
  const p = await Project.create({ ownerId: user.id, name: b.name, brief, doc: b.example ? EXAMPLE_DOC : emptyComposition(), rev: 0 });
  await logEvent(user.id, "project_created", { example: !!b.example });
  return json({ id: String(p._id) }, 201);
});
const own = async (userId: string, id: string, fields = "") => {
  const p = await Project.findOne({ _id: oid(id), ownerId: userId }).select(fields).lean();
  if (!p) throw new HttpError(404, "Projet introuvable."); return p;
};
add("GET", "projects/:id", "user", async ({ user, p, req }) => {
  const pr = await own(user.id, p[1]);
  const etag = `"${pr.rev}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return json(toId(pr), 200, { ETag: etag });
});
add("PATCH", "projects/:id", "user", async ({ user, p, body }) => {
  const b = parse(ProjectPatchS, body);
  const set: Record<string, unknown> = {};
  if (b.doc) {
    if (JSON.stringify(b.doc).length > DOC_LIMITS.bytes) throw new HttpError(413, "Document trop volumineux (1 Mo max).");
    set.doc = b.doc;
  }
  if (b.name) set.name = b.name; if (b.brief) set.brief = b.brief; if (b.thumb) set.thumb = b.thumb;
  const filter: Record<string, unknown> = { _id: oid(p[1]), ownerId: user.id }; if (!b.force) filter.rev = b.rev;
  const updated = await Project.findOneAndUpdate(filter, { $set: set, $inc: { rev: 1 } }, { new: true }).select("rev updatedAt").lean();
  if (!updated) { const cur = await Project.findOne({ _id: oid(p[1]), ownerId: user.id }).select("rev").lean(); if (!cur) throw new HttpError(404, "Projet introuvable."); throw new HttpError(409, "Le projet a été modifié ailleurs.", { rev: cur.rev }); }
  if (b.doc) {
    // Version `auto` au plus une fois par minute ; on garde les 50 dernières
    const last = await Version.findOne({ projectId: oid(p[1]), kind: "auto" }).sort({ createdAt: -1 }).select("createdAt").lean();
    if (!last || Date.now() - +last.createdAt > 60_000) {
      await Version.create({ projectId: oid(p[1]), ownerId: user.id, kind: "auto", label: "Sauvegarde auto", doc: b.doc });
      const old = await Version.find({ projectId: oid(p[1]), kind: "auto" }).sort({ createdAt: -1 }).skip(50).select("_id").lean();
      if (old.length) await Version.deleteMany({ _id: { $in: old.map((o: any) => o._id) } });
    }
  }
  return { rev: updated.rev, updatedAt: updated.updatedAt };
});
add("DELETE", "projects/:id", "user", async ({ user, p }) => {
  await own(user.id, p[1], "_id");
  const ups = await Upload.find({ userId: user.id, projectId: oid(p[1]), done: true }).select("size").lean();
  try { await r2DeletePrefix(`u/${user.id}/${p[1]}/`); } catch { /* R2 absent */ }
  const bytes = ups.reduce((a: number, u: any) => a + (u.size ?? 0), 0);
  if (bytes) await recordStorage(user.id, -bytes, p[1]);
  await Promise.all([Project.deleteOne({ _id: oid(p[1]), ownerId: user.id }), Version.deleteMany({ projectId: oid(p[1]) }), Job.deleteMany({ projectId: oid(p[1]) }), Upload.deleteMany({ projectId: oid(p[1]) })]);
  return { ok: true };
});
add("DELETE", "projects/:id/assets/:assetId", "user", async ({ user, p }) => {
  await own(user.id, p[1], "_id");
  const aid = parse(safeId, p[3]), keys = (["original", "proxy"] as const).map((k) => keyOf(user.id, p[1], aid, k));
  const ups = await Upload.find({ userId: user.id, projectId: oid(p[1]), key: { $in: keys } }).lean();
  for (const k of keys) { try { await r2Delete(k); } catch { /* R2 absent ou objet déjà supprimé */ } }
  const bytes = ups.filter((u: any) => u.done).reduce((a: number, u: any) => a + (u.size ?? 0), 0);
  if (bytes) await recordStorage(user.id, -bytes, aid);
  await Upload.deleteMany({ userId: user.id, projectId: oid(p[1]), key: { $in: keys } });
  return { ok: true, freed: bytes };
});
add("GET", "projects/:id/versions", "user", async ({ user, p }) => {
  await own(user.id, p[1], "_id");
  const rows = await Version.find({ projectId: oid(p[1]) }).select("-doc -meta.raw").sort({ createdAt: -1 }).limit(100).lean();
  return { items: rows.map(toId) };
});
add("GET", "projects/:id/versions/:vid", "user", async ({ user, p }) => {
  await own(user.id, p[1], "_id");
  const v = await Version.findOne({ _id: oid(p[3]), projectId: oid(p[1]) }).select("-meta.raw").lean();
  if (!v) throw new HttpError(404, "Version introuvable."); return { ...toId(v), doc: migrate(v.doc) };
});
add("POST", "projects/:id/versions", "user", async ({ user, p, body }) => {
  await own(user.id, p[1], "_id");
  const b = parse(z.strictObject({ label: z.string().min(1).max(80), doc: CompositionS }), body);
  const v = await Version.create({ projectId: oid(p[1]), ownerId: user.id, kind: "manual", label: b.label, doc: b.doc });
  return json({ id: String(v._id) }, 201);
});
add("POST", "projects/:id/restore/:vid", "user", async ({ user, p }) => {
  await own(user.id, p[1], "_id");
  const v = await Version.findOne({ _id: oid(p[3]), projectId: oid(p[1]) }).lean(); if (!v) throw new HttpError(404, "Version introuvable.");
  await Version.create({ projectId: oid(p[1]), ownerId: user.id, kind: "manual", label: `Avant restauration`, doc: (await Project.findById(oid(p[1])).select("doc").lean()).doc });
  const upd = await Project.findOneAndUpdate({ _id: oid(p[1]), ownerId: user.id }, { $set: { doc: v.doc }, $inc: { rev: 1 } }, { new: true }).select("rev").lean();
  await Version.create({ projectId: oid(p[1]), ownerId: user.id, kind: "manual", label: `Restauré : ${v.label ?? v.kind}`, doc: v.doc });
  return { rev: upd.rev, doc: migrate(v.doc) };
});

// ---- Envoi des originaux et proxys (R2, URL signées 15 min)
const SignS = z.strictObject({
  projectId: z.string(), assetId: safeId, kind: z.enum(["original", "proxy"]),
  action: z.enum(["put", "init", "part", "complete", "done", "get"]).default("put"),
  size: z.number().int().min(1).max(LIMITS.maxOriginal), type: z.string().regex(/^(video|audio|image)\/[\w.+-]+$/),
  partNumber: z.number().int().min(1).max(10000).optional(), uploadId: z.string().max(400).optional(),
  parts: z.array(z.strictObject({ PartNumber: z.number().int(), ETag: z.string().max(100) })).max(10000).optional(),
});
add("POST", "upload/sign", "user", async ({ user, body }) => {
  const b = parse(SignS, body);
  await own(user.id, b.projectId, "_id");
  const key = keyOf(user.id, b.projectId, b.assetId, b.kind);
  const s = await getSettings(); const u = await User.findById(user.id).lean();
  const max = b.kind === "proxy" ? LIMITS.maxProxy : LIMITS.maxOriginal;
  if (b.size > max) throw new HttpError(413, "Fichier trop volumineux.");
  if (b.action === "get") { await Ledger.create({ userId: user.id, kind: "spend", action: "egress", credits: 0, bytes: b.size, refId: key }); return { url: await presign("GET", key) }; }
  if (b.action === "put" || b.action === "init") {
    if (!storageOk(u, s, b.size)) throw new HttpError(402, "Quota de stockage atteint pour votre offre.");
    await Upload.updateOne({ userId: user.id, key }, { $set: { projectId: oid(b.projectId), size: b.size, done: false, createdAt: new Date() } }, { upsert: true });
  }
  if (b.action === "put") return { key, url: await presign("PUT", key, {}, { "Content-Type": b.type }) };
  if (b.action === "init") {
    const { aws, base } = r2cfg();
    const r = await aws.fetch(`${base}/${enc(key)}?uploads`, { method: "POST", headers: { "Content-Type": b.type } });
    const id = /<UploadId>([^<]+)<\/UploadId>/.exec(await r.text())?.[1]; if (!r.ok || !id) throw new HttpError(502, "Impossible de démarrer l'envoi.");
    await Upload.updateOne({ userId: user.id, key }, { $set: { uploadId: id } });
    return { key, uploadId: id, partSize: 16 * 1024 ** 2 };
  }
  if (b.action === "part") {
    if (!b.partNumber || !b.uploadId) throw new HttpError(400, "partNumber et uploadId requis.");
    return { url: await presign("PUT", key, { partNumber: String(b.partNumber), uploadId: b.uploadId }) };
  }
  if (b.action === "complete") {
    if (!b.uploadId || !b.parts?.length) throw new HttpError(400, "uploadId et parts requis.");
    const { aws, base } = r2cfg();
    const xml = `<CompleteMultipartUpload>${[...b.parts].sort((a, c) => a.PartNumber - c.PartNumber).map((x) => `<Part><PartNumber>${x.PartNumber}</PartNumber><ETag>${x.ETag.replace(/[<>&]/g, "")}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const r = await aws.fetch(`${base}/${enc(key)}?uploadId=${encodeURIComponent(b.uploadId)}`, { method: "POST", body: xml });
    if (!r.ok) throw new HttpError(502, "Assemblage des morceaux impossible.");
  }
  // 'done' et 'complete' : vérification de la taille réelle, puis comptabilisation du stockage
  const real = await r2Head(key);
  if (real === null) throw new HttpError(404, "Fichier absent du stockage.");
  if (real > b.size || real > max) { await r2Delete(key); await Upload.deleteOne({ userId: user.id, key }); throw new HttpError(413, "Taille réelle supérieure à la taille annoncée."); }
  const up = await Upload.findOneAndUpdate({ userId: user.id, key, done: false }, { $set: { done: true, size: real } });
  if (up) await recordStorage(user.id, real, key, s);
  return { key, size: real };
}, ["sign", ...LIMITS.sign] as const);

// ---- Analyse
async function analysisBase(userId: string, projectId: string) {
  const pr = await own(userId, projectId); const doc = migrate(pr.doc);
  const used = usedAssets(doc);
  const ready = Object.entries(doc.assets).filter(([id, a]) => (a.type === "video" || a.type === "image" || a.type === "audio") && a.proxy && used.has(id)).map(([, a]) => a) as any[];
  const vids = ready.filter((a) => a.type === "video");
  if (!vids.length) throw new HttpError(400, "Aucun rush de la timeline n'est prêt pour l'analyse : ajoutez une vidéo à la timeline.");
  const s = await getSettings(); const u = await User.findById(userId).lean(); const plan = planOf(u, s);
  const total = vids.reduce((a, v) => a + v.dur, 0), audioMs = ready.filter((a) => a.type === "audio").reduce((a, v) => a + v.dur, 0), images = ready.filter((a) => a.type === "image").length;
  if (total + audioMs > plan.maxProxyMinutes * 60_000) throw new HttpError(413, `Durée maximale d'analyse : ${plan.maxProxyMinutes} min pour votre offre.`);
  return { s, u, plan, est: estimateAnalysis(total, s, { images, audioMs }) };
}
add("POST", "analyze/estimate", "user", async ({ user, body }) => {
  const b = parse(z.strictObject({ projectId: z.string() }), body);
  const { est, u, s } = await analysisBase(user.id, b.projectId);
  return { ...est, balance: u.credits ?? 0, model: s.ai.model, samplingFps: ANALYSIS.samplingFps };
});
add("POST", "analyze", "user", async ({ user, body }) => {
  const b = parse(z.strictObject({ projectId: z.string() }), body);
  const { plan, est, u } = await analysisBase(user.id, b.projectId);
  if (u.suspended) throw new HttpError(403, "Compte suspendu.");
  if (await Job.countDocuments({ userId: user.id, status: { $in: ["queued", "running"] } })) throw new HttpError(429, "Une analyse est déjà en cours.", {}, { "Retry-After": "30" });
  if ((await Job.countDocuments({ status: { $in: ["queued", "running"] } })) >= LIMITS.maxActiveJobs) throw new HttpError(503, "Le service est très sollicité, réessayez dans une minute.", {}, { "Retry-After": "60" });
  const today = await Job.countDocuments({ userId: user.id, kind: "analyze", createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } });
  if (today >= plan.dailyAnalyses) throw new HttpError(429, `Limite quotidienne atteinte (${plan.dailyAnalyses} analyses).`);
  const job = await Job.create({ userId: user.id, projectId: oid(b.projectId), kind: "analyze", status: "queued", reserved: est.credits, message: "En file d'attente…" });
  if (!(await reserve(user.id, est.credits, String(job._id)))) { await Job.deleteOne({ _id: job._id }); throw new HttpError(402, `Crédits insuffisants : ${est.credits} requis.`, { needed: est.credits }); }
  after(() => runJob(String(job._id)));
  return json({ jobId: String(job._id), credits: est.credits }, 202);
}, ["analyze", ...LIMITS.analyze] as const);
add("GET", "jobs/:id", "user", async ({ user, p }) => {
  const find = () => Job.findOne({ _id: oid(p[1]), userId: user.id }).lean();
  let j = await find(); if (!j) throw new HttpError(404, "Tâche introuvable.");
  // Vidéo en cours : chaque interrogation du client fait avancer la tâche d'un cran (pas de tâche de fond qui dépasserait la durée maximale).
  if (j.kind === "generate" && j.genKind === "video" && j.status === "running" && j.externalOp) {
    if (Date.now() - +j.createdAt > 12 * 60_000) await failGeneration(j, new GenError("La génération a pris trop de temps : crédits remboursés."));
    else {
      const poll = await pollVideo(j.externalOp).catch(() => ({ state: "running" as const }));    // erreur réseau passagère : on réessaiera au prochain contrôle
      if (poll.state === "done") {
        if (await Job.findOneAndUpdate({ _id: j._id, finalizing: { $ne: true } }, { $set: { finalizing: true } })) {
          try { await finishGeneration(j, await getSettings(), poll.data, poll.mime); } catch (e) { await failGeneration(j, e); }
        }
      } else if (poll.state === "failed") await failGeneration(j, new GenError(poll.message));
    }
    j = (await find())!;
  }
  return { id: String(j._id), kind: j.kind, status: j.status, progress: j.progress, message: j.message, error: j.error, versionId: j.versionId ? String(j.versionId) : null, fallback: !!j.fallback, result: j.result ?? null };
});
add("POST", "generate", "user", async ({ user, body }) => {
  const b = parse(GenRequestS, body); await own(user.id, b.projectId, "_id");
  const [s, u] = await Promise.all([getSettings(), User.findById(user.id).lean()]);
  if (u.suspended) throw new HttpError(403, "Compte suspendu.");
  const chk = checkGenRequest(s.gen, b, { hasPaid: await hasPaid(u) }); if (!chk.ok) throw new HttpError(chk.status, chk.msg);
  const day = new Date(new Date().setHours(0, 0, 0, 0)), limit = b.kind === "image" ? s.gen.dailyImages : s.gen.dailyVideos;
  if ((await Job.countDocuments({ userId: user.id, kind: "generate", genKind: b.kind, createdAt: { $gte: day } })) >= limit) throw new HttpError(429, `Limite quotidienne atteinte (${limit} ${b.kind === "image" ? "images" : "vidéos"}).`);
  if ((await Job.countDocuments({ userId: user.id, kind: "generate", status: { $in: ["queued", "running"] } })) >= 2) throw new HttpError(429, "Deux générations sont déjà en cours : attendez qu'une se termine.", {}, { "Retry-After": "30" });
  if (!storageOk(u, s, b.kind === "image" ? 3_000_000 : 60_000_000)) throw new HttpError(402, "Quota de stockage atteint pour votre offre.");
  const job = await Job.create({ userId: user.id, projectId: oid(b.projectId), kind: "generate", genKind: b.kind, prompt: b.prompt, aspect: b.aspect, seconds: chk.seconds, status: "queued", reserved: chk.credits, message: "En file d'attente…" });
  if (!(await reserve(user.id, chk.credits, String(job._id), "generation_reserve"))) { await Job.deleteOne({ _id: job._id }); throw new HttpError(402, `Crédits insuffisants : ${chk.credits} requis.`, { needed: chk.credits }); }
  after(() => runGeneration(String(job._id)));
  return json({ jobId: String(job._id), credits: chk.credits }, 202);
}, ["gen", 600, 20] as const);
add("POST", "events", "user", async ({ user, body }) => {
  const b = parse(z.strictObject({ type: z.enum(["export_done", "editor_opened"]), projectId: z.string().optional() }), body);
  await logEvent(user.id, b.type, { projectId: b.projectId }); return { ok: true };
});

// ---- Paiement
add("POST", "billing/checkout", "user", async ({ user, body }) => {
  const b = parse(z.strictObject({ type: z.enum(["pack", "subscription"]), id: z.string().max(30) }), body);
  const [s, u] = await Promise.all([getSettings(), User.findById(user.id).select("subscription").lean()]);
  const r = resolveCheckout(s, b.type, b.id, u?.subscription?.status === "active");
  if (!r.ok) throw new HttpError(r.status, r.msg);
  const prov = getProvider();
  if (prov.name === "manual") throw new HttpError(503, "Le paiement en ligne n'est pas encore activé : contactez-nous avec l'offre souhaitée.");
  try { return await prov.checkout({ id: user.id, email: user.email }, r.productId, { itemType: b.type, itemId: b.id }); }
  catch (e) { if (e instanceof BillingError) throw new HttpError(e.status, e.message); console.error("[checkout]", (e as Error).message); throw new HttpError(502, "Le service de paiement est indisponible, réessayez dans un instant."); }
}, ["pay", ...LIMITS.pay] as const);
add("POST", "billing/portal", "user", async ({ user }) => {
  const prov = getProvider(); if (!prov.portal) throw new HttpError(503, "Le portail client n'est pas disponible.");
  try { return { url: await prov.portal(user.id) }; } catch { throw new HttpError(404, "Aucun achat trouvé pour ce compte : le portail s'ouvre après un premier paiement."); }
}, ["pay", ...LIMITS.pay] as const);
add("POST", "billing/webhook", "webhook", async ({ req }) => {
  await connect(); const s = await getSettings(), prov = getProvider();
  let events;
  try { events = await prov.parseWebhook(req, s); } catch (e) { if (e instanceof BillingError) throw new HttpError(e.status, e.message); throw e; }
  for (const ev of events) await applyBillingEvent(ev, s, mongoBillingStore, prov.cancelRenewal);   // une erreur ici → 500 → Polar réessaie
  return { ok: true, handled: events.length };
});

// ---- Admin
const ENV_KEYS = ["POLAR_ACCESS_TOKEN", "POLAR_WEBHOOK_SECRET", "MONGODB_URI", "APP_ORIGIN", "AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "GEMINI_API_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "ADMIN_EMAILS", "CRON_SECRET"];
add("GET", "admin/stats", "admin", async () => {
  const s = await getSettings();
  const [users, credits, rev, cost, jobsBy, lastAi, errors] = await Promise.all([
    User.countDocuments({}),
    User.aggregate([{ $group: { _id: null, c: { $sum: "$credits" }, st: { $sum: "$storageBytes" } } }]),
    Ledger.aggregate([{ $match: { action: "purchase" } }, { $group: { _id: "$currency", amount: { $sum: "$amountPaid" } } }]),
    Ledger.aggregate([{ $match: { costUsd: { $gt: 0 } } }, { $group: { _id: "$action", usd: { $sum: "$costUsd" }, tin: { $sum: "$tokensIn" }, tout: { $sum: "$tokensOut" } } }]),
    Job.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    Job.findOne({ status: "done" }).sort({ updatedAt: -1 }).select("updatedAt costUsd").lean(),
    Job.find({ status: "failed" }).sort({ updatedAt: -1 }).limit(8).select("error updatedAt").lean(),
  ]);
  const revenueUsd = rev.filter((r: any) => !r._id || r._id === "USD").reduce((a: number, r: any) => a + r.amount, 0);
  const costUsd = cost.reduce((a: number, r: any) => a + r.usd, 0);
  return {
    users, creditsOutstanding: credits[0]?.c ?? 0, storageBytes: credits[0]?.st ?? 0, revenue: rev, revenueUsd, costUsd, marginUsd: revenueUsd - costUsd, costByAction: cost, jobs: jobsBy,
    health: { env: Object.fromEntries(ENV_KEYS.map((k) => [k, !!process.env[k]])), lastAiCall: lastAi?.updatedAt ?? null, errors: errors.map(toId), model: s.ai.model },
    settings: s, catalogTokens: catalogTokens(s.disabledEffects),
    payment: { provider: getProvider().name, sandbox: process.env.POLAR_SERVER !== "production", webhookUrl: `${process.env.APP_ORIGIN ?? ""}/api/billing/webhook`, activeSubscribers: await User.countDocuments({ "subscription.status": "active" }) },
    effects: EFFECTS.map((e) => ({ id: e.id, kind: e.kind, status: e.status, cost: e.cost, describe: e.describe, enabled: !s.disabledEffects.includes(e.id) })),
  };
}, ["admin", ...LIMITS.admin] as const);
add("GET", "admin/users", "admin", async ({ url }) => {
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) | 0);
  const q = (url.searchParams.get("q") ?? "").slice(0, 80).replace(/[^\w@.\- ]/g, "");
  const filter = q ? { $or: [{ email: { $regex: q, $options: "i" } }, { name: { $regex: q, $options: "i" } }] } : {};
  const rows = await User.find(filter).sort({ createdAt: -1 }).skip(page * 25).limit(26).lean();
  const ids = rows.slice(0, 25).map((r: any) => r._id);
  const agg = await Ledger.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: "$userId",
    costUsd: { $sum: { $ifNull: ["$costUsd", 0] } }, tin: { $sum: { $ifNull: ["$tokensIn", 0] } }, tout: { $sum: { $ifNull: ["$tokensOut", 0] } },
    paid: { $sum: { $cond: [{ $eq: ["$action", "purchase"] }, { $ifNull: ["$amountPaid", 0] }, 0] } } } }]);
  const by = new Map(agg.map((a: any) => [String(a._id), a]));
  return { more: rows.length > 25, items: rows.slice(0, 25).map((r: any) => { const a: any = by.get(String(r._id)) ?? {};
    return { id: String(r._id), name: r.name, email: r.email, plan: r.plan ?? "free", role: r.role ?? "user", credits: r.credits ?? 0, storageBytes: r.storageBytes ?? 0, suspended: !!r.suspended,
      costUsd: a.costUsd ?? 0, tokensIn: a.tin ?? 0, tokensOut: a.tout ?? 0, paidUsd: a.paid ?? 0, marginUsd: (a.paid ?? 0) - (a.costUsd ?? 0), createdAt: r.createdAt }; }) };
}, ["admin", ...LIMITS.admin] as const);
add("PATCH", "admin/users/:id", "admin", async ({ user, p, body }) => {
  const b = parse(z.strictObject({ credits: z.number().int().min(-1_000_000).max(1_000_000).optional(), plan: z.string().max(20).optional(), suspended: z.boolean().optional(), role: z.enum(["user", "admin"]).optional(), revokeSessions: z.boolean().optional(), delete: z.boolean().optional() }), body);
  const id = p[2]; oid(id);
  if (b.delete) { if (id === user.id) throw new HttpError(400, "Vous ne pouvez pas supprimer votre propre compte ici."); await purgeUser(id); await audit(user.id, "user_delete", { target: id }); return { ok: true }; }
  const set: Record<string, unknown> = {}; const inc: Record<string, number> = {};
  if (b.plan) { if (!(await getSettings()).plans[b.plan]) throw new HttpError(400, "Offre inconnue."); set.plan = b.plan; }
  if (b.role) { if (id === user.id && b.role !== "admin") throw new HttpError(400, "Vous ne pouvez pas vous retirer le rôle admin."); set.role = b.role; }
  if (b.suspended !== undefined) { set.suspended = b.suspended; if (b.suspended) inc.sessionVersion = 1; }
  if (b.revokeSessions) inc.sessionVersion = 1;
  if (Object.keys(set).length || Object.keys(inc).length) await User.updateOne({ _id: id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(inc).length ? { $inc: inc } : {}) });
  if (b.credits) await grant(id, b.credits, b.credits > 0 ? "admin_grant" : "admin_remove", { refId: user.id });
  invalidateFlags(id); await audit(user.id, "user_update", { target: id, ...b });
  return { ok: true };
}, ["admin", ...LIMITS.admin] as const);
add("PATCH", "admin/settings", "admin", async ({ user, body }) => {
  const patch = parse(SettingsS.partial(), body), before = await getSettings();
  const next = await saveSettings(patch); await audit(user.id, "settings_update", { keys: Object.keys(patch), disabled: patch.disabledEffects });
  // Abonnements désactivés : on cesse de RENOUVELER les abonnés actuels (ils gardent leur offre jusqu'à la fin de la période payée).
  let renewals: { done: number; failed: number } | undefined;
  if (before.billing.subscriptions && !next.billing.subscriptions) {
    const prov = getProvider();
    if (prov.cancelRenewal) { renewals = await cancelAllRenewals(mongoBillingStore, prov.cancelRenewal); await audit(user.id, "subscriptions_disabled", renewals); }
  }
  return { settings: next, catalogTokens: catalogTokens(next.disabledEffects), renewals };
}, ["admin", ...LIMITS.admin] as const);
add("GET", "admin/jobs", "admin", async () => {
  const rows = await Job.find({}).sort({ createdAt: -1 }).limit(50).lean();
  const users = await User.find({ _id: { $in: rows.map((r: any) => r.userId) } }).select("email").lean();
  const em = new Map(users.map((u: any) => [String(u._id), u.email]));
  return { items: rows.map((r: any) => ({ id: String(r._id), user: em.get(String(r.userId)), status: r.status, progress: r.progress, message: r.message, error: r.error, costUsd: r.costUsd, reserved: r.reserved, fallback: !!r.fallback, createdAt: r.createdAt })) };
}, ["admin", ...LIMITS.admin] as const);
add("POST", "admin/jobs/:id/retry", "admin", async ({ user, p }) => {
  const j = await Job.findById(oid(p[2])).lean(); if (!j) throw new HttpError(404, "Tâche introuvable."); if (j.kind !== "analyze") throw new HttpError(400, "Seules les analyses peuvent être relancées.");
  const n = await Job.create({ userId: j.userId, projectId: j.projectId, kind: j.kind, status: "queued", reserved: 0, message: "Relance admin…" });
  after(() => runJob(String(n._id))); await audit(user.id, "job_retry", { job: p[2] }); return json({ jobId: String(n._id) }, 202);
}, ["admin", ...LIMITS.admin] as const);

// ---- Cron : purge d'inactivité + envois orphelins
add("POST", "cron/cleanup", "cron", async () => {
  const s = await getSettings(); const cutoff = new Date(Date.now() - s.inactivityDays * 86_400_000);
  const stale = await User.find({ role: { $ne: "admin" }, $or: [{ lastActiveAt: { $lt: cutoff } }, { lastActiveAt: null, createdAt: { $lt: cutoff } }], storageBytes: { $gt: 0 } }).select("_id").limit(50).lean();
  let purged = 0;
  for (const u of stale) { await r2DeletePrefix(`u/${u._id}/`); await User.updateOne({ _id: u._id }, { $set: { storageBytes: 0 } }); await Upload.deleteMany({ userId: u._id }); purged++; }
  const orphans = await Upload.find({ done: false, createdAt: { $lt: new Date(Date.now() - 86_400_000) } }).limit(200).lean();
  for (const o of orphans) { try { await r2Delete(o.key); } catch { /* déjà absent */ } await Upload.deleteOne({ _id: o._id }); }
  return { purgedUsers: purged, orphans: orphans.length };
});

/* ────────────────────────── Garde-fous + routeur ────────────────────────── */
function match(route: Route, method: string, segs: string[]): boolean {
  if (route.m !== method) return false;
  const ps = route.path.split("/");
  return ps.length === segs.length && ps.every((x, i) => x.startsWith(":") || x === segs[i]);
}

async function guard(req: Request, route: Route): Promise<Ctx> {
  const ip = clientIp(req.headers);
  const mutating = req.method !== "GET";
  if (mutating && route.auth !== "webhook" && route.auth !== "cron") {
    const origin = req.headers.get("origin"), app = process.env.APP_ORIGIN;
    if (!app || origin !== new URL(app).origin) throw new HttpError(403, "Origine non autorisée.");
    if (req.method !== "DELETE" && !(req.headers.get("content-type") ?? "").startsWith("application/json")) throw new HttpError(415, "Content-Type application/json requis.");
  }
  let raw = "";
  if (mutating && req.method !== "DELETE" && (route.auth === "user" || route.auth === "admin")) { raw = await req.text(); if (raw.length > LIMITS.maxBody) throw new HttpError(413, "Requête trop volumineuse."); }
  let body: any = undefined;
  if (raw) { try { body = JSON.parse(raw); } catch { throw new HttpError(400, "JSON invalide."); } }
  if (route.auth === "webhook") return { req, url: new URL(req.url), p: [], user: null as any, body, ip };
  if (route.auth === "cron") {
    const sec = process.env.CRON_SECRET; if (!sec || req.headers.get("authorization") !== `Bearer ${sec}`) throw new HttpError(401, "Non autorisé.");
    return { req, url: new URL(req.url), p: [], user: null as any, body, ip };
  }
  await connect();
  const user = route.auth === "admin" ? await requireAdmin() : await requireUser();
  if (!user) throw new HttpError(route.auth === "admin" ? 403 : 401, route.auth === "admin" ? "Accès réservé aux administrateurs." : "Connexion requise.");
  const [win, max] = LIMITS.user;
  const g = await hit(`api:${user.id}`, max, win);
  if (!g.ok) throw new HttpError(429, "Trop de requêtes.", { retryAfter: g.retryAfter }, { "Retry-After": String(g.retryAfter) });
  if (route.limit) {
    const [cls, w, m] = route.limit; const r = await hit(`${cls}:${user.id}`, m, w);
    if (!r.ok) throw new HttpError(429, "Limite atteinte pour cette action.", { retryAfter: r.retryAfter }, { "Retry-After": String(r.retryAfter) });
  }
  return { req, url: new URL(req.url), p: [], user, body, ip };
}

async function handle(req: Request, { params }: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const segs = (await params).path ?? [];
  const route = R.find((r) => match(r, req.method, segs));
  try {
    if (!route) {
      // Non connecté / route inconnue : limite par IP
      try { await connect(); const [w, m] = LIMITS.anon; const r = await hit(`anon:${clientIp(req.headers)}`, m, w); if (!r.ok) throw new HttpError(429, "Trop de requêtes.", {}, { "Retry-After": String(r.retryAfter) }); } catch (e) { if (e instanceof HttpError) throw e; }
      throw new HttpError(404, "Route inconnue.");
    }
    const ctx = await guard(req, route);
    ctx.p = segs;
    const out = await route.h(ctx);
    return out instanceof Response ? out : json(out);
  } catch (e: any) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status, e.headers);
    console.error("[api]", req.method, segs.join("/"), e?.message);   // jamais de jetons ni de contenu de rushs dans les logs
    return json({ error: "Erreur interne." }, 500);
  }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
