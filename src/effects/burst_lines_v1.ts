//src/effects/burst_lines_v1.ts
/** burst_lines_v1 — shape_preset : traits qui jaillissent d'un point en rayons, puis s'estompent (impact, emphase). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
import { clamp01 } from "@/lib/shapes";
import { ease } from "@/lib/engine";

export default defineEffect({
  id: "burst_lines_v1", kind: "shape_preset", engine: "canvas", status: "active", cost: "light",
  describe: "Traits en rayons qui jaillissent d'un point puis s'estompent ; pour souligner un impact, une idée ou un mot choc.",
  params: z.object({
    x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.5), count: z.number().min(6).max(32).default(14),
    inner: z.number().min(0.01).max(0.3).default(0.05), outer: z.number().min(0.05).max(0.8).default(0.22),
    color: z.string().default("#FFD84D"), thickness: z.number().min(0.002).max(0.02).default(0.006),
  }),
  draw({ g, w, h, t, params: p }) {
    const k = ease("outExpo", clamp01(t / 550)), fade = 1 - clamp01((t - 300) / 500); if (fade <= 0) return;
    const n = Math.round(p.count), r0 = p.inner * w, span = (p.outer - p.inner) * w;
    g.globalAlpha = fade; g.lineCap = "round"; g.lineWidth = p.thickness * w; g.strokeStyle = p.color; g.beginPath();
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), from = r0 + span * 0.35 * k, to = r0 + span * k; g.moveTo(p.x * w + c * from, p.y * h + s * from); g.lineTo(p.x * w + c * to, p.y * h + s * to); }
    g.stroke(); g.globalAlpha = 1;
  },
});
