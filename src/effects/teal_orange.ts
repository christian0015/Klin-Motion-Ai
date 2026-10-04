//src/effects/teal_orange.ts
/** teal_orange — lut : look cinéma (ombres froides, hautes lumières chaudes). Utilise uAmount (grade.amount). */
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "teal_orange", kind: "lut", status: "active", cost: "light",
  describe: "Look cinéma teal & orange : ombres froides, peaux chaudes. Le choix par défaut pour un rendu cinématique.",
  shader: /* glsl */ `
    vec4 fx(vec2 uv) {
      vec4 c = texture2D(tMap, uv);
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      vec3 cool = c.rgb * vec3(0.82, 1.0, 1.12);
      vec3 warm = c.rgb * vec3(1.16, 1.0, 0.84);
      vec3 o = mix(cool, warm, smoothstep(0.2, 0.75, l));
      return vec4(mix(c.rgb, o, uAmount), c.a);
    }`,
});
