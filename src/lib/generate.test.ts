//src/lib/generate.test.ts
/** generate.test.ts — génération de médias : tarification, formats, accès réservé, suggestions de l'IA, réglages. */
import { describe, it, expect } from "vitest";
import { GenRequestS, checkGenRequest, genCost, genCostUsd } from "./generate";
import { AiOutputS, DEFAULT_SETTINGS, SettingsS } from "./schema";
import { responseSchema, systemPrompt } from "./gemini";

const g = DEFAULT_SETTINGS.gen;
const req = (o: object) => GenRequestS.parse({ projectId: "a".repeat(24), kind: "image", prompt: "a red rocket", ...o });

describe("génération : tarification et accès", () => {
  it("image : prix fixe ; vidéo : proportionnel à la durée", () => { expect(genCost(g, "image")).toBe(4); expect(genCost(g, "video", 4)).toBe(48); expect(genCost(g, "video", 6)).toBe(72); });
  it("le prix en crédits couvre le coût réel (marge positive aux tarifs par défaut)", () => {
    const usd = DEFAULT_SETTINGS.tokens, perCredit = usd.usdPerCredit;
    expect(genCost(g, "image") * perCredit).toBeGreaterThan(genCostUsd(usd, "image") * 1.5);
    expect(genCost(g, "video", 6) * perCredit).toBeGreaterThan(genCostUsd(usd, "video", 6));
  });
  it("image : toujours acceptée si la génération est activée", () => { expect(checkGenRequest(g, req({}), { hasPaid: false })).toMatchObject({ ok: true, credits: 4 }); });
  it("génération désactivée : tout est refusé", () => { expect(checkGenRequest({ ...g, enabled: false }, req({}), { hasPaid: true })).toMatchObject({ ok: false, status: 403 }); });
  it("vidéo réservée aux comptes payants (réglable) : refusée sinon", () => {
    expect(checkGenRequest(g, req({ kind: "video" }), { hasPaid: false })).toMatchObject({ ok: false, status: 402 });
    expect(checkGenRequest(g, req({ kind: "video" }), { hasPaid: true })).toMatchObject({ ok: true, seconds: 6, credits: 72 });
    expect(checkGenRequest({ ...g, videoPaidOnly: false }, req({ kind: "video" }), { hasPaid: false }).ok).toBe(true);
    expect(checkGenRequest({ ...g, videoEnabled: false }, req({ kind: "video" }), { hasPaid: true })).toMatchObject({ ok: false, status: 403 });
  });
  it("vidéo : durée plafonnée par l'admin, formats 9:16 et 16:9 seulement", () => {
    expect(checkGenRequest(g, req({ kind: "video", seconds: 8 }), { hasPaid: true })).toMatchObject({ ok: true, seconds: 6 });
    expect(checkGenRequest(g, req({ kind: "video", aspect: "1:1" }), { hasPaid: true })).toMatchObject({ ok: false, status: 400 });
  });
  it("demande invalide : prompt trop court ou trop long, format inconnu, durée inconnue", () => {
    expect(GenRequestS.safeParse({ projectId: "a".repeat(24), kind: "image", prompt: "x" }).success).toBe(false);
    expect(GenRequestS.safeParse({ projectId: "a".repeat(24), kind: "image", prompt: "y".repeat(601) }).success).toBe(false);
    expect(GenRequestS.safeParse({ projectId: "a".repeat(24), kind: "image", prompt: "ok ok", aspect: "7:3" }).success).toBe(false);
    expect(GenRequestS.safeParse({ projectId: "a".repeat(24), kind: "video", prompt: "ok ok", seconds: 5 }).success).toBe(false);
  });
});

describe("suggestions de l'IA et réglages", () => {
  const base = { words: {}, tracks: [], transitions: [] };
  it("la sortie IA sans suggestions reste valide (liste vide par défaut)", () => { expect(AiOutputS.parse(base).suggestions).toEqual([]); });
  it("suggestions valides acceptées, au plus 6, champs inconnus refusés", () => {
    expect(AiOutputS.parse({ ...base, suggestions: [{ kind: "image", prompt: "a paper plane over a city", reason: "illustre l'idée de départ", at: 1200, aspect: "9:16" }] }).suggestions.length).toBe(1);
    expect(AiOutputS.safeParse({ ...base, suggestions: Array.from({ length: 7 }, () => ({ kind: "image", prompt: "abc def" })) }).success).toBe(false);
    expect(AiOutputS.safeParse({ ...base, suggestions: [{ kind: "image", prompt: "abc def", extra: 1 }] }).success).toBe(false);
  });
  it("le prompt et le schéma de réponse ne parlent de suggestions que si la génération est activée", () => {
    expect(systemPrompt([], true)).toMatch(/SUGGESTIONS/); expect(systemPrompt([], false)).not.toMatch(/SUGGESTIONS/);
    expect((responseSchema([], true).properties as any).suggestions).toBeTruthy(); expect((responseSchema([], false).properties as any).suggestions).toBeUndefined();
  });
  it("réglages par défaut valides ; durée max bornée à 4–8 s", () => {
    expect(() => SettingsS.parse(DEFAULT_SETTINGS)).not.toThrow();
    expect(SettingsS.safeParse({ ...DEFAULT_SETTINGS, gen: { ...g, maxVideoSec: 12 } }).success).toBe(false);
    expect(SettingsS.safeParse({ ...DEFAULT_SETTINGS, gen: { ...g, maxVideoSec: 3 } }).success).toBe(false);
  });
});
