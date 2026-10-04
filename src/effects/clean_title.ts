//src/effects/clean_title.ts
/** clean_title — text_style (canvas) : titre centré avec révélation optionnelle (lettres/mots) qui monte en fondu. */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "clean_title", kind: "text_style", engine: "canvas", status: "active", cost: "light",
  describe: "Titre net et centré, avec révélation lettre par lettre ou mot par mot possible ; pour un mot ou une phrase d'accroche.",
  fonts: ['800 60px "Instrument Sans"'],
  params: z.object({
    size: z.number().min(0.4).max(3).default(1),
    color: z.string().default("#FFFFFF"),
    y: z.number().min(0.05).max(0.95).default(0.4),
  }),
  draw({ g, w, h, t, text, params, reveal }) {
    const size = Math.round(w * 0.11 * params.size);
    g.font = `800 ${size}px "Instrument Sans", system-ui, sans-serif`;
    g.textBaseline = "middle"; g.lineJoin = "round";
    const units = reveal?.by === "words" ? text.split(/(\s+)/) : reveal ? [...text] : [text];
    const widths = units.map((u) => g.measureText(u).width);
    const total = widths.reduce((a, b) => a + b, 0);
    let x = (w - total) / 2; const y = h * params.y;
    units.forEach((u, i) => {
      const p = reveal ? Math.min(1, Math.max(0, (t - i * reveal.stagger) / 260)) : 1;
      g.globalAlpha = p; const oy = (1 - p) * size * 0.35;
      g.lineWidth = size * 0.12; g.strokeStyle = "rgba(0,0,0,0.7)"; g.strokeText(u, x, y + oy);
      g.fillStyle = params.color; g.fillText(u, x, y + oy);
      x += widths[i];
    });
    g.globalAlpha = 1;
  },
});
