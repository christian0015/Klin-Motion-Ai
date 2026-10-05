//src/effects/radio_voice_v1.ts
/** radio_voice_v1 — audio_fx : voix de radio / téléphone (bande passante réduite + saturation douce). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "radio_voice_v1", kind: "audio_fx", status: "active", cost: "light",
  describe: "Voix de radio ou de téléphone, étroite et légèrement saturée ; pour une voix off, un appel ou un effet rétro.",
  params: z.object({
    low: z.number().min(100).max(1000).default(300),
    high: z.number().min(1500).max(8000).default(3400),
    drive: z.number().min(0).max(1).default(0.35),
    mix: z.number().min(0).max(1).default(1),
  }),
  audio: {
    build: ({ ctx, params }) => {
      const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), shaper = ctx.createWaveShaper();
      hp.type = "highpass"; hp.frequency.value = params.low; lp.type = "lowpass"; lp.frequency.value = params.high;
      const k = params.drive * 40, curve = new Float32Array(2048);
      for (let i = 0; i < curve.length; i++) { const x = (i * 2) / curve.length - 1; curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x)); }
      shaper.curve = curve; dry.gain.value = 1 - params.mix; wet.gain.value = params.mix * 0.9;
      input.connect(dry); dry.connect(output); input.connect(hp); hp.connect(lp); lp.connect(shaper); shaper.connect(wet); wet.connect(output);
      return { input, output };
    },
  },
});
