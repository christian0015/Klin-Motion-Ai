//src/lib/billing.test.ts
/** billing.test.ts — paiement : interrupteurs, correspondance des événements Polar, idempotence, remboursements, abonnements (base en mémoire). */
import { describe, it, expect, beforeEach } from "vitest";
import { applyBillingEvent, cancelAllRenewals, mapPolarEvent, resolveCheckout, type BillingEvent, type BillingStore, type StoredSub } from "./billing";
import { DEFAULT_SETTINGS, SettingsS, type Settings } from "./schema";

const settings = (o: Partial<Settings["billing"]> = {}): Settings => ({
  ...DEFAULT_SETTINGS, billing: { ...DEFAULT_SETTINGS.billing, ...o },
  packs: DEFAULT_SETTINGS.packs.map((p) => ({ ...p, productId: `prod_${p.id}` })),
  subscriptionPlans: DEFAULT_SETTINGS.subscriptionPlans.map((p) => ({ ...p, productId: `prod_${p.id}` })),
});

/** Base en mémoire : mêmes règles que MongoDB pour ce que la logique en lit. */
function memStore() {
  const users: Record<string, { credits: number; plan: string; sub: StoredSub | null }> = {};
  const ledger: { action: string; refId: string; credits: number }[] = [];
  const u = (id: string) => (users[id] ??= { credits: 0, plan: "free", sub: null });
  const store: BillingStore = {
    hasLedger: async (a, r) => ledger.some((l) => l.action === a && l.refId === r),
    ledgerSum: async (a, p) => ledger.filter((l) => l.action === a && l.refId.startsWith(p)).reduce((x, l) => x + l.credits, 0),
    grant: async (id, c, a, e) => { u(id).credits += c; ledger.push({ action: a, refId: e.refId, credits: c }); },
    removeCredits: async (id, c, a, r) => { u(id).credits -= c; ledger.push({ action: a, refId: r, credits: c }); },
    getSubscription: async (id) => u(id).sub,
    setSubscription: async (id, sub, plan) => { u(id).sub = sub; u(id).plan = plan; },
    activeSubscriptions: async () => Object.entries(users).filter(([, x]) => x.sub?.status === "active" && !x.sub.cancelAtPeriodEnd).map(([id, x]) => ({ userId: id, subId: x.sub!.id })),
    markCancelAtPeriodEnd: async (id) => { if (u(id).sub) u(id).sub!.cancelAtPeriodEnd = true; },
  };
  return { store, users, ledger, u };
}
const order = (o: object) => ({ type: "order.paid", timestamp: "2026-10-05T10:00:00Z", data: { id: "ord1", product_id: "prod_p150", billing_reason: "purchase", total_amount: 1500, refunded_amount: 0, currency: "usd", customer: { external_id: "u1" }, subscription_id: null, ...o } });
const refund = (refunded: number) => ({ ...order({ refunded_amount: refunded }), type: "order.refunded" });
const subEv = (type: string, o: object = {}) => ({ type, timestamp: "2026-10-05T10:00:00Z", data: { id: "sub1", product_id: "prod_pro_month", status: "active", cancel_at_period_end: false, current_period_end: "2026-11-05T10:00:00Z", customer: { external_id: "u1" }, ...o } });

