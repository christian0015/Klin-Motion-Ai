//src/effects/circle_callout_v1.ts
/** circle_callout_v1 — shape_preset : ellipse tracée au feutre autour d'un point, pour entourer un élément. */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
import { clamp01 } from "@/lib/shapes";
import { ease } from "@/lib/engine";

export default defineEffect({
  id: "circle_callout_v1", kind: "shape_preset", engine: "canvas", status: "active", cost: "light",
  describe: "Cercle tracé à la main autour d'un élément de l'image ; pour entourer un objet, un chiffre ou un visage.",
  params: z.object({
    x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.45), rx: z.number().min(0.02).max(0.6).default(0.2), ry: z.number().min(0.02).max(0.6).default(0.12),
    color: z.string().default("#FF4F7B"), thickness: z.number().min(0.003).max(0.03).default(0.008),
  }),
  draw({ g, w, h, t, dur, params: p }) {
    const prog = ease("outCubic", clamp01(t / 700)), alpha = clamp01((dur - t) / 300); if (prog <= 0 || alpha <= 0) return;
    g.globalAlpha = alpha; g.lineCap = "round"; g.lineWidth = p.thickness * w; g.strokeStyle = p.color;
    g.beginPath(); g.ellipse(p.x * w, p.y * h, p.rx * w, p.ry * h, -0.08, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); g.stroke(); g.globalAlpha = 1;
  },
});
