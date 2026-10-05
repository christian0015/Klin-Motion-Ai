//src/effects/ken_burns_v1.ts
/** ken_burns_v1 — motion_preset : zoom lent avec léger glissement sur toute la durée du clip (idéal pour animer une photo fixe). */
import { defineEffect } from "@/lib/schema";
import { ease } from "@/lib/engine";

export default defineEffect({
  id: "ken_burns_v1", kind: "motion_preset", status: "active", cost: "light",
  describe: "Zoom lent avec léger glissement, pour donner vie à une photo ou une image fixe (effet Ken Burns).",
  motion: ({ t, dur }) => { const p = ease("inOutQuad", dur > 0 ? t / dur : 0); return { scale: 1 + 0.14 * p, dx: -0.02 * p, dy: -0.012 * p }; },
});
