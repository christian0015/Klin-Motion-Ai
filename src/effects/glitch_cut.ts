//src/effects/glitch_cut.ts
/** glitch_cut — transition : coupe « glitch » (bandes décalées + séparation RGB) entre deux clips qui se chevauchent. */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "glitch_cut", kind: "transition", status: "active", cost: "light",
  describe: "Coupe glitch nerveuse (bandes décalées, couleurs séparées) entre deux plans ; pour un enchaînement rythmé ou un changement de sujet.",
  params: z.object({ intensity: z.number().min(0).max(2).default(1) }),
  shader: /* glsl */ `
    vec4 fx(vec2 uv) {
      float p = uProgress;
      float k = sin(p * 3.14159) * intensity;
      float row = floor(uv.y * 24.0);
      float j = (hash(vec2(row, floor(uTime * 30.0))) - 0.5) * k * 0.2;
      vec2 u = vec2(uv.x + j, uv.y);
      float s = k * 0.02;
      vec4 a = vec4(texture2D(tFrom, u + vec2(s, 0.0)).r, texture2D(tFrom, u).g, texture2D(tFrom, u - vec2(s, 0.0)).b, texture2D(tFrom, u).a);
      vec4 b = vec4(texture2D(tTo, u + vec2(s, 0.0)).r, texture2D(tTo, u).g, texture2D(tTo, u - vec2(s, 0.0)).b, texture2D(tTo, u).a);
      float cut = step(0.5, p + (hash(vec2(row, 7.0)) - 0.5) * 0.3 * k);
      return mix(a, b, cut);
    }`,
});
