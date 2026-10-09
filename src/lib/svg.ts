//src/lib/svg.ts
/**
 * svg.ts — lecture d'un fichier SVG pour le dessiner en canvas : éléments convertis en chemins, couleurs et transformations résolues,
 *          longueur de chaque chemin (pour le tracé progressif).
 * Contient : parseTransform, shapeToPath, pathLength (PURS, testés), parseSvg (utilise DOMParser : navigateur seulement).
 * Ne contient PAS : le dessin lui-même (effects/svg_draw_v1.ts) ni la sécurité par injection : le SVG n'est JAMAIS inséré dans la page,
 * on ne lit que des attributs géométriques et des couleurs. Ignorés : texte, dégradés, filtres, masques, <use>, images, scripts.
 * Les arcs d'un chemin (commande A) sont mesurés par leur corde : le tracé progressif y est légèrement approximatif.
 */
import type { ParsedSvg, SvgItem } from "./schema";

export type Mat = [number, number, number, number, number, number];
export const IDENT: Mat = [1, 0, 0, 1, 0, 0];
export const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const nums = (s: string) => (s.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);

/** Attribut `transform` SVG (translate, scale, rotate, skewX, skewY, matrix, dans l'ordre d'écriture) → matrice [a b c d e f]. */
export function parseTransform(str: string | null | undefined): Mat {
  let m: Mat = IDENT;
  for (const [, name, args] of (str ?? "").matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const n = nums(args); let t: Mat = IDENT;
    if (name === "translate") t = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0];
    else if (name === "scale") t = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
    else if (name === "rotate") { const a = ((n[0] ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), r: Mat = [c, s, -s, c, 0, 0]; t = n.length >= 3 ? mul(mul([1, 0, 0, 1, n[1], n[2]], r), [1, 0, 0, 1, -n[1], -n[2]]) : r; }
    else if (name === "skewX") t = [1, 0, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (name === "skewY") t = [1, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    else if (name === "matrix" && n.length >= 6) t = [n[0], n[1], n[2], n[3], n[4], n[5]];
    m = mul(m, t);
  }
  return m;
}

const K = 0.5522847498;   // approximation d'un quart de cercle par une courbe de Bézier cubique
const f = (n: number) => +n.toFixed(3);
/** Forme de base SVG (rect, circle, ellipse, line, polyline, polygon) → données de chemin `d` (sans arcs : seulement des courbes de Bézier). */
export function shapeToPath(tag: string, a: (k: string) => number, pts?: string): string | null {
  if (tag === "rect") {
    const x = a("x"), y = a("y"), w = a("width"), h = a("height"); if (w <= 0 || h <= 0) return null;
    const rx = Math.min(a("rx") || a("ry"), w / 2), ry = Math.min(a("ry") || a("rx"), h / 2);
    if (!rx && !ry) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
    const kx = rx * K, ky = ry * K;
    return `M${f(x + rx)} ${f(y)}H${f(x + w - rx)}C${f(x + w - rx + kx)} ${f(y)} ${f(x + w)} ${f(y + ry - ky)} ${f(x + w)} ${f(y + ry)}V${f(y + h - ry)}C${f(x + w)} ${f(y + h - ry + ky)} ${f(x + w - rx + kx)} ${f(y + h)} ${f(x + w - rx)} ${f(y + h)}H${f(x + rx)}C${f(x + rx - kx)} ${f(y + h)} ${f(x)} ${f(y + h - ry + ky)} ${f(x)} ${f(y + h - ry)}V${f(y + ry)}C${f(x)} ${f(y + ry - ky)} ${f(x + rx - kx)} ${f(y)} ${f(x + rx)} ${f(y)}Z`;
  }
  if (tag === "circle" || tag === "ellipse") {
    const cx = a("cx"), cy = a("cy"), rx = tag === "circle" ? a("r") : a("rx"), ry = tag === "circle" ? a("r") : a("ry"); if (rx <= 0 || ry <= 0) return null;
    const kx = rx * K, ky = ry * K;
    return `M${f(cx + rx)} ${f(cy)}C${f(cx + rx)} ${f(cy + ky)} ${f(cx + kx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}C${f(cx - kx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ky)} ${f(cx - rx)} ${f(cy)}C${f(cx - rx)} ${f(cy - ky)} ${f(cx - kx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}C${f(cx + kx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ky)} ${f(cx + rx)} ${f(cy)}Z`;
  }
  if (tag === "line") return `M${f(a("x1"))} ${f(a("y1"))}L${f(a("x2"))} ${f(a("y2"))}`;
  if (tag === "polyline" || tag === "polygon") {
    const n = nums(pts ?? ""); if (n.length < 4) return null;
    let d = `M${n[0]} ${n[1]}`; for (let i = 2; i + 1 < n.length; i += 2) d += `L${n[i]} ${n[i + 1]}`;
    return tag === "polygon" ? d + "Z" : d;
  }
  return null;
}

/** Longueur d'un chemin (unités locales). Courbes échantillonnées ; arcs mesurés par leur corde. */
export function pathLength(d: string): number {
  const tokens = [...d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi)].map((m) => (m[1] ? m[1] : Number(m[2])));
  let i = 0, len = 0, x = 0, y = 0, sx = 0, sy = 0, cmd = "", lcx = 0, lcy = 0, lastC = "";
  const num = () => Number(tokens[i++]);
  const seg = (nx: number, ny: number) => { len += Math.hypot(nx - x, ny - y); x = nx; y = ny; };
  const cubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    let px = x, py = y; for (let k = 1; k <= 24; k++) { const t = k / 24, u = 1 - t, nx = u ** 3 * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3, ny = u ** 3 * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3; len += Math.hypot(nx - px, ny - py); px = nx; py = ny; }
    lcx = x2; lcy = y2; x = x3; y = y3;
  };
  const quad = (x1: number, y1: number, x2: number, y2: number) => {
    let px = x, py = y; for (let k = 1; k <= 20; k++) { const t = k / 20, u = 1 - t, nx = u * u * x + 2 * u * t * x1 + t * t * x2, ny = u * u * y + 2 * u * t * y1 + t * t * y2; len += Math.hypot(nx - px, ny - py); px = nx; py = ny; }
    lcx = x1; lcy = y1; x = x2; y = y2;
  };
  while (i < tokens.length) {
    if (typeof tokens[i] === "string") cmd = tokens[i++] as string;
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === "Z") { seg(sx, sy); lastC = "Z"; continue; }
    if (typeof tokens[i] !== "number") break;
    if (C === "M") { const nx = ox + num(), ny = oy + num(); x = nx; y = ny; sx = nx; sy = ny; cmd = rel ? "l" : "L"; }
    else if (C === "L") seg(ox + num(), oy + num());
    else if (C === "H") seg((rel ? x : 0) + num(), y);
    else if (C === "V") seg(x, (rel ? y : 0) + num());
    else if (C === "C") { const a = ox + num(), b = oy + num(), c = ox + num(), dd = oy + num(), e = ox + num(), g = oy + num(); cubic(a, b, c, dd, e, g); }
    else if (C === "S") { const rx = lastC === "C" || lastC === "S" ? 2 * x - lcx : x, ry = lastC === "C" || lastC === "S" ? 2 * y - lcy : y; const c = ox + num(), dd = oy + num(), e = ox + num(), g = oy + num(); cubic(rx, ry, c, dd, e, g); }
    else if (C === "Q") { const a = ox + num(), b = oy + num(), e = ox + num(), g = oy + num(); quad(a, b, e, g); }
    else if (C === "T") { const rx = lastC === "Q" || lastC === "T" ? 2 * x - lcx : x, ry = lastC === "Q" || lastC === "T" ? 2 * y - lcy : y; quad(rx, ry, ox + num(), oy + num()); }
    else if (C === "A") { i += 5; seg(ox + num(), oy + num()); }
    else break;
    lastC = C;
  }
  return len;
}

