//src/effects/lower_third_v1.ts
/** lower_third_v1 — shape_preset : tiers inférieur (nom + fonction) : une barre d'accent grandit, le bandeau se révèle, le texte suit. */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
import { inOut } from "@/lib/shapes";

export default defineEffect({
  id: "lower_third_v1", kind: "shape_preset", engine: "canvas", status: "active", cost: "light",
  describe: "Bandeau de présentation en bas d'écran (nom et fonction) qui se révèle en douceur ; pour introduire une personne qui parle.",
  fonts: ['800 60px "Instrument Sans"', '500 36px "Instrument Sans"'],
  params: z.object({
    title: z.string().default("Nom Prénom"), subtitle: z.string().default("Titre ou fonction"),
    color: z.string().default("#FFFFFF"), accent: z.string().default("#FF4F7B"), background: z.string().default("#0B0910"),
    y: z.number().min(0.1).max(0.95).default(0.78), size: z.number().min(0.5).max(2).default(1),
  }),
  draw({ g, w, h, t, dur, params: p }) {
    const v = inOut(t, dur); if (v <= 0.001) return;
    const s = w * 0.05 * p.size, x0 = w * 0.06, y0 = h * p.y, bar = s * 0.2, bh = s * 2.5;
    g.textBaseline = "alphabetic";
    g.font = `800 ${s}px "Instrument Sans", system-ui, sans-serif`; const tw = g.measureText(p.title).width;
    g.font = `500 ${s * 0.6}px "Instrument Sans", system-ui, sans-serif`; const sw = g.measureText(p.subtitle).width;
    const bw = Math.max(tw, sw) + s * 1.2;
    g.fillStyle = p.accent; g.fillRect(x0, y0, bar, bh * v);
    g.save(); g.beginPath(); g.rect(x0 + bar, y0 - 2, bw * v, bh + 4); g.clip();
    g.globalAlpha = 0.88; g.fillStyle = p.background; g.fillRect(x0 + bar, y0, bw, bh); g.globalAlpha = 1;
    g.fillStyle = p.color; g.font = `800 ${s}px "Instrument Sans", system-ui, sans-serif`; g.fillText(p.title, x0 + bar + s * 0.5, y0 + s * 1.2);
    g.fillStyle = p.accent; g.font = `500 ${s * 0.6}px "Instrument Sans", system-ui, sans-serif`; g.fillText(p.subtitle, x0 + bar + s * 0.5, y0 + s * 2);
    g.restore();
  },
});
