//src/lib/billing.ts
/**
 * billing.ts — crédits : estimation, réservation, règlement, remboursement ; tarifs ; PaymentProvider.
 * Contient : estimateAnalysis, reserve/settle/refund/grant (atomiques + ledger), planOf, storageOk,
 *            interface PaymentProvider + adaptateur `manual` (v1).
 * Ne contient PAS : appels IA (gemini.ts), routes, UI. Tarifs et quotas : lus dans `settings` (admin).
 */
import { createPolar, webhooks } from "@polar-sh/sdk/2026-10";
import { Ledger, User, getSettings } from "./db";
import { ANALYSIS } from "./gemini";
import type { Settings } from "./schema";

export interface Estimate { tokens: number; credits: number; minutes: number }
/** Formule 7.3 : images analysées × tokens/image + audio. Constantes dans ANALYSIS. */
export function estimateAnalysis(totalDurMs: number, s: Settings, extra: { images?: number; audioMs?: number } = {}): Estimate {
  const sec = totalDurMs / 1000, images = extra.images ?? 0, audioSec = (extra.audioMs ?? 0) / 1000;
  const tokens = Math.ceil(sec * ANALYSIS.samplingFps * ANALYSIS.tokensPerFrame + sec * ANALYSIS.audioTokensPerSec + images * ANALYSIS.tokensPerImage + audioSec * ANALYSIS.audioTokensPerSec);
  const minutes = sec / 60;
  // Un son pèse 1/4 d'une minute de vidéo, une image 1/50 de minute : coût d'analyse en minutes équivalentes
  const eq = minutes + audioSec / 60 / 4 + images / 50;
  return { tokens, minutes, credits: Math.max(1, Math.ceil(eq * s.rates.analysisPerMinute)) };
}
export const planOf = (user: { plan?: string }, s: Settings) => s.plans[user.plan ?? "free"] ?? s.plans.free;
export const storageOk = (user: { plan?: string; storageBytes?: number }, s: Settings, add: number) =>
  (user.storageBytes ?? 0) + add <= planOf(user, s).storageGB * 1024 ** 3;

/** Réserve atomiquement ; null si solde insuffisant ou compte suspendu (aucun appel IA ensuite). */
export async function reserve(userId: string, credits: number, refId: string, action = "analysis_reserve"): Promise<boolean> {
  const r = await User.findOneAndUpdate({ _id: userId, credits: { $gte: credits }, suspended: { $ne: true } }, { $inc: { credits: -credits } });
  if (!r) return false;
  await Ledger.create({ userId, kind: "spend", action, credits, refId });
  return true;
}
export async function refund(userId: string, credits: number, action: string, refId?: string) {
  if (credits <= 0) return;
  await User.updateOne({ _id: userId }, { $inc: { credits } });
  await Ledger.create({ userId, kind: "refund", action, credits, refId });
}
export async function grant(userId: string, credits: number, action: string, extra: Record<string, unknown> = {}) {
  await User.updateOne({ _id: userId }, { $inc: { credits } });
  await Ledger.create({ userId, kind: "grant", action, credits, ...extra });
}
/** Règle sur les tokens réels : coût USD (tarifs de settings) → crédits réellement dus ; rend le surplus réservé. */
export async function settle(userId: string, reserved: number, refId: string, tokensIn: number, tokensOut: number) {
  const s = await getSettings();
  const costUsd = (tokensIn * s.tokens.usdPerMTokIn + tokensOut * s.tokens.usdPerMTokOut) / 1e6;
  const due = Math.min(reserved, Math.max(1, Math.ceil(costUsd / Math.max(1e-9, s.tokens.usdPerCredit))));
  await Ledger.create({ userId, kind: "spend", action: "analysis", credits: 0, costUsd, tokensIn, tokensOut, refId });
  await refund(userId, reserved - due, "analysis_settle", refId);
  return { costUsd, charged: due };
}
export async function recordStorage(userId: string, bytes: number, refId?: string, s?: Settings) {
  const st = s ?? (await getSettings());
  await User.updateOne({ _id: userId }, { $inc: { storageBytes: bytes } });
  await Ledger.create({ userId, kind: "spend", action: "storage", credits: 0, bytes, costUsd: (Math.abs(bytes) / 1024 ** 3) * st.tokens.usdPerGBMonth, refId });
}

