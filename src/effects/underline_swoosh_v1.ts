//src/effects/underline_swoosh_v1.ts
/** underline_swoosh_v1 — shape_preset : soulignement manuscrit qui se trace d'un coup de pinceau (tracé progressif). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
import { clamp01, quadLength, strokeProgress } from "@/lib/shapes";
import { ease } from "@/lib/engine";

export default defineEffect({
  id: "underline_swoosh_v1", kind: "shape_preset", engine: "canvas", status: "active", cost: "light",
  describe: "Soulignement qui se trace d'un geste sous un mot clé ; pour mettre en valeur un titre ou une expression importante.",
  params: z.object({
    x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.62), width: z.number().min(0.1).max(1).default(0.5),
    color: z.string().default("#FFD84D"), thickness: z.number().min(0.004).max(0.04).default(0.012), curve: z.number().min(0).max(1).default(0.35),
  }),
  draw({ g, w, h, t, dur, params: p }) {
    const prog = ease("outCubic", clamp01(t / 600)), alpha = clamp01((dur - t) / 300); if (prog <= 0 || alpha <= 0) return;
    const x0 = w * (p.x - p.width / 2), x1 = w * (p.x + p.width / 2), y = h * p.y, cx = (x0 + x1) / 2, cy = y + p.curve * h * 0.03, y0 = y + h * 0.008, y1 = y - h * 0.006;
    g.globalAlpha = alpha; g.lineCap = "round"; g.lineWidth = p.thickness * w; g.strokeStyle = p.color;
    strokeProgress(g, quadLength(x0, y0, cx, cy, x1, y1), prog);
    g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(cx, cy, x1, y1); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
  },
});
