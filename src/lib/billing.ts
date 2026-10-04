//src/lib/billing.ts
/**
 * billing.ts — crédits : estimation, réservation, règlement, remboursement ; tarifs ; PaymentProvider.
 * Contient : estimateAnalysis, reserve/settle/refund/grant (atomiques + ledger), planOf, storageOk,
 *            interface PaymentProvider + adaptateur `manual` (v1).
 * Ne contient PAS : appels IA (gemini.ts), routes, UI. Tarifs et quotas : lus dans `settings` (admin).
 */
import { Ledger, User, getSettings } from "./db";
import { ANALYSIS } from "./gemini";
import type { Settings } from "./schema";

export interface Estimate { tokens: number; credits: number; minutes: number }
/** Formule 7.3 : images analysées × tokens/image + audio. Constantes dans ANALYSIS. */
export function estimateAnalysis(totalDurMs: number, s: Settings): Estimate {
  const sec = totalDurMs / 1000;
  const tokens = Math.ceil(sec * ANALYSIS.samplingFps * ANALYSIS.tokensPerFrame + sec * ANALYSIS.audioTokensPerSec);
  const minutes = sec / 60;
  return { tokens, minutes, credits: Math.max(1, Math.ceil(minutes * s.rates.analysisPerMinute)) };
}
export const planOf = (user: { plan?: string }, s: Settings) => s.plans[user.plan ?? "free"] ?? s.plans.free;
export const storageOk = (user: { plan?: string; storageBytes?: number }, s: Settings, add: number) =>
  (user.storageBytes ?? 0) + add <= planOf(user, s).storageGB * 1024 ** 3;

/** Réserve atomiquement ; null si solde insuffisant ou compte suspendu (aucun appel IA ensuite). */
export async function reserve(userId: string, credits: number, refId: string): Promise<boolean> {
  const r = await User.findOneAndUpdate({ _id: userId, credits: { $gte: credits }, suspended: { $ne: true } }, { $inc: { credits: -credits } });
  if (!r) return false;
  await Ledger.create({ userId, kind: "spend", action: "analysis_reserve", credits, refId });
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

/* ───── Paiement : interface prête ; adaptateur réel à brancher (décision D5) ───── */
export interface PaymentProvider {
  createCheckout(user: { id: string; email?: string | null }, packId: string): Promise<{ url: string }>;
  handleWebhook(req: Request): Promise<{ userId: string; packId: string; amount: number; currency: string; ref: string } | null>;
  portalUrl?(user: { id: string }): Promise<string>;
}
/** v1 : pas de paiement en ligne, l'admin accorde les crédits à la main. */
export const manualProvider: PaymentProvider = {
  async createCheckout(_u, packId) { return { url: `/dashboard?pack=${encodeURIComponent(packId)}#credits` }; },
  async handleWebhook() { return null; },
};
export const getProvider = (): PaymentProvider => manualProvider;