/* ───── Paiement : Polar (Merchant of Record) ─────
 * Polar encaisse, gère la TVA et les litiges, puis nous prévient par webhook. Aucune donnée de carte ne passe chez nous.
 * Règle d'or : on ne retire JAMAIS à un client ce qu'il a payé. Désactiver les abonnements n'en suspend aucun : on cesse seulement de
 * les renouveler (résiliation « en fin de période » côté Polar) ; l'offre reste active jusqu'à la fin de la période déjà payée.
 */
export class BillingError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export interface StoredSub { id: string; itemId: string; plan: string; status: "active" | "ended"; periodEnd?: string; cancelAtPeriodEnd: boolean; lastEventAt: number }
export type BillingEvent =
  | { type: "credits"; ref: string; userId: string; credits: number; amount: number; currency: string; itemId: string; subscriptionId?: string }
  | { type: "refund"; ref: string; orderId: string; userId: string; credits: number; refunded: number; total: number }
  | { type: "subscription"; ref: string; userId: string; subscriptionId: string; itemId: string; plan: string; state: "active" | "ended"; periodEnd?: string; cancelAtPeriodEnd: boolean; at: number };

/** Ce que la logique de paiement demande à la base : une interface pour pouvoir la tester sans MongoDB. */
export interface BillingStore {
  hasLedger(action: string, refId: string): Promise<boolean>;
  ledgerSum(action: string, refPrefix: string): Promise<number>;
  grant(userId: string, credits: number, action: string, extra: { refId: string; amountPaid?: number; currency?: string }): Promise<void>;
  removeCredits(userId: string, credits: number, action: string, refId: string): Promise<void>;
  getSubscription(userId: string): Promise<StoredSub | null>;
  setSubscription(userId: string, sub: StoredSub, plan: string): Promise<void>;
  activeSubscriptions(): Promise<{ userId: string; subId: string }[]>;
  markCancelAtPeriodEnd(userId: string): Promise<void>;
}
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const mongoBillingStore: BillingStore = {
  hasLedger: async (action, refId) => !!(await Ledger.findOne({ action, refId }).select("_id").lean()),
  ledgerSum: async (action, prefix) => (await Ledger.find({ action, refId: { $regex: `^${esc(prefix)}` } }).select("credits").lean()).reduce((a: number, r: any) => a + (r.credits ?? 0), 0),
  grant: async (userId, credits, action, extra) => { await grant(userId, credits, action, extra); },
  removeCredits: async (userId, credits, action, refId) => { await User.updateOne({ _id: userId }, { $inc: { credits: -credits } }); await Ledger.create({ userId, kind: "spend", action, credits, refId }); },
  getSubscription: async (userId) => (await User.findById(userId).select("subscription").lean())?.subscription ?? null,
  setSubscription: async (userId, sub, plan) => { await User.updateOne({ _id: userId }, { $set: { subscription: sub, plan } }); },
  activeSubscriptions: async () => (await User.find({ "subscription.status": "active", "subscription.cancelAtPeriodEnd": { $ne: true } }).select("subscription").limit(500).lean()).map((r: any) => ({ userId: String(r._id), subId: r.subscription.id })),
  markCancelAtPeriodEnd: async (userId) => { await User.updateOne({ _id: userId }, { $set: { "subscription.cancelAtPeriodEnd": true } }); },
};

