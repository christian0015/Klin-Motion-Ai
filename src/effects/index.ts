//src/effects/index.ts
/**
 * index.ts — REGISTRE : la seule source du catalogue d'effets.
 * Contient : un import par effet + une ligne dans EFFECTS ; helpers de lecture.
 * Ne contient PAS : logique de rendu, UI. Ajouter un effet = 1 fichier + 1 ligne ici.
 * Tout le reste (Inspector, prompt IA, enum de réponse, admin, rendu) est généré depuis cette liste.
 */
import type { EffectDef, EffectKind } from "@/lib/schema";
import vignette from "./vignette";
import bw from "./bw";
import frameNeon from "./frame_neon_v1";
import clothWave from "./cloth_wave_v1";
import tealOrange from "./teal_orange";
import popIn from "./pop_in";
import minimalClean from "./minimal_clean";
import cleanTitle from "./clean_title";
import glitchCut from "./glitch_cut";
import echo from "./echo_v1";
import delay from "./delay_v1";
import reverbRoom from "./reverb_room_v1";
import radioVoice from "./radio_voice_v1";
import autotune from "./autotune_v1";
import kenBurns from "./ken_burns_v1";

export const EFFECTS: EffectDef[] = [
  vignette, bw, frameNeon, clothWave, tealOrange, popIn, minimalClean, cleanTitle, glitchCut, kenBurns,
  // audio_fx (Web Audio) : appliqués aux clips vidéo et audio via `afx`
  echo, delay, reverbRoom, radioVoice, autotune,
  // ← phase 2 : une ligne par nouvel effet
];

export const registry = new Map(EFFECTS.map((e) => [e.id, e]));

/** Effet utilisable (existe ET non désactivé par l'admin). Les `deprecated` restent rendables. */
export function getEffect(id: string, disabled: ReadonlySet<string> = new Set()): EffectDef | undefined {
  const e = registry.get(id);
  return e && !disabled.has(id) ? e : undefined;
}
/** Effets proposés à l'IA / à l'éditeur : actifs, non désactivés, non dépréciés. */
export function activeEffects(disabled: readonly string[] = [], kind?: EffectKind): EffectDef[] {
  const off = new Set(disabled);
  return EFFECTS.filter((e) => e.status === "active" && !off.has(e.id) && (!kind || e.kind === kind));
}
