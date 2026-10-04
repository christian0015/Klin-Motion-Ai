//src/effects/minimal_clean.ts
/** minimal_clean — caption_style (canvas) : sous-titres propres par groupes de mots, mot actif surligné. */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "minimal_clean", kind: "caption_style", engine: "canvas", status: "active", cost: "light",
  describe: "Sous-titres sobres, 3-4 mots à la fois, mot prononcé surligné ; le choix par défaut pour une personne qui parle.",
  fonts: ['800 60px "Instrument Sans"'],
  params: z.object({
    size: z.number().min(0.5).max(2).default(1),
    color: z.string().default("#FFFFFF"),
    highlight: z.string().default("#FFD84D"),
    y: z.number().min(0.3).max(0.95).default(0.76),
  }),
  draw({ g, w, h, t, text, words, params }) {
    const list = words?.length ? words : text.split(/\s+/).filter(Boolean).map((x, i) => ({ t: x, s: i * 300, e: i * 300 + 300 }));
    if (!list.length) return;
    let idx = list.findIndex((x) => t >= x.s && t < x.e);
    if (idx < 0) idx = Math.max(0, list.findLastIndex((x) => x.s <= t));
    const size = Math.round(w * 0.075 * params.size), chunk = 4, from = Math.floor(idx / chunk) * chunk;
    const group = list.slice(from, from + chunk);
    g.font = `800 ${size}px "Instrument Sans", system-ui, sans-serif`;
    g.textBaseline = "middle"; g.lineJoin = "round";
    const gap = size * 0.28, widths = group.map((x) => g.measureText(x.t).width);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (group.length - 1);
    let x = (w - total) / 2; const y = h * params.y;
    group.forEach((wd, i) => {
      g.lineWidth = size * 0.2; g.strokeStyle = "rgba(0,0,0,0.85)"; g.strokeText(wd.t, x, y);
      g.fillStyle = from + i === idx ? params.highlight : params.color; g.fillText(wd.t, x, y);
      x += widths[i] + gap;
    });
  },
});
