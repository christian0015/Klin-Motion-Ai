//src/effects/progress_bar_v1.ts
/** progress_bar_v1 — shape_preset : barre de progression qui se remplit sur toute la durée du clip (rétention, compte à rebours). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
import { clamp01, roundRect } from "@/lib/shapes";

export default defineEffect({
  id: "progress_bar_v1", kind: "shape_preset", engine: "canvas", status: "active", cost: "light",
  describe: "Barre de progression qui se remplit pendant toute la durée du clip ; pour garder l'attention ou annoncer une fin.",
  params: z.object({
    y: z.number().min(0.02).max(0.99).default(0.93), height: z.number().min(0.006).max(0.05).default(0.016), margin: z.number().min(0).max(0.2).default(0.06),
    color: z.string().default("#FF4F7B"), track: z.string().default("#FFFFFF"), trackAlpha: z.number().min(0).max(1).default(0.2),
  }),
  draw({ g, w, h, t, dur, params: p }) {
    const x = w * p.margin, bw = w * (1 - 2 * p.margin), bh = Math.max(2, h * p.height), y = h * p.y, v = clamp01(t / Math.max(1, dur)), a = clamp01(t / 250);
    g.globalAlpha = a * p.trackAlpha; g.fillStyle = p.track; roundRect(g, x, y, bw, bh, bh / 2); g.fill();
    g.globalAlpha = a; g.fillStyle = p.color; if (v > 0) { roundRect(g, x, y, Math.max(bh, bw * v), bh, bh / 2); g.fill(); } g.globalAlpha = 1;
  },
});
