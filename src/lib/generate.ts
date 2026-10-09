//src/lib/generate.ts
/**
 * generate.ts — règles de la génération de médias par IA : tarification, formats, validation. PUR : importé côté serveur ET côté client
 * (l'interface affiche le coût avant de confirmer). Ne contient PAS : appels à Google (gemini.ts), jobs et stockage (route API).
 */
import { z } from "zod";
import type { GenConfig } from "./schema";

export const IMAGE_ASPECTS = ["9:16", "16:9", "1:1", "4:5"] as const;
export const VIDEO_ASPECTS = ["9:16", "16:9"] as const;
export const VIDEO_SECONDS = [4, 6, 8] as const;

export const GenRequestS = z.strictObject({
  projectId: z.string().regex(/^[a-f0-9]{24}$/),
  kind: z.enum(["image", "video"]),
  prompt: z.string().trim().min(3, "Décrivez ce que vous voulez générer.").max(600),
  aspect: z.enum(IMAGE_ASPECTS).default("9:16"),
  seconds: z.union([z.literal(4), z.literal(6), z.literal(8)]).optional(),
});
export type GenRequest = z.infer<typeof GenRequestS>;

/** Crédits d'une génération : fixe pour une image, proportionnel à la durée pour une vidéo. */
export function genCost(g: GenConfig, kind: "image" | "video", seconds = 0): number {
  return kind === "image" ? g.imageCredits : Math.max(1, Math.round(g.videoCreditsPerSec * seconds));
}
/** Coût réel estimé en dollars (pour la marge dans l'admin). */
export const genCostUsd = (usd: { usdPerImage: number; usdPerVideoSec: number }, kind: "image" | "video", seconds = 0) =>
  kind === "image" ? usd.usdPerImage : usd.usdPerVideoSec * seconds;

/** Vérifie une demande selon les réglages ; renvoie le message à afficher si elle est refusée. */
export function checkGenRequest(g: GenConfig, r: GenRequest, opts: { hasPaid: boolean }): { ok: true; seconds: number; credits: number } | { ok: false; status: number; msg: string } {
  if (!g.enabled) return { ok: false, status: 403, msg: "La génération de médias est désactivée pour le moment." };
  if (r.kind === "image") return { ok: true, seconds: 0, credits: genCost(g, "image") };
  if (!g.videoEnabled) return { ok: false, status: 403, msg: "La génération de vidéos n'est pas disponible actuellement." };
  if (g.videoPaidOnly && !opts.hasPaid) return { ok: false, status: 402, msg: "La génération de vidéos est réservée aux comptes ayant acheté des crédits." };
  if (!(VIDEO_ASPECTS as readonly string[]).includes(r.aspect)) return { ok: false, status: 400, msg: "Les vidéos générées sont disponibles en 9:16 ou 16:9." };
  const seconds = Math.min(r.seconds ?? g.maxVideoSec, g.maxVideoSec);
  return { ok: true, seconds, credits: genCost(g, "video", seconds) };
}