/** Un clic « Payer » est-il autorisé ? Applique les interrupteurs de l'admin et relie l'article à son produit Polar. */
export function resolveCheckout(s: Settings, type: "pack" | "subscription", id: string, hasActiveSub: boolean):
  { ok: true; productId: string; label: string } | { ok: false; status: number; msg: string } {
  if (type === "pack") {
    if (!s.billing.oneTime) return { ok: false, status: 403, msg: "Les achats de crédits sont momentanément désactivés." };
    const p = s.packs.find((x) => x.id === id);
    if (!p) return { ok: false, status: 404, msg: "Pack inconnu." };
    if (!p.productId) return { ok: false, status: 503, msg: "Ce pack n'est pas encore relié à Polar (ID produit manquant dans l'admin)." };
    return { ok: true, productId: p.productId, label: p.label };
  }
  if (!s.billing.subscriptions) return { ok: false, status: 403, msg: "Les abonnements ne sont pas proposés actuellement." };
  if (hasActiveSub) return { ok: false, status: 409, msg: "Vous avez déjà un abonnement : gérez-le depuis le portail client." };
  const p = s.subscriptionPlans.find((x) => x.id === id);
  if (!p) return { ok: false, status: 404, msg: "Abonnement inconnu." };
  if (!p.productId) return { ok: false, status: 503, msg: "Cet abonnement n'est pas encore relié à Polar (ID produit manquant dans l'admin)." };
  return { ok: true, productId: p.productId, label: p.label };
}

/** Événement Polar (déjà vérifié) → événements internes. Les produits sont identifiés par leur ID configuré dans l'admin, jamais par des métadonnées. */
export function mapPolarEvent(ev: any, s: Settings): BillingEvent[] {
  const item = (productId?: string) => {
    const pack = s.packs.find((p) => p.productId && p.productId === productId);
    if (pack) return { id: pack.id, credits: pack.credits, plan: undefined as string | undefined };
    const sp = s.subscriptionPlans.find((p) => p.productId && p.productId === productId);
    if (sp) return { id: sp.id, credits: sp.creditsPerMonth, plan: s.plans[sp.plan] ? sp.plan : s.plans.pro ? "pro" : "free" };
    return null;
  };
  const d = ev?.data;
  if (!d) return [];
  const userId: string | undefined = d.customer?.external_id ?? undefined;
  const it = item(d.product_id);
  if (!userId || !it) return [];
  if (ev.type === "order.paid") {
    if (!["purchase", "subscription_create", "subscription_cycle"].includes(d.billing_reason)) return [];
    return [{ type: "credits", ref: d.id, userId, credits: it.credits, amount: (d.total_amount ?? 0) / 100, currency: String(d.currency ?? "usd").toUpperCase(), itemId: it.id, subscriptionId: d.subscription_id ?? undefined }];
  }
  if (ev.type === "order.refunded") {
    return [{ type: "refund", ref: `${d.id}:${d.refunded_amount}`, orderId: d.id, userId, credits: it.credits, refunded: d.refunded_amount ?? 0, total: d.total_amount ?? 0 }];
  }
  if (typeof ev.type === "string" && ev.type.startsWith("subscription.") && it.plan) {
    // Fin de l'accès UNIQUEMENT à la révocation (période payée terminée). Une résiliation « en fin de période » garde l'offre active.
    const ended = ev.type === "subscription.revoked" || (["canceled", "incomplete_expired"].includes(d.status) && d.cancel_at_period_end !== true);
    return [{ type: "subscription", ref: `${d.id}:${ev.type}`, userId, subscriptionId: d.id, itemId: it.id, plan: it.plan, state: ended ? "ended" : "active",
      periodEnd: d.current_period_end ? new Date(d.current_period_end).toISOString() : undefined, cancelAtPeriodEnd: d.cancel_at_period_end === true, at: new Date(ev.timestamp ?? Date.now()).getTime() }];
  }
  return [];
}

/** Applique un événement. Idempotent : Polar peut renvoyer le même webhook plusieurs fois. */
export async function applyBillingEvent(ev: BillingEvent, s: Settings, store: BillingStore, cancelRenewal?: (subscriptionId: string) => Promise<void>): Promise<void> {
  if (ev.type === "credits") {
    if (await store.hasLedger("purchase", ev.ref)) return;
    await store.grant(ev.userId, ev.credits, "purchase", { refId: ev.ref, amountPaid: ev.amount, currency: ev.currency });
    // Abonnements désactivés entre-temps : le paiement est honoré (crédits donnés), mais on arrête les renouvellements suivants.
    if (ev.subscriptionId && !s.billing.subscriptions) await cancelRenewal?.(ev.subscriptionId).catch(() => {});
    return;
  }
  if (ev.type === "refund") {
    if (ev.total <= 0) return;
    const target = Math.floor((ev.credits * Math.min(ev.refunded, ev.total)) / ev.total);
    const delta = target - (await store.ledgerSum("purchase_refund", `${ev.orderId}:`));
    if (delta > 0) await store.removeCredits(ev.userId, delta, "purchase_refund", ev.ref);
    return;
  }
  const cur = await store.getSubscription(ev.userId);
  if (cur && cur.id === ev.subscriptionId && ev.at < cur.lastEventAt) return;              // événement plus ancien que l'état connu
  const base: StoredSub = { id: ev.subscriptionId, itemId: ev.itemId, plan: ev.plan, status: ev.state, periodEnd: ev.periodEnd, cancelAtPeriodEnd: ev.cancelAtPeriodEnd, lastEventAt: ev.at };
  if (ev.state === "active") { await store.setSubscription(ev.userId, base, ev.plan); return; }
  if (!cur || cur.id === ev.subscriptionId) await store.setSubscription(ev.userId, base, "free");   // fin de la période payée : retour à l'offre gratuite
}

