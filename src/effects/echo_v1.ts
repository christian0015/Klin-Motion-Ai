//src/effects/echo_v1.ts
/** echo_v1 — audio_fx : écho qui se répète en s'estompant (retard avec rétroaction filtrée). Graphe Web Audio pur, sans état global. */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "echo_v1", kind: "audio_fx", status: "active", cost: "light",
  describe: "Écho qui se répète en s'estompant ; pour une voix dans un grand espace ou un mot qui doit résonner.",
  params: z.object({
    time: z.number().min(60).max(1000).default(320),
    feedback: z.number().min(0).max(0.9).default(0.45),
    mix: z.number().min(0).max(1).default(0.4),
    tone: z.number().min(800).max(12000).default(4000),
  }),
  audio: {
    build: ({ ctx, params }) => {
      const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const delay = ctx.createDelay(1.5), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
      delay.delayTime.value = params.time / 1000; fb.gain.value = params.feedback; wet.gain.value = params.mix;
      lp.type = "lowpass"; lp.frequency.value = params.tone;
      input.connect(dry); dry.connect(output);
      input.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay);   // boucle de rétroaction
      lp.connect(wet); wet.connect(output);
      return { input, output };
    },
  },
});
