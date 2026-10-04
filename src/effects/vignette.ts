//src/effects/vignette.ts
/** vignette — fx : assombrit les bords. Fichier d'exemple du contrat (1 fichier + 1 ligne dans index.ts). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "vignette", kind: "fx", status: "active", cost: "light",
  describe: "Assombrit les bords pour concentrer le regard ; à utiliser sur un plan serré ou une phrase importante.",
  params: z.object({
    intensity: z.number().min(0).max(1).default(0.55),
    softness: z.number().min(0.1).max(1).default(0.6),
  }),
  shader: /* glsl */ `
    vec4 fx(vec2 uv) {
      vec4 c = texture2D(tMap, uv);
      float d = distance(uv, vec2(0.5));
      float v = 1.0 - intensity * smoothstep(0.25, 0.25 + softness, d);
      return vec4(c.rgb * v, c.a);
    }`,
});
