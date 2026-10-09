//src/effects/badge_pop_v1.ts
/** badge_pop_v1 — shape_preset : pastille colorée avec un mot (« NOUVEAU », « PROMO »…) qui apparaît avec un rebond. */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
import { clamp01, roundRect } from "@/lib/shapes";
import { ease } from "@/lib/engine";

export default defineEffect({
  id: "badge_pop_v1", kind: "shape_preset", engine: "canvas", status: "active", cost: "light",
  describe: "Pastille colorée avec un mot court qui surgit avec un rebond ; pour signaler une nouveauté, une promo ou un point clé.",
  fonts: ['800 60px "Instrument Sans"'],
  params: z.object({
    text: z.string().default("NOUVEAU"), color: z.string().default("#0B0910"), background: z.string().default("#FFD84D"),
    x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.2), size: z.number().min(0.5).max(2).default(1),
  }),
  draw({ g, w, h, t, dur, params: p }) {
    const sc = ease("outBack", clamp01(t / 380)), a = clamp01((dur - t) / 250); if (sc <= 0.001 || a <= 0) return;
    const s = w * 0.06 * p.size; g.font = `800 ${s}px "Instrument Sans", system-ui, sans-serif`;
    const tw = g.measureText(p.text).width, bw = tw + s * 1.4, bh = s * 1.8;
    g.save(); g.globalAlpha = a; g.translate(p.x * w, p.y * h); g.scale(sc, sc);
    g.fillStyle = p.background; roundRect(g, -bw / 2, -bh / 2, bw, bh, bh / 2); g.fill();
    g.fillStyle = p.color; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(p.text, 0, s * 0.04); g.restore();
  },
});
