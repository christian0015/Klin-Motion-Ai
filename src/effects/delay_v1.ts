//src/effects/delay_v1.ts
/** delay_v1 — audio_fx : un seul retard « slapback » (une répétition nette, sans rétroaction). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "delay_v1", kind: "audio_fx", status: "active", cost: "light",
  describe: "Une seule répétition nette de la voix, légèrement décalée ; pour épaissir un son ou un effet rétro.",
  params: z.object({
    time: z.number().min(20).max(600).default(140),
    mix: z.number().min(0).max(1).default(0.5),
  }),
  audio: {
    build: ({ ctx, params }) => {
      const input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain(), delay = ctx.createDelay(1);
      delay.delayTime.value = params.time / 1000; wet.gain.value = params.mix;
      input.connect(output); input.connect(delay); delay.connect(wet); wet.connect(output);
      return { input, output };
    },
  },
});
