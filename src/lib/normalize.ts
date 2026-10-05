//src/lib/normalize.ts
/**
 * normalize.ts — garantit que tous les temps du document sont des ENTIERS (ms) ≥ 0 : le schéma l'exige.
 * Contient : normalizeTimes(doc) — mute un objet simple OU un brouillon immer, sans rien écrire quand la valeur est déjà bonne
 *            (donc aucun patch parasite dans l'historique).
 * Ne contient PAS : validation (schema.ts) ni logique de timeline (engine.ts).
 * Appelé après CHAQUE modification du document (store.apply) et à la lecture (migrate) : un glisser-déposer à la souris produit des
 * décimales, elles sont arrondies ici et jamais ailleurs.
 */
const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : v);
const setIf = (o: any, k: string, v: unknown) => { if (o[k] !== v) o[k] = v; };
const fixArr = (o: any, k: string) => { const a = o[k]; if (!Array.isArray(a)) return; const r = a.map(ms); if (r.some((x, i) => x !== a[i])) o[k] = r; };

/** Arrondit le temps (1er élément) de toutes les images clés `{kf: [[t, v, …], …]}` trouvées dans `o`. */
function roundKf(o: any): void {
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o)) { for (const x of o) roundKf(x); return; }
  if (Array.isArray(o.kf)) { for (const k of o.kf) if (Array.isArray(k)) setIf(k, "0", ms(k[0])); return; }
  for (const v of Object.values(o)) roundKf(v);
}

export function normalizeTimes(doc: any): void {
  if (!doc || typeof doc !== "object") return;
  for (const k of ["w", "h", "fps"]) if (doc.canvas && typeof doc.canvas[k] === "number") setIf(doc.canvas, k, Math.round(doc.canvas[k]));
  for (const a of Object.values<any>(doc.assets ?? {})) {
    if (a && typeof a.dur === "number") setIf(a, "dur", ms(a.dur));
    for (const w of a?.words ?? []) { setIf(w, "s", ms(w.s)); setIf(w, "e", ms(w.e)); }
  }
  roundKf(doc.grade);
  for (const t of doc.tracks ?? []) for (const c of t.clips ?? []) {
    if (c.at !== undefined) setIf(c, "at", ms(c.at));
    if (c.dur !== undefined) setIf(c, "dur", ms(c.dur));
    fixArr(c, "src"); fixArr(c, "fade");
    if (c.anchor) { if (typeof c.anchor.offset === "number") setIf(c.anchor, "offset", Math.round(c.anchor.offset)); if (c.anchor.dur !== undefined) setIf(c.anchor, "dur", ms(c.anchor.dur)); }
    if (c.counter?.dur !== undefined) setIf(c.counter, "dur", ms(c.counter.dur));
    if (c.reveal?.stagger !== undefined) setIf(c.reveal, "stagger", ms(c.reveal.stagger));
    roundKf(c);
  }
  for (const x of doc.transitions ?? []) { if (x.dur !== undefined) setIf(x, "dur", ms(x.dur)); roundKf(x.params); }
}
