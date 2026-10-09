//src/lib/shapes.ts
/**
 * shapes.ts — petits outils de dessin partagés par les gabarits de formes (shape_preset, moteur canvas 2D).
 * Contient : clamp01, inOut (apparition/disparition), roundRect, quadPoint/quadLength, strokeProgress (tracé progressif), number formatting.
 * Ne contient PAS : le moindre état ni aléa : tout est une fonction du temps local `t` (le rendu doit être identique en aperçu et à l'export).
 */
import { ease } from "./engine";

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Visibilité 0→1 sur `inMs` au début, 1→0 sur les `outMs` finales (clip de durée `dur`). */
export const inOut = (t: number, dur: number, inMs = 450, outMs = 350) => ease("outCubic", clamp01(t / inMs)) * ease("inCubic", clamp01((dur - t) / outMs));

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + k, y); g.lineTo(x + w - k, y); g.quadraticCurveTo(x + w, y, x + w, y + k); g.lineTo(x + w, y + h - k);
  g.quadraticCurveTo(x + w, y + h, x + w - k, y + h); g.lineTo(x + k, y + h); g.quadraticCurveTo(x, y + h, x, y + h - k); g.lineTo(x, y + k); g.quadraticCurveTo(x, y, x + k, y); g.closePath();
}
export const quadPoint = (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number): [number, number] => {
  const u = 1 - t; return [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1];
};
export function quadLength(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): number {
  let len = 0, [px, py] = [x0, y0];
  for (let i = 1; i <= 24; i++) { const [x, y] = quadPoint(x0, y0, cx, cy, x1, y1, i / 24); len += Math.hypot(x - px, y - py); px = x; py = y; }
  return len;
}
/** Tracé progressif : la ligne n'est dessinée que sur la fraction `p` (0..1) de sa longueur. Remettre `setLineDash([])` ensuite. */
export function strokeProgress(g: CanvasRenderingContext2D, len: number, p: number) { g.setLineDash([Math.max(0.01, len * p), len * 2 + 1]); g.lineDashOffset = 0; }
/** 12345 → « 12 345 » (espace fine insécable). */
export const spaced = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
