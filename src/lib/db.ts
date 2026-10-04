//src/lib/db.ts
/**
 * db.ts — Mongoose : connexion (cache globalThis), TOUS les modèles et index, réglages, limiteur de débit, audit.
 * Contient : connect, models (users, projects, versions, jobs, ledger, events, settings, ratelimits, uploads),
 *            getSettings (cache 45 s), hit/blockFor/isBlocked, logEvent, audit.
 * Ne contient PAS : logique de crédits (billing.ts), routes (api), UI.
 * Règle Project.doc (Mixed) : validé par zod avant sauvegarde ; remplacé en entier via $set avec contrôle `rev`.
 */
import mongoose, { Schema, models, model, type Model } from "mongoose";
import { DEFAULT_SETTINGS, SettingsS, type Settings } from "./schema";

type Cache = { conn?: typeof mongoose; promise?: Promise<typeof mongoose> };
const g = globalThis as unknown as { __mongo?: Cache; __settings?: { at: number; v: Settings } };

export async function connect(): Promise<typeof mongoose> {
  const c = (g.__mongo ??= {});
  if (c.conn) return c.conn;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI manquante");
  c.promise ??= mongoose.connect(uri, { bufferCommands: false, maxPoolSize: 10 });
  c.conn = await c.promise;
  return c.conn;
}
/** Client MongoDB natif sous-jacent, réutilisé par l'adaptateur Auth.js. */
export async function nativeClient() { return (await connect()).connection.getClient(); }

const S = (def: object, opts: object = {}): Schema<any> => new Schema(def as any, { versionKey: false, ...opts } as any) as Schema<any>;
// Modèles volontairement typés `any` : les génériques Mongoose font exploser tsc ; la validation réelle est faite par zod.
const mk = <T = any>(name: string, schema: Schema<any>, coll?: string): any => (models[name] as Model<T>) || model(name, schema as any, coll);

/* ───── users (collection partagée avec l'adaptateur Auth.js, strict:false) ───── */
const userSchema = S({
  name: String, email: { type: String, index: true }, image: String,
  prefs: { type: Schema.Types.Mixed, default: {} },
  plan: { type: String, default: "free" }, role: { type: String, enum: ["user", "admin"], default: "user" },
  credits: { type: Number, default: 0 }, storageBytes: { type: Number, default: 0 },
  suspended: { type: Boolean, default: false }, sessionVersion: { type: Number, default: 0 },
  lastActiveAt: Date, createdAt: { type: Date, default: Date.now },
}, { strict: false });
export const User = mk("User", userSchema, "users");

/* ───── projects / versions ───── */
const projectSchema = S({
  ownerId: { type: Schema.Types.ObjectId, required: true }, name: { type: String, required: true },
  rev: { type: Number, default: 0 }, brief: { type: Schema.Types.Mixed, default: { platform: "tiktok" } },
  doc: { type: Schema.Types.Mixed, required: true }, thumb: String,
}, { timestamps: true, minimize: false });
projectSchema.index({ ownerId: 1, updatedAt: -1 });
export const Project = mk("Project", projectSchema);

const versionSchema = S({
  projectId: { type: Schema.Types.ObjectId, required: true }, ownerId: Schema.Types.ObjectId,
  kind: { type: String, enum: ["ai", "auto", "manual"], required: true }, label: String,
  doc: Schema.Types.Mixed, meta: Schema.Types.Mixed, createdAt: { type: Date, default: Date.now },
}, { minimize: false });
versionSchema.index({ projectId: 1, createdAt: -1 });
export const Version = mk("Version", versionSchema);

/* ───── jobs / ledger / events ───── */
const jobSchema = S({
  userId: { type: Schema.Types.ObjectId, required: true }, projectId: Schema.Types.ObjectId,
  kind: { type: String, default: "analyze" }, status: { type: String, enum: ["queued", "running", "done", "failed"], default: "queued" },
  progress: { type: Number, default: 0 }, message: String, versionId: Schema.Types.ObjectId,
  reserved: { type: Number, default: 0 }, costUsd: { type: Number, default: 0 }, error: String, fallback: Boolean,
}, { timestamps: true });
jobSchema.index({ userId: 1, status: 1 });
export const Job = mk("Job", jobSchema);

