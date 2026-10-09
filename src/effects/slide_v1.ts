//src/effects/slide_v1.ts
/** slide_v1 — transition : le plan sortant glisse hors du cadre pendant que le suivant entre par le côté opposé. */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "slide_v1", kind: "transition", status: "active", cost: "light",
  describe: "Le plan glisse hors du cadre et le suivant arrive du côté opposé ; pour un enchaînement dynamique et rythmé.",
  params: z.object({ dir: z.number().min(0).max(3).default(0) }),   // 0 gauche, 1 droite, 2 haut, 3 bas
  shader: /* glsl */ `
    vec4 fx(vec2 uv) {
      float p = smoothstep(0.0, 1.0, uProgress);
      vec2 v = dir < 0.5 ? vec2(-1.0, 0.0) : dir < 1.5 ? vec2(1.0, 0.0) : dir < 2.5 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
      vec2 uf = uv - v * p;
      vec2 ut = uv - v * (p - 1.0);
      bool inFrom = uf.x >= 0.0 && uf.x <= 1.0 && uf.y >= 0.0 && uf.y <= 1.0;
      return inFrom ? texture2D(tFrom, uf) : texture2D(tTo, ut);
    }`,
});
