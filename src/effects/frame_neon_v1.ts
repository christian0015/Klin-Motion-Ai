//src/effects/frame_neon_v1.ts
/** frame_neon_v1 — overlay : cadre lumineux néon plein cadre (shader plein écran, pur en fonction du temps). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "frame_neon_v1", kind: "overlay", status: "active", cost: "light",
  describe: "Cadre néon lumineux autour de l'image ; pour un passage punchy, une intro ou un mot choc (utiliser avec blend add).",
  params: z.object({
    color: z.string().default("#00F0FF"),
    thickness: z.number().min(0.002).max(0.03).default(0.008),
    glow: z.number().min(0).max(1).default(0.6),
    pulse: z.number().min(0).max(1).default(0.3),
    inset: z.number().min(0).max(0.15).default(0.035),
  }),
  shader: /* glsl */ `
    vec4 fx(vec2 uv) {
      vec2 p = min(uv, 1.0 - uv) * uRes;
      float d = min(p.x, p.y);
      float m = min(uRes.x, uRes.y);
      float th = thickness * m;
      float e = abs(d - inset * m);
      float core = 1.0 - smoothstep(th * 0.5, th, e);
      float halo = exp(-e / (th * 6.0)) * glow;
      float pul = 1.0 + pulse * 0.5 * sin(uTime * 9.42);
      float a = clamp(core + halo * 0.5, 0.0, 1.0);
      return vec4(color * (core + halo * 0.6) * pul, a);
    }`,
});