describe("interrupteurs de paiement", () => {
  it("par défaut : paiement en une fois ACTIF, abonnements INACTIFS", () => {
    expect(DEFAULT_SETTINGS.billing).toEqual({ oneTime: true, subscriptions: false }); expect(() => SettingsS.parse(DEFAULT_SETTINGS)).not.toThrow();
    expect(resolveCheckout(settings(), "pack", "p150", false)).toMatchObject({ ok: true, productId: "prod_p150" });
    expect(resolveCheckout(settings(), "subscription", "pro_month", false)).toMatchObject({ ok: false, status: 403 });
  });
  it("abonnements activés : possible, mais pas deux fois", () => {
    expect(resolveCheckout(settings({ subscriptions: true }), "subscription", "pro_month", false)).toMatchObject({ ok: true, productId: "prod_pro_month" });
    expect(resolveCheckout(settings({ subscriptions: true }), "subscription", "pro_month", true)).toMatchObject({ ok: false, status: 409 });
  });
  it("paiement en une fois désactivé : packs refusés", () => { expect(resolveCheckout(settings({ oneTime: false }), "pack", "p150", false)).toMatchObject({ ok: false, status: 403 }); });
  it("article non relié à Polar : refus explicite", () => {
    const s = settings(); s.packs[0].productId = undefined;
    expect(resolveCheckout(s, "pack", "p150", false)).toMatchObject({ ok: false, status: 503, msg: expect.stringContaining("Polar") });
    expect(resolveCheckout(s, "pack", "inconnu", false)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("événements Polar → événements internes", () => {
  it("achat d'un pack", () => { expect(mapPolarEvent(order({}), settings())).toEqual([{ type: "credits", ref: "ord1", userId: "u1", credits: 150, amount: 15, currency: "USD", itemId: "p150", subscriptionId: undefined }]); });
  it("produit inconnu ou client sans identifiant : ignoré", () => {
    expect(mapPolarEvent(order({ product_id: "autre" }), settings())).toEqual([]); expect(mapPolarEvent(order({ customer: {} }), settings())).toEqual([]);
  });
  it("renouvellement d'abonnement : crédits mensuels", () => {
    expect(mapPolarEvent(order({ product_id: "prod_pro_month", billing_reason: "subscription_cycle", subscription_id: "sub1", total_amount: 1900 }), settings())[0]).toMatchObject({ type: "credits", credits: 250, subscriptionId: "sub1" });
  });
  it("changement d'offre en cours de période : pas de crédits supplémentaires", () => {
    expect(mapPolarEvent(order({ product_id: "prod_pro_month", billing_reason: "subscription_update" }), settings())).toEqual([]);
  });
  it("résiliation en fin de période : l'abonnement reste ACTIF ; révocation : terminé", () => {
    expect(mapPolarEvent(subEv("subscription.canceled", { cancel_at_period_end: true }), settings())[0]).toMatchObject({ state: "active", cancelAtPeriodEnd: true });
    expect(mapPolarEvent(subEv("subscription.revoked", { status: "canceled" }), settings())[0]).toMatchObject({ state: "ended" });
    expect(mapPolarEvent(subEv("subscription.updated", { status: "past_due" }), settings())[0]).toMatchObject({ state: "active" });   // impayé : on ne coupe pas avant la révocation
  });
  it("une offre absente des réglages retombe sur « pro »", () => {
    const s = settings(); s.subscriptionPlans[0].plan = "inexistante"; expect(mapPolarEvent(subEv("subscription.active"), s)[0]).toMatchObject({ plan: "pro" });
  });
});

describe("application des événements", () => {
  let m: ReturnType<typeof memStore>;
  beforeEach(() => { m = memStore(); });
  const run = async (evs: any[], s = settings()) => { for (const e of evs) for (const x of mapPolarEvent(e, s)) await applyBillingEvent(x, s, m.store); };

  it("achat : crédits donnés UNE seule fois même si le webhook est renvoyé", async () => {
    await run([order({}), order({}), order({})]); expect(m.u("u1").credits).toBe(150); expect(m.ledger.length).toBe(1);
  });
  it("remboursement : crédits retirés au prorata, une seule fois, y compris en deux remboursements partiels", async () => {
    await run([order({})]);
    await run([refund(750), refund(750)]); expect(m.u("u1").credits).toBe(75);
    await run([refund(1500)]); expect(m.u("u1").credits).toBe(0);
  });
  it("abonnement : actif → offre ; résiliation en fin de période → offre CONSERVÉE ; révocation → gratuit", async () => {
    await run([subEv("subscription.active")]); expect(m.u("u1")).toMatchObject({ plan: "pro", sub: { status: "active", cancelAtPeriodEnd: false } });
    await run([{ ...subEv("subscription.canceled", { cancel_at_period_end: true }), timestamp: "2026-10-10T10:00:00Z" }]);
    expect(m.u("u1")).toMatchObject({ plan: "pro", sub: { status: "active", cancelAtPeriodEnd: true } });
    await run([{ ...subEv("subscription.revoked", { status: "canceled" }), timestamp: "2026-11-05T10:00:00Z" }]);
    expect(m.u("u1")).toMatchObject({ plan: "free", sub: { status: "ended" } });
  });
  it("un événement plus ancien que l'état connu est ignoré", async () => {
    await run([{ ...subEv("subscription.revoked", { status: "canceled" }), timestamp: "2026-11-05T10:00:00Z" }]);
    await run([{ ...subEv("subscription.active"), timestamp: "2026-10-01T10:00:00Z" }]); expect(m.u("u1").plan).toBe("free");
  });
  it("la fin d'un ANCIEN abonnement ne coupe pas le nouveau", async () => {
    await run([subEv("subscription.active", { id: "subB" })]);
    await run([{ ...subEv("subscription.revoked", { id: "subA", status: "canceled" }), timestamp: "2026-11-05T10:00:00Z" }]); expect(m.u("u1")).toMatchObject({ plan: "pro", sub: { id: "subB", status: "active" } });
  });
});

describe("désactiver les abonnements : on ne renouvelle plus, on ne suspend personne", () => {
  it("annule les renouvellements, l'offre et les crédits des abonnés restent intacts", async () => {
    const m = memStore(), s = settings({ subscriptions: true }), cancelled: string[] = [];
    for (const e of [subEv("subscription.active", { id: "subA" }), subEv("subscription.active", { id: "subB", customer: { external_id: "u2" } })]) for (const x of mapPolarEvent(e, s)) await applyBillingEvent(x, s, m.store);
    m.u("u1").credits = 40;
    const r = await cancelAllRenewals(m.store, async (id) => { cancelled.push(id); });
    expect(r).toEqual({ done: 2, failed: 0 }); expect(cancelled.sort()).toEqual(["subA", "subB"]);
    expect(m.u("u1")).toMatchObject({ plan: "pro", credits: 40, sub: { status: "active", cancelAtPeriodEnd: true } });
    expect((await cancelAllRenewals(m.store, async () => { throw new Error("ne doit pas être rappelé"); }))).toEqual({ done: 0, failed: 0 });   // déjà résiliés : rien à refaire
  });
  it("un échec côté Polar est compté, sans casser les autres", async () => {
    const m = memStore(), s = settings({ subscriptions: true });
    for (const e of [subEv("subscription.active", { id: "subA" }), subEv("subscription.active", { id: "subB", customer: { external_id: "u2" } })]) for (const x of mapPolarEvent(e, s)) await applyBillingEvent(x, s, m.store);
    expect(await cancelAllRenewals(m.store, async (id) => { if (id === "subA") throw new Error("Polar indisponible"); })).toEqual({ done: 1, failed: 1 });
  });
  it("un renouvellement qui arrive quand même après la désactivation : crédits donnés (payé) et renouvellement suivant annulé", async () => {
    const m = memStore(), s = settings({ subscriptions: false }), cancelled: string[] = [];
    const ev = mapPolarEvent(order({ product_id: "prod_pro_month", billing_reason: "subscription_cycle", subscription_id: "subA", id: "ord9" }), s)[0] as BillingEvent;
    await applyBillingEvent(ev, s, m.store, async (id) => { cancelled.push(id); });
    expect(m.u("u1").credits).toBe(250); expect(cancelled).toEqual(["subA"]);
  });
});
