//src/effects/svg_draw_v1.ts
/** svg_draw_v1 — shape_preset : dessine un fichier SVG importé (tracé progressif du contour, puis remplissage). Jamais proposé à l'IA (il exige un fichier). */
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
import { clamp01 } from "@/lib/shapes";
import { ease } from "@/lib/engine";

export default defineEffect({
  id: "svg_draw_v1", kind: "shape_preset", engine: "canvas", status: "active", cost: "light", aiHidden: true,
  describe: "Dessine un fichier SVG importé : le contour se trace puis la forme se remplit. Glissez un SVG depuis l'onglet Médias sur une piste Formes.",
  params: z.object({
    size: z.number().min(0.05).max(1.5).default(0.5), x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.5),
    draw: z.number().min(0).max(1).default(1), intro: z.number().min(0).max(3000).default(900),
    tint: z.boolean().default(false), color: z.string().default("#FFFFFF"), strokeWidth: z.number().min(0).max(20).default(0),
  }),
  draw({ g, w, h, t, params: p, svg }) {
    if (!svg) return;
    const sc = (w * p.size) / svg.w, ox = w * p.x - (svg.w * sc) / 2, oy = h * p.y - (svg.h * sc) / 2;
    const prog = clamp01((p.intro > 0 ? ease("outCubic", clamp01(t / p.intro)) : 1) * p.draw), fillA = prog >= 1 ? 1 : clamp01((prog - 0.7) / 0.3);
    for (const it of svg.items) {
      g.save(); g.translate(ox, oy); g.scale(sc, sc); g.transform(it.m[0], it.m[1], it.m[2], it.m[3], it.m[4], it.m[5]);
      const path = new Path2D(it.d), fill = p.tint ? p.color : it.fill, stroke = p.tint ? p.color : it.stroke;
      if (fill && fillA > 0) { g.globalAlpha = it.opacity * fillA; g.fillStyle = fill; g.fill(path); }
      const sc2 = stroke ?? (prog < 1 && fill ? fill : null);
      if (sc2 && (prog < 1 || it.stroke) && prog > 0) {
        g.globalAlpha = it.opacity; g.strokeStyle = sc2; g.lineJoin = "round"; g.lineCap = "round";
        g.lineWidth = p.strokeWidth > 0 ? p.strokeWidth / sc : it.stroke ? it.sw : Math.max(1, svg.w / 200);
        g.setLineDash([Math.max(0.01, it.len * prog), it.len * 2 + 1]); g.stroke(path);
      }
      g.restore();
    }
  },
});
