//src/lib/media.ts
/**
 * media.ts — CLIENT : fetch API, lecture des métadonnées (probe), empreinte, sources locales (mémoire → OPFS → cloud),
 *            proxy d'analyse, envoi en arrière-plan reprenable (R2, URL signées).
 * Contient : api, ApiError, probe, fingerprint, remember, getFile, makeProxy, uploadBlob, importRush.
 * Ne contient PAS : état global (store.ts), rendu (render.tsx), appels serveur à Gemini.
 * Jamais d'ArrayBuffer complet pour un rush : on garde des objets File (adossés au disque) et on copie par flux dans OPFS.
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, WavOutputFormat, WebMOutputFormat, canEncodeAudio, canEncodeVideo } from "mediabunny";
import type { VideoAsset } from "./schema";

/* ───── API ───── */
export class ApiError extends Error {
  constructor(public status: number, msg: string, public data: any = {}, public retryAfter = 0) { super(msg); }
}
export async function api<T = any>(path: string, method = "GET", body?: unknown, extra?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method, credentials: "same-origin", ...extra,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 304) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Erreur ${res.status}`, data, Number(res.headers.get("Retry-After") ?? 0));
  return data as T;
}

/* ───── Empreinte et sources locales ───── */
const mem = new Map<string, File | Blob>();            // fp → fichier (mémoire)
export async function fingerprint(file: File): Promise<string> {
  const edge = 64 * 1024;
  const head = new Uint8Array(await file.slice(0, edge).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - edge)).arrayBuffer());
  const meta = new TextEncoder().encode(`${file.size}|${file.name}|${file.lastModified}`);
  const all = new Uint8Array(meta.length + head.length + tail.length);
  all.set(meta, 0); all.set(head, meta.length); all.set(tail, meta.length + head.length);
  const h = await crypto.subtle.digest("SHA-256", all);
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hasOpfs = () => typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
async function opfsPut(fp: string, file: Blob) {
  if (!hasOpfs()) return;
  try {
    const dir = await navigator.storage.getDirectory(); const fh = await dir.getFileHandle(fp, { create: true });
    if (!("createWritable" in fh)) return;                       // Safari : pas d'écriture sur le thread principal
    const w = await (fh as any).createWritable(); await file.stream().pipeTo(w);
  } catch { /* quota ou navigateur limité : on garde la mémoire */ }
}
async function opfsGet(fp: string): Promise<File | null> {
  if (!hasOpfs()) return null;
  try { const dir = await navigator.storage.getDirectory(); return await (await dir.getFileHandle(fp)).getFile(); } catch { return null; }
}
/** Mémorise le fichier (mémoire + copie OPFS persistante). */
export async function remember(fp: string, file: File) {
  mem.set(fp, file);
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  await opfsPut(fp, file);
}
export const hasLocal = async (fp: string) => mem.has(fp) || !!(await opfsGet(fp));

/** Source d'un asset : mémoire → OPFS → téléchargement depuis `remote` (visible et compté côté serveur). */
export async function getFile(projectId: string, assetId: string, asset: { fp?: string; remote?: string; bytes?: number }, onDownload?: () => void): Promise<Blob | null> {
  const fp = asset.fp ?? "";
  const m = mem.get(fp); if (m) return m;
  const o = await opfsGet(fp); if (o) { mem.set(fp, o); return o; }
  if (!asset.remote) return null;
  onDownload?.();
  const { url } = await api("upload/sign", "POST", { projectId, assetId, kind: "original", action: "get", size: asset.bytes || 1, type: "video/mp4" });
  const r = await fetch(url); if (!r.ok) return null;
  const blob = await r.blob(); mem.set(fp, blob); void opfsPut(fp, blob);
  return blob;
}

/* ───── Métadonnées ───── */
export interface Probed { w: number; h: number; dur: number; fps: number; rot: 0 | 90 | 180 | 270; hasAudio: boolean; bytes: number; fp: string; codec: string; decodable: boolean }
export async function probe(file: File): Promise<Probed> {
  const fp = await fingerprint(file);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const v = await input.getPrimaryVideoTrack();
    if (!v) throw new Error("Aucune piste vidéo dans ce fichier.");
    const a = await input.getPrimaryAudioTrack();
    const dur = await input.computeDuration();
    let fps = 30;
    try { const st = await v.computePacketStats(120); if (st.averagePacketRate > 1) fps = Math.round(st.averagePacketRate * 100) / 100; } catch { /* défaut 30 */ }
    const rot = ([0, 90, 180, 270].includes(v.rotation as number) ? v.rotation : 0) as 0 | 90 | 180 | 270;
    let decodable = true;
    try { decodable = await v.canDecode(); } catch { decodable = false; }
    return { w: v.displayWidth, h: v.displayHeight, dur: Math.round(dur * 1000), fps, rot, hasAudio: !!a, bytes: file.size, fp, codec: v.codec ?? "inconnu", decodable };
  } finally { input.dispose(); }
}

/* ───── Forme d'onde : crêtes par tranche de 50 ms, calculées en flux (jamais le fichier entier en mémoire) ───── */
const peaksCache = new Map<string, Float32Array>();
export async function audioPeaks(blob: Blob, key: string): Promise<Float32Array> {
  const hit = peaksCache.get(key); if (hit) return hit;
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack(); if (!track) throw new Error("Aucune piste audio.");
    const dur = Math.max(0.05, await input.computeDuration()), buckets = Math.min(4000, Math.max(60, Math.ceil(dur * 20)));
    const peaks = new Float32Array(buckets), sink = new AudioBufferSink(track);
    for await (const wb of sink.buffers()) {
      const ch = wb.buffer.getChannelData(0), sr = wb.buffer.sampleRate, step = Math.max(1, Math.floor(sr / 800));
      for (let i = 0; i < ch.length; i += step) {
        const b = Math.min(buckets - 1, Math.floor(((wb.timestamp + i / sr) / dur) * buckets)), v = Math.abs(ch[i]);
        if (v > peaks[b]) peaks[b] = v;
      }
    }
    peaksCache.set(key, peaks); return peaks;
  } finally { input.dispose(); }
}

/* ───── Audio (musique) : durée + empreinte ───── */
export async function probeAudio(file: File): Promise<{ dur: number; fp: string }> {
  const fp = await fingerprint(file);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.getPrimaryAudioTrack())) throw new Error("Aucune piste audio dans ce fichier.");
    return { dur: Math.round((await input.computeDuration()) * 1000), fp };
  } finally { input.dispose(); }
}

/* ───── Image : dimensions + empreinte ───── */
export async function probeImage(file: File): Promise<{ w: number; h: number; fp: string }> {
  const fp = await fingerprint(file);
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new Error(`« ${file.name} » : image illisible (formats : PNG, JPEG, WebP, GIF, AVIF).`); }
  const r = { w: bmp.width, h: bmp.height, fp }; bmp.close();
  if (r.w > 16384 || r.h > 16384) throw new Error(`« ${file.name} » : image trop grande (16384 px maximum).`);
  return r;
}

/** Image réduite pour l'IA (JPEG, grand côté ≤ maxSide) : l'original reste intact. */
export async function makeImageProxy(file: Blob, maxSide: number): Promise<Blob> {
  const bmp = await createImageBitmap(file), k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const g = cv.getContext("2d")!; g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h); bmp.close();   // fond blanc : le JPEG n'a pas d'alpha
  return await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("Compression de l'image impossible."))), "image/jpeg", 0.82));
}
/** Son réduit pour l'IA : WAV mono 16 kHz (≈ 2 Mo par minute), lisible partout et sans WebCodecs. */
export async function makeAudioProxy(file: Blob, onProgress?: (p: number) => void): Promise<Blob> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
    const conv = await Conversion.init({ input, output, video: { discard: true }, audio: { numberOfChannels: 1, sampleRate: 16_000, codec: "pcm-s16" } });
    if (!conv.isValid) throw new Error("Impossible de préparer ce son pour l'analyse (format non lisible).");
    conv.onProgress = (p) => onProgress?.(p);
    await conv.execute();
    return new Blob([output.target.buffer!], { type: "audio/wav" });
  } finally { input.dispose(); }
}

/* ───── Proxy d'analyse (client) : l'original reste intact ───── */
const PROXY_FORMATS = [
  { fmt: "mp4", v: "avc", a: "aac", mime: "video/mp4" },
  { fmt: "webm", v: "vp9", a: "opus", mime: "video/webm" },
  { fmt: "webm", v: "vp8", a: "opus", mime: "video/webm" },
] as const;
const WHY: Record<string, string> = {
  undecodable_source_codec: "le navigateur ne sait pas décoder ce fichier (souvent HEVC/H.265 d'un iPhone ou d'une caméra)",
  unknown_source_codec: "codec vidéo inconnu",
  no_encodable_target_codec: "le navigateur ne peut pas encoder le proxy",
};
/** Renvoie un Blob dont `.type` est le vrai type MIME (mp4 ou webm selon ce que le navigateur sait encoder). */
export async function makeProxy(file: Blob, a: Pick<VideoAsset, "w" | "h" | "hasAudio">, cfg: { proxyShortSide: number; proxyFps: number }, onProgress?: (p: number) => void): Promise<Blob> {
  if (typeof VideoEncoder === "undefined") throw new Error("Votre navigateur ne gère pas WebCodecs : utilisez Chrome ou Edge récent sur ordinateur pour préparer l'analyse.");
  const k = cfg.proxyShortSide / Math.min(a.w, a.h), even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const width = even(a.w * k), height = even(a.h * k);
  let pick: (typeof PROXY_FORMATS)[number] | null = null;
  for (const o of PROXY_FORMATS) {
    if (!(await canEncodeVideo(o.v, { width, height, bitrate: 350_000 }).catch(() => false))) continue;
    if (a.hasAudio && !(await canEncodeAudio(o.a, { numberOfChannels: 1, sampleRate: 48_000, bitrate: 32_000 }).catch(() => false))) continue;
    pick = o; break;
  }
  if (!pick) throw new Error("Ce navigateur ne peut encoder ni H.264 ni VP9 : utilisez Chrome ou Edge à jour sur ordinateur.");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const output = new Output({ format: pick.fmt === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(), target: new BufferTarget() });
    const conv = await Conversion.init({
      input, output,
      video: { width, height, fit: "fill", frameRate: cfg.proxyFps, bitrate: 350_000, codec: pick.v },
      audio: { numberOfChannels: 1, sampleRate: 48_000, bitrate: 32_000, codec: pick.a },
    });
    if (!conv.isValid) {
      const why = [...new Set(conv.discardedTracks.map((d) => WHY[d.reason] ?? d.reason))].join(" ; ") || "aucune piste exploitable";
      throw new Error(`Impossible de préparer ce fichier pour l'analyse : ${why}. Convertissez la vidéo en H.264 (MP4) ou essayez avec Chrome/Edge sur ordinateur.`);
    }
    conv.onProgress = (p) => onProgress?.(p);
    await conv.execute();
    return new Blob([output.target.buffer!], { type: pick.mime });
  } finally { input.dispose(); }
}