const SKIP = new Set(["defs", "style", "script", "foreignobject", "image", "text", "tspan", "mask", "clippath", "filter", "lineargradient", "radialgradient", "symbol", "title", "desc", "metadata", "use", "pattern", "marker"]);
const SAFE_COLOR = /^[#\w(),.%\s+-]{1,60}$/;
const color = (v: string | null | undefined, fallback: string | null): string | null => {
  if (v === undefined || v === null || v.trim() === "") return fallback;
  const c = v.trim();
  if (c === "none" || c === "transparent") return null;
  if (c === "currentColor" || c.startsWith("url(")) return fallback ?? "#888888";   // dégradés non gérés : couleur neutre
  return SAFE_COLOR.test(c) ? c : fallback;
};
const styleOf = (el: Element) => { const o: Record<string, string> = {}; for (const part of (el.getAttribute("style") ?? "").split(";")) { const [k, v] = part.split(":"); if (k && v) o[k.trim()] = v.trim(); } return o; };

/** Lit un SVG (texte). Lève une erreur claire si le fichier est illisible. Navigateur seulement (DOMParser). */
export function parseSvg(text: string): ParsedSvg {
  if (text.length > 2_000_000) throw new Error("Fichier SVG trop volumineux (2 Mo maximum).");
  const doc = new DOMParser().parseFromString(text, "image/svg+xml"), root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) throw new Error("Fichier SVG illisible.");
  const vb = nums(root.getAttribute("viewBox") ?? ""), w = vb.length === 4 ? vb[2] : parseFloat(root.getAttribute("width") ?? "") || 100, h = vb.length === 4 ? vb[3] : parseFloat(root.getAttribute("height") ?? "") || 100;
  const items: SvgItem[] = [];
  const walk = (el: Element, inh: { fill: string | null; stroke: string | null; sw: number; opacity: number }, m: Mat) => {
    for (const ch of Array.from(el.children)) {
      const tag = ch.nodeName.toLowerCase().replace(/^.*:/, ""); if (SKIP.has(tag) || items.length >= 2000) continue;
      const st = styleOf(ch), at = (k: string) => st[k] ?? ch.getAttribute(k);
      const cur = { fill: color(at("fill"), inh.fill), stroke: color(at("stroke"), inh.stroke), sw: at("stroke-width") !== null ? parseFloat(at("stroke-width")!) || inh.sw : inh.sw, opacity: inh.opacity * (at("opacity") !== null ? Math.min(1, Math.max(0, parseFloat(at("opacity")!) || 0)) : 1) };
      const cm = mul(m, parseTransform(ch.getAttribute("transform")));
      if (tag === "g" || tag === "svg" || tag === "a") { walk(ch, cur, cm); continue; }
      const d = tag === "path" ? ch.getAttribute("d") : shapeToPath(tag, (k) => parseFloat(ch.getAttribute(k) ?? "0") || 0, ch.getAttribute("points") ?? undefined);
      if (d && d.length < 200_000) items.push({ d, fill: cur.fill, stroke: cur.stroke, sw: cur.sw, opacity: cur.opacity, m: cm, len: Math.max(1, pathLength(d)) });
    }
  };
  walk(root, { fill: "#000000", stroke: null, sw: 1, opacity: 1 }, vb.length === 4 ? [1, 0, 0, 1, -vb[0], -vb[1]] : IDENT);
  if (!items.length) throw new Error("Ce SVG ne contient aucune forme exploitable (le texte, les dégradés et les images ne sont pas gérés).");
  return { w, h, items };
}
