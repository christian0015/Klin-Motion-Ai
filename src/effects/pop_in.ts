//src/effects/pop_in.ts
/** pop_in — motion_preset : apparition avec rebond (échelle + opacité), sortie en fondu. Pur en fonction de t. */
import { defineEffect } from "@/lib/schema";
import { ease } from "@/lib/engine";

export default defineEffect({
  id: "pop_in", kind: "motion_preset", status: "active", cost: "light",
  describe: "Le texte ou l'élément apparaît avec un petit rebond ; pour un mot clé ou un titre.",
  motion: ({ t, dur }) => ({
    scale: 0.55 + 0.45 * ease("outBack", t / 320),
    opacity: Math.min(1, t / 140) * Math.min(1, Math.max(0, (dur - t) / 140)),
  }),
});