const ledgerSchema = S({
  userId: { type: Schema.Types.ObjectId, required: true }, kind: { type: String, enum: ["spend", "grant", "refund"], required: true },
  action: String, credits: { type: Number, default: 0 }, costUsd: Number, tokensIn: Number, tokensOut: Number,
  bytes: Number, amountPaid: Number, currency: String, refId: String, ts: { type: Date, default: Date.now },
});
ledgerSchema.index({ userId: 1, ts: -1 });
ledgerSchema.index({ refId: 1, action: 1 });
export const Ledger = mk("Ledger", ledgerSchema);

const eventSchema = S({ userId: Schema.Types.ObjectId, type: String, data: Schema.Types.Mixed, ts: { type: Date, default: Date.now } });
eventSchema.index({ ts: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 400 });
export const EventLog = mk("Event", eventSchema, "events");

/* ───── settings (document unique) / ratelimits (TTL) / uploads ───── */
export const SettingsDoc = mk("Setting", S({ _id: String, data: Schema.Types.Mixed }, { _id: false }), "settings");
const rlSchema = S({ key: { type: String, unique: true }, count: { type: Number, default: 0 }, windowEnd: Date });
rlSchema.index({ windowEnd: 1 }, { expireAfterSeconds: 0 });
export const RateLimit = mk("RateLimit", rlSchema, "ratelimits");
const uploadSchema = S({
  userId: Schema.Types.ObjectId, projectId: Schema.Types.ObjectId, key: String, size: Number, done: { type: Boolean, default: false },
  uploadId: String, createdAt: { type: Date, default: Date.now },
});
uploadSchema.index({ userId: 1, key: 1 });
export const Upload = mk("Upload", uploadSchema);

/* ───── réglages (cache 45 s ; une modification admin invalide l'instance courante) ───── */
export async function getSettings(): Promise<Settings> {
  if (g.__settings && Date.now() - g.__settings.at < 45_000) return g.__settings.v;
  await connect();
  const row = await SettingsDoc.findById("main").lean();
  const parsed = SettingsS.safeParse({ ...DEFAULT_SETTINGS, ...(row?.data ?? {}) });
  const v = parsed.success ? parsed.data : DEFAULT_SETTINGS;
  g.__settings = { at: Date.now(), v };
  return v;
}
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = SettingsS.parse({ ...(await getSettings()), ...patch });
  await SettingsDoc.findByIdAndUpdate("main", { $set: { data: next } }, { upsert: true });
  g.__settings = { at: Date.now(), v: next };
  return next;
}

/* ───── limiteur de débit (compteurs Mongo + TTL : fonctionne en serverless) ───── */
export async function hit(key: string, limit: number, windowSec: number): Promise<{ ok: boolean; retryAfter: number }> {
  const now = new Date();
  const doc = await RateLimit.findOneAndUpdate({ key, windowEnd: { $gt: now } }, { $inc: { count: 1 } }, { new: true }).lean();
  if (doc) return { ok: doc.count <= limit, retryAfter: Math.max(1, Math.ceil((+doc.windowEnd - +now) / 1000)) };
  try {
    await RateLimit.findOneAndUpdate({ key }, { $set: { count: 1, windowEnd: new Date(+now + windowSec * 1000) } }, { upsert: true });
  } catch { /* course sur l'upsert : sans conséquence */ }
  return { ok: true, retryAfter: 0 };
}
export async function blockFor(key: string, seconds: number) {
  await RateLimit.findOneAndUpdate({ key: `block:${key}` }, { $set: { count: 1, windowEnd: new Date(Date.now() + seconds * 1000) } }, { upsert: true });
}
export async function isBlocked(key: string): Promise<number> {
  const d = await RateLimit.findOne({ key: `block:${key}`, windowEnd: { $gt: new Date() } }).lean();
  return d ? Math.max(1, Math.ceil((+d.windowEnd - Date.now()) / 1000)) : 0;
}
/** IP lue uniquement dans les en-têtes posés par l'hébergeur (jamais un en-tête arbitraire du client). */
export function clientIp(h: Headers): string {
  return h.get("x-vercel-forwarded-for")?.split(",")[0].trim() || h.get("cf-connecting-ip") || h.get("x-real-ip") || "unknown";
}

export async function logEvent(userId: unknown, type: string, data?: unknown) {
  try { await EventLog.create({ userId, type, data }); } catch { /* mesure non bloquante */ }
}
/** Journal d'audit des actions admin (qui, quoi, quand). */
export async function audit(adminId: unknown, action: string, data?: unknown) { await logEvent(adminId, "admin_action", { action, ...(data as object) }); }