/** Désactivation des abonnements : plus de renouvellement pour les abonnés actuels, qui gardent leur offre jusqu'à la fin de la période payée. */
export async function cancelAllRenewals(store: BillingStore, cancel: (subscriptionId: string) => Promise<void>): Promise<{ done: number; failed: number }> {
  let done = 0, failed = 0;
  for (const { userId, subId } of await store.activeSubscriptions()) {
    try { await cancel(subId); await store.markCancelAtPeriodEnd(userId); done++; } catch { failed++; }
  }
  return { done, failed };
}

export interface PaymentProvider {
  name: "polar" | "manual"; sandbox?: boolean;
  checkout(user: { id: string; email?: string | null }, productId: string, meta: Record<string, string>): Promise<{ url: string }>;
  parseWebhook(req: Request, s: Settings): Promise<BillingEvent[]>;
  portal?(userId: string): Promise<string>;
  cancelRenewal?(subscriptionId: string): Promise<void>;
}
const polarClient = () => createPolar({ accessToken: process.env.POLAR_ACCESS_TOKEN!, environment: process.env.POLAR_SERVER === "production" ? "production" : "sandbox" });
const origin = () => process.env.APP_ORIGIN ?? "http://localhost:3000";

export const polarProvider: PaymentProvider = {
  name: "polar", sandbox: process.env.POLAR_SERVER !== "production",
  async checkout(user, productId, meta) {
    const c = await polarClient().checkouts.create({
      products: [productId], external_customer_id: user.id, ...(user.email ? { customer_email: user.email } : {}),
      success_url: `${origin()}/dashboard?checkout=success`, metadata: meta,
    });
    return { url: c.url };
  },
  async parseWebhook(req, s) {
    const secret = process.env.POLAR_WEBHOOK_SECRET; if (!secret) throw new BillingError(503, "Webhook non configuré (POLAR_WEBHOOK_SECRET).");
    const raw = await req.text(), headers: Record<string, string> = {}; req.headers.forEach((v, k) => { headers[k] = v; });
    let ev;
    try { ev = await webhooks.validateEvent(raw, headers, secret); }
    catch (e) {
      if (e instanceof webhooks.PolarWebhookVerificationError) throw new BillingError(403, "Signature invalide.");
      if (e instanceof webhooks.PolarWebhookUnknownTypeError) return [];     // type d'événement que nous ne gérons pas : accusé de réception, sans nouvelle tentative
      throw e;
    }
    return mapPolarEvent(ev, s);
  },
  async portal(userId) {
    const r = await polarClient().customerSessions.create({ external_customer_id: userId, return_url: `${origin()}/dashboard` });
    return r.customer_portal_url;
  },
  async cancelRenewal(subscriptionId) { await polarClient().subscriptions.update(subscriptionId, { cancel_at_period_end: true }); },
};
/** Sans clés Polar : pas de paiement en ligne, l'admin accorde les crédits à la main. */
export const manualProvider: PaymentProvider = {
  name: "manual",
  async checkout() { throw new BillingError(503, "Le paiement en ligne n'est pas encore activé."); },
  async parseWebhook() { return []; },
};
export const getProvider = (): PaymentProvider => (process.env.POLAR_ACCESS_TOKEN ? polarProvider : manualProvider);
