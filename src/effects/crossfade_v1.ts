//src/effects/crossfade_v1.ts
/** crossfade_v1 — transition : fondu enchaîné doux (courbe adoucie) entre deux clips qui se chevauchent. */
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "crossfade_v1", kind: "transition", status: "active", cost: "light",
  describe: "Fondu enchaîné doux entre deux plans ; la transition discrète par défaut pour un enchaînement naturel.",
  shader: /* glsl */ `
    vec4 fx(vec2 uv) {
      return mix(texture2D(tFrom, uv), texture2D(tTo, uv), smoothstep(0.0, 1.0, uProgress));
    }`,
});
