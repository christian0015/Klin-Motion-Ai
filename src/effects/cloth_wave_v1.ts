//src/effects/cloth_wave_v1.ts
/** cloth_wave_v1 — mesh : la vidéo ondule comme un drap (déformation de sommets, plan subdivisé). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "cloth_wave_v1", kind: "mesh", status: "active", cost: "light",
  describe: "Fait onduler l'image comme un drap dans le vent ; pour une transition poétique ou un moment onirique.",
  params: z.object({
    amp: z.number().min(0).max(0.3).default(0.05),
    freq: z.number().min(0.5).max(6).default(2),
    speed: z.number().min(0).max(3).default(0.6),
  }),
  mesh: {
    segments: [48, 48],
    vertex: /* glsl */ `
      vec3 deform(vec3 p, vec2 uv) {
        float k = amp * uRes.y * 0.36; // relatif à la hauteur : identique en preview (540) et export (1080+)
        float ph = uv.x * freq * 6.2831 + uTime * speed * 6.2831;
        p.z += sin(ph) * k * (0.3 + uv.y);
        p.y += cos(ph) * k * 0.2;
        p.x += sin(uv.y * freq * 6.2831 + uTime * speed * 6.2831) * k * 0.15;
        return p;
      }`,
  },
});
