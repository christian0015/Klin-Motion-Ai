//src/effects/stat_counter_v1.ts
/** stat_counter_v1 — shape_preset : grand chiffre qui monte jusqu'à sa valeur, avec une légende (statistique choc). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
import { clamp01, inOut, spaced } from "@/lib/shapes";
import { ease } from "@/lib/engine";

export default defineEffect({
  id: "stat_counter_v1", kind: "shape_preset", engine: "canvas", status: "active", cost: "light",
  describe: "Gros chiffre qui défile jusqu'à sa valeur finale avec une légende ; pour une statistique, un résultat ou un pourcentage.",
  fonts: ['800 60px "Instrument Sans"', '500 36px "Instrument Sans"'],
  params: z.object({
    from: z.number().min(0).max(999999).default(0), to: z.number().min(0).max(999999).default(100), prefix: z.string().default(""), suffix: z.string().default("%"),
    label: z.string().default("de croissance"), color: z.string().default("#FFFFFF"), accent: z.string().default("#FF4F7B"),
    y: z.number().min(0.1).max(0.9).default(0.42), size: z.number().min(0.5).max(2).default(1),
  }),
  draw({ g, w, h, t, dur, params: p }) {
    const v = inOut(t, dur, 350, 300); if (v <= 0.001) return;
    const n = p.from + (p.to - p.from) * ease("outExpo", clamp01(t / 1400)), s = w * 0.2 * p.size, y = h * p.y;
    g.globalAlpha = v; g.textAlign = "center"; g.textBaseline = "alphabetic"; g.lineJoin = "round";
    g.font = `800 ${s}px "Instrument Sans", system-ui, sans-serif`; const txt = `${p.prefix}${spaced(n)}${p.suffix}`;
    g.lineWidth = s * 0.08; g.strokeStyle = "rgba(0,0,0,0.6)"; g.strokeText(txt, w / 2, y); g.fillStyle = p.color; g.fillText(txt, w / 2, y);
    g.font = `500 ${s * 0.26}px "Instrument Sans", system-ui, sans-serif`; g.fillStyle = p.accent; g.fillText(p.label, w / 2, y + s * 0.34);
    g.textAlign = "left"; g.globalAlpha = 1;
  },
});
