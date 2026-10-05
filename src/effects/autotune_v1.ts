//src/effects/autotune_v1.ts
/**
 * autotune_v1 — audio_fx : correction de hauteur vers la note la plus proche d'une gamme (AudioWorklet, voir lib/dsp.ts).
 * strength 1 + speed 0 = effet « robot » ; strength 0.6 + speed 80 ms = correction discrète. Latence ≈ 20 ms.
 * Réglages constants sur la durée du clip. Fonctionne sur une voix SEULE (une musique polyphonique donne un résultat instable).
 */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
import { AUTOTUNE_WORKLET_SRC, KEYS, SCALES, ensureWorklet } from "@/lib/dsp";

export default defineEffect({
  id: "autotune_v1", kind: "audio_fx", status: "active", cost: "heavy",
  describe: "Autotune : ramène la voix chantée ou parlée sur les notes d'une gamme ; effet robot à fond, correction discrète en douceur.",
  params: z.object({
    key: z.enum(KEYS).default("C"),
    scale: z.enum(["chromatic", "major", "minor", "pentatonic"]).default("chromatic"),
    strength: z.number().min(0).max(1).default(1),
    speed: z.number().min(0).max(400).default(25),
    mix: z.number().min(0).max(1).default(1),
  }),
  audio: {
    setup: (ctx) => ensureWorklet(ctx, "mia-autotune", AUTOTUNE_WORKLET_SRC),
    build: ({ ctx, params }) => {
      const node = new AudioWorkletNode(ctx, "mia-autotune", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
        processorOptions: { key: KEYS.indexOf(params.key), scale: SCALES[params.scale] ?? null, strength: params.strength, speed: params.speed, mix: params.mix },
      });
      return { input: node, output: node };
    },
  },
});
