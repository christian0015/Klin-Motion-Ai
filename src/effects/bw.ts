//src/effects/bw.ts
/** bw — fx : noir et blanc contrasté. Souvent utilisé via un calque d'effet (adjustment) sur une séquence. */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "bw", kind: "fx", status: "active", cost: "light",
  describe: "Passe l'image en noir et blanc contrasté ; pour un moment grave, un flashback ou une révélation.",
  params: z.object({
    amount: z.number().min(0).max(1).default(1),
    contrast: z.number().min(0.5).max(2).default(1.2),
  }),
  shader: /* glsl */ `
    vec4 fx(vec2 uv) {
      vec4 c = texture2D(tMap, uv);
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      l = clamp((l - 0.5) * contrast + 0.5, 0.0, 1.0);
      return vec4(mix(c.rgb, vec3(l), amount), c.a);
    }`,
});
