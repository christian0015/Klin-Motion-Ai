//src/effects/reverb_room_v1.ts
/** reverb_room_v1 — audio_fx : réverbération de pièce (convolution avec une réponse bruitée à décroissance). Bruit déterministe (pas de Math.random). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "reverb_room_v1", kind: "audio_fx", status: "active", cost: "light",
  describe: "Réverbération de pièce qui donne de l'espace à la voix ou à la musique ; pour un son plus naturel ou plus grand.",
  params: z.object({
    size: z.number().min(0.3).max(4).default(1.4),
    decay: z.number().min(1).max(6).default(3),
    mix: z.number().min(0).max(1).default(0.3),
  }),
  audio: {
    build: ({ ctx, params }) => {
      const sr = ctx.sampleRate, len = Math.max(1, Math.round(sr * params.size)), ir = ctx.createBuffer(2, len, sr);
      let seed = 12345;
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; d[i] = ((seed / 4294967296) * 2 - 1) * Math.pow(1 - i / len, params.decay); }
      }
      const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), conv = ctx.createConvolver();
      conv.buffer = ir; dry.gain.value = 1; wet.gain.value = params.mix;
      input.connect(dry); dry.connect(output); input.connect(conv); conv.connect(wet); wet.connect(output);
      return { input, output };
    },
  },
});