/* ───── Envoi en arrière-plan (reprenable) ───── */
export async function uploadBlob(
  blob: Blob, o: { projectId: string; assetId: string; kind: "original" | "proxy"; type: string; fp: string },
  onProgress?: (p: number) => void,
): Promise<string> {
  const base = { projectId: o.projectId, assetId: o.assetId, kind: o.kind, size: blob.size, type: o.type };
  const mpKey = `mi-up:${o.fp}:${o.kind}`;
  if (blob.size <= 50 * 1024 ** 2) {
    const { url, key } = await api("upload/sign", "POST", { ...base, action: "put" });
    const r = await fetch(url, { method: "PUT", body: blob, headers: { "Content-Type": o.type } });
    if (!r.ok) throw new Error("Envoi vers le stockage refusé.");
    await api("upload/sign", "POST", { ...base, action: "done" });
    onProgress?.(1); return key;
  }
  let st: { uploadId: string; key: string; partSize: number; parts: { PartNumber: number; ETag: string }[] } | null = null;
  try { st = JSON.parse(localStorage.getItem(mpKey) ?? "null"); } catch { st = null; }
  if (!st) { const init = await api("upload/sign", "POST", { ...base, action: "init" }); st = { ...init, parts: [] }; }
  const total = Math.ceil(blob.size / st!.partSize);
  for (let n = 1; n <= total; n++) {
    if (st!.parts.some((p) => p.PartNumber === n)) { onProgress?.(n / total); continue; }
    const chunk = blob.slice((n - 1) * st!.partSize, n * st!.partSize);
    for (let attempt = 0; ; attempt++) {
      try {
        const { url } = await api("upload/sign", "POST", { ...base, action: "part", partNumber: n, uploadId: st!.uploadId });
        const r = await fetch(url, { method: "PUT", body: chunk });
        const etag = r.headers.get("ETag"); if (!r.ok || !etag) throw new Error("part");
        st!.parts.push({ PartNumber: n, ETag: etag }); localStorage.setItem(mpKey, JSON.stringify(st)); break;
      } catch (e) { if (attempt >= 3) throw new Error("Envoi interrompu : il reprendra où il s'est arrêté."); await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
    }
    onProgress?.(n / total);
  }
  await api("upload/sign", "POST", { ...base, action: "complete", uploadId: st!.uploadId, parts: st!.parts });
  localStorage.removeItem(mpKey);
  return st!.key;
}

/** Import complet d'un rush : métadonnées + mémorisation locale. L'envoi cloud est lancé par l'appelant (non bloquant). */
export async function importRush(file: File) {
  const p = await probe(file);
  await remember(p.fp, file);
  return { ...p, name: file.name };
}
