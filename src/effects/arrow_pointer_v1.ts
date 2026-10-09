//src/effects/arrow_pointer_v1.ts
/** arrow_pointer_v1 — shape_preset : flèche courbe qui se trace d'un point à un autre et se termine par une pointe. */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
import { clamp01, quadLength, strokeProgress } from "@/lib/shapes";
import { ease } from "@/lib/engine";

export default defineEffect({
  id: "arrow_pointer_v1", kind: "shape_preset", engine: "canvas", status: "active", cost: "light",
  describe: "Flèche courbe qui se dessine pour désigner un élément de l'image ; pour attirer le regard sur un détail.",
  params: z.object({
    x1: z.number().min(0).max(1).default(0.25), y1: z.number().min(0).max(1).default(0.3), x2: z.number().min(0).max(1).default(0.6), y2: z.number().min(0).max(1).default(0.5),
    curve: z.number().min(-1).max(1).default(0.35), color: z.string().default("#FFFFFF"), thickness: z.number().min(0.004).max(0.03).default(0.008), head: z.number().min(0.01).max(0.08).default(0.035),
  }),
  draw({ g, w, h, t, dur, params: p }) {
    const prog = ease("outCubic", clamp01(t / 700)), alpha = clamp01((dur - t) / 300); if (prog <= 0 || alpha <= 0) return;
    const X1 = p.x1 * w, Y1 = p.y1 * h, X2 = p.x2 * w, Y2 = p.y2 * h, dx = X2 - X1, dy = Y2 - Y1, cx = (X1 + X2) / 2 - dy * p.curve * 0.5, cy = (Y1 + Y2) / 2 + dx * p.curve * 0.5;
    g.globalAlpha = alpha; g.lineCap = "round"; g.lineJoin = "round"; g.lineWidth = p.thickness * w; g.strokeStyle = p.color;
    strokeProgress(g, quadLength(X1, Y1, cx, cy, X2, Y2), prog);
    g.beginPath(); g.moveTo(X1, Y1); g.quadraticCurveTo(cx, cy, X2, Y2); g.stroke(); g.setLineDash([]);
    if (prog > 0.9) {   // pointe, alignée sur la tangente d'arrivée
      const a = Math.atan2(Y2 - cy, X2 - cx), L = p.head * w, k = (prog - 0.9) / 0.1;
      g.beginPath(); g.moveTo(X2 - Math.cos(a - 0.5) * L * k, Y2 - Math.sin(a - 0.5) * L * k); g.lineTo(X2, Y2); g.lineTo(X2 - Math.cos(a + 0.5) * L * k, Y2 - Math.sin(a + 0.5) * L * k); g.stroke();
    }
    g.globalAlpha = 1;
  },
});
