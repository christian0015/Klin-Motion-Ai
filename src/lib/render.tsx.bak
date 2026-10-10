//src/lib/render.tsx
/**
 * render.tsx — pipeline de rendu « texture d'abord » + sources d'images + export MP4 (WebCodecs).
 * Contient : Compositor (render targets en réservoir, fx en ping-pong, présentation quad/mesh/corner pin, blend,
 *            adjustment, grade, transitions), PreviewSource (<video>), ExportSource (décodage exact), mixAudio, exportMp4.
 * Ne contient PAS : état de l'éditeur (store.ts), UI (Preview.tsx), maths du temps (engine.ts).
 * Le moteur est pur : tout est fonction de (doc, t). Aucune horloge, aucun aléa non seedé.
 * Non couverts en phase 1 (documenté README §12) : matte, behind, shape, Component R3F d'overlay, pivot.
 */
import * as THREE from "three";
import { ALL_FORMATS, AudioBufferSink, AudioBufferSource, BlobSource, BufferTarget, CanvasSink, CanvasSource, Input, Mp4OutputFormat, Output, QUALITY_HIGH } from "mediabunny";
import {
  buildFrameState, evalCol, evalNum, layoutDoc, resolveTransform, srcToTimeline, wordsOf,
  type FrameState, type Layer, type Layout,
} from "./engine";
import { coerceParams, constParams, paramSpecs, type ParsedSvg, type ShapeClip, type AudioClip, type CaptionClip, type Composition, type EffectDef, type FxRef, type TextClip, type VideoClip, DEFAULTS, type Ms } from "./schema";
import { getEffect } from "@/effects";
import { getFile } from "./media";
import { parseSvg } from "./svg";

/* ────────────────────────── Sources d'images ────────────────────────── */
export interface FrameSource {
  /** Prépare les images des clips visibles (async pour l'export : décodage exact). */
  prepare(state: FrameState): Promise<void> | void;
  /** Texture du clip vidéo (clé = id du clip). */
  texture(clipId: string): { tex: THREE.Texture; w: number; h: number } | null;
  /** Dessin SVG déjà chargé d'un asset (formes) ; null tant qu'il n'est pas lu. */
  svg?(assetId: string): ParsedSvg | null;
}

/** Preview : un <video> par clip, synchronisé sur l'horloge maître (audio inclus). */
export class PreviewSource implements FrameSource {
  private els = new Map<string, { el: HTMLVideoElement; tex: THREE.VideoTexture | null; url: string }>();
  private sfx = new Map<string, HTMLAudioElement>();
  private urls = new Map<string, string>();
  private loading = new Set<string>();
  private imgs = new Map<string, { tex: THREE.Texture; w: number; h: number }>();   // assetId → texture d'image fixe
  private imgLoading = new Set<string>();
  private clipAsset = new Map<string, string>();                                      // clipId → assetId (pour texture())
  private actx: AudioContext | null = null;                                       // contexte Web Audio (créé seulement si un effet audio est utilisé)
  private srcNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private chains = new Map<string, { sig: string; nodes: AudioNode[] }>();
  private building = new Set<string>();
  private failed = new Map<string, number>();   // assetId → date de l'échec : on ne réessaie qu'après 2,5 s
  constructor(private projectId: string, private getDoc: () => Composition, private onMissing?: (assetId: string) => void, private onProblem?: (assetId: string, msg: string) => void) {}

  private async urlFor(assetId: string): Promise<string | null> {
    const hit = this.urls.get(assetId); if (hit) return hit;
    if (this.loading.has(assetId)) return null;
    const f = this.failed.get(assetId); if (f && Date.now() - f < 2500) return null;
    const a = this.getDoc().assets[assetId]; if (!a || (a.type !== "video" && a.type !== "audio" && a.type !== "image")) return null;
    this.loading.add(assetId);
    const blob = await getFile(this.projectId, assetId, a as any);
    this.loading.delete(assetId);
    if (!blob) { this.failed.set(assetId, Date.now()); this.onMissing?.(assetId); return null; }
    const u = URL.createObjectURL(blob); this.urls.set(assetId, u); return u;
  }
  private el(clipId: string, assetId: string) {
    let e = this.els.get(clipId);
    if (!e) {
      const url = this.urls.get(assetId); if (!url) { void this.urlFor(assetId); return null; }
      const el = document.createElement("video"); el.src = url; el.playsInline = true; el.preload = "auto"; el.crossOrigin = "anonymous";
      el.addEventListener("error", () => this.onProblem?.(assetId, "Le navigateur ne peut pas lire cette vidéo (codec non pris en charge, souvent HEVC/H.265). Convertissez-la en H.264 (MP4)."));
      e = { el, tex: null, url }; this.els.set(clipId, e);
    }
    return e;
  }
  /** Image fixe : chargée une fois, texture partagée par tous les clips qui l'utilisent. */
  private ensureImage(assetId: string) {
    if (this.imgs.has(assetId) || this.imgLoading.has(assetId)) return;
    const url = this.urls.get(assetId); if (!url) { void this.urlFor(assetId); return; }
    this.imgLoading.add(assetId);
    const img = new Image();
    img.onload = () => { const tex = new THREE.Texture(img); tex.needsUpdate = true; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; this.imgs.set(assetId, { tex, w: img.naturalWidth, h: img.naturalHeight }); this.imgLoading.delete(assetId); };
    img.onerror = () => { this.imgLoading.delete(assetId); this.failed.set(assetId, Date.now()); this.onProblem?.(assetId, "Image illisible par ce navigateur (formats : PNG, JPEG, WebP, GIF, AVIF)."); };
    img.src = url;
  }
  /** Fait passer l'audio d'un élément par la chaîne d'effets audio du clip ; reconstruite seulement quand la liste d'effets change. */
  private routeAudio(key: string, el: HTMLMediaElement, afx: FxRef[] | undefined, durMs: number) {
    const cur = this.chains.get(key);
    if (!afx?.length && !cur) return;                                              // jamais routé, pas d'effet : sortie normale de l'élément
    const sig = JSON.stringify(afx ?? []);
    if (cur?.sig === sig || this.building.has(key)) return;
    this.building.add(key);
    void (async () => {
      let ctx: AudioContext | undefined, src: MediaElementAudioSourceNode | undefined;
      try {
        ctx = (this.actx ??= new AudioContext()); if (ctx.state === "suspended") await ctx.resume().catch(() => {});
        src = this.srcNodes.get(el); if (!src) { src = ctx.createMediaElementSource(el); this.srcNodes.set(el, src); }
        for (const n of cur?.nodes ?? []) { try { n.disconnect(); } catch { /* déjà détaché */ } }
        src.disconnect();
        const nodes: AudioNode[] = []; let last: AudioNode = src;
        for (const f of afx ?? []) {
          const def = getEffect(f.id); if (!def?.audio) continue;
          await def.audio.setup?.(ctx);
          const n = def.audio.build({ ctx, params: constParams(def, f.params), dur: durMs / 1000 });
          last.connect(n.input); nodes.push(n.input, n.output); last = n.output;
        }
        last.connect(ctx.destination); this.chains.set(key, { sig, nodes });
      } catch {
        // Filet : si un effet échoue (navigateur sans AudioWorklet…), l'audio est renvoyé tel quel vers la sortie : jamais de silence,
        // et la signature est mémorisée pour ne pas retenter à chaque image.
        try { if (src && ctx) { src.disconnect(); src.connect(ctx.destination); } } catch { /* rien de plus à faire */ }
        this.chains.set(key, { sig, nodes: [] });
      }
      finally { this.building.delete(key); }
    })();
  }
  private svgs = new Map<string, ParsedSvg>(); private svgLoading = new Set<string>();
  svg(assetId: string) { return this.svgs.get(assetId) ?? null; }
  private ensureSvg(assetId: string) {
    if (this.svgs.has(assetId) || this.svgLoading.has(assetId)) return;
    const f = this.failed.get(assetId); if (f && Date.now() - f < 2500) return;
    const a = this.getDoc().assets[assetId]; if (!a || a.type !== "svg") return;
    this.svgLoading.add(assetId);
    void (async () => {
      try {
        const blob = await getFile(this.projectId, assetId, a as { fp?: string; remote?: string; bytes?: number });
        if (!blob) { this.failed.set(assetId, Date.now()); this.onMissing?.(assetId); return; }
        this.svgs.set(assetId, parseSvg(await blob.text()));
      } catch (e) { this.failed.set(assetId, Date.now()); this.onProblem?.(assetId, (e as Error).message); }
      finally { this.svgLoading.delete(assetId); }
    })();
  }
  prepare(state: FrameState) { void state; }
  /** Appelé à chaque image par le Preview : aligne lecture/pause/position/volume sur l'horloge. */
  sync(state: FrameState, layout: Layout, playing: boolean, doc: Composition) {
    if (playing && this.actx?.state === "suspended") void this.actx.resume().catch(() => {});   // un contexte suspendu = son capté mais muet
    const live = new Set<string>();
    for (const l of state.layers) if (l.p.kind === "shape") { const sa = (l.p.clip as ShapeClip).shape.asset; if (sa) this.ensureSvg(sa); }
    for (const l of state.layers) {
      if (l.p.kind !== "video") continue;
      const c = l.p.clip as VideoClip; live.add(l.p.id); this.clipAsset.set(l.p.id, c.asset);
      if (doc.assets[c.asset]?.type === "image") { this.ensureImage(c.asset); continue; }
      const e = this.el(l.p.id, c.asset); if (!e) continue;
      this.routeAudio(l.p.id, e.el, c.afx, l.p.dur);
      const want = (l.srcMs ?? 0) / 1000, track = doc.tracks[l.p.trackIdx];
      e.el.muted = !!track?.muted || !(doc.assets[c.asset] as any)?.hasAudio;
      e.el.volume = Math.min(1, Math.max(0, evalNum(c.volume, l.local, 1)));
      e.el.playbackRate = Math.min(16, Math.max(0.0625, evalNum(c.speed, l.local, 1)));
      if (playing) { if (Math.abs(e.el.currentTime - want) > 0.3) e.el.currentTime = want; if (e.el.paused) void e.el.play().catch(() => {}); }
      else { if (!e.el.paused) e.el.pause(); if (Math.abs(e.el.currentTime - want) > 0.02) e.el.currentTime = want; }
    }
    for (const [id, e] of this.els) if (!live.has(id) && !e.el.paused) e.el.pause();
    // SFX / audio : lecture simple par élément <audio>
    for (const p of layout.list) {
      if (p.kind !== "audio" || !p.ok) continue;
      const c = p.clip as AudioClip; const active = state.t >= p.at && state.t < p.at + p.dur;
      let a = this.sfx.get(p.id);
      if (!a && active) {
        let url = this.urls.get(c.asset);
        if (c.asset.startsWith("sfx:")) url = getEffect(c.asset.slice(4))?.url;
        if (url) { a = new Audio(url); this.sfx.set(p.id, a); } else if (!c.asset.startsWith("sfx:")) void this.urlFor(c.asset);
      }
      if (!a) continue;
      this.routeAudio(p.id, a, c.afx, p.dur);
      a.volume = Math.min(1, Math.max(0, evalNum(c.gain, state.t - p.at, 1))); a.muted = !!doc.tracks[p.trackIdx]?.muted;
      if (active && playing) { if (a.paused) { a.currentTime = (state.t - p.at + (c.src?.[0] ?? 0)) / 1000; void a.play().catch(() => {}); } } else if (!a.paused) a.pause();
    }
  }
  texture(clipId: string) {
    const aid = this.clipAsset.get(clipId), im = aid ? this.imgs.get(aid) : undefined; if (im) return im;
    const e = this.els.get(clipId);
    if (!e || e.el.readyState < 2 || !e.el.videoWidth) return null;
    if (!e.tex) e.tex = new THREE.VideoTexture(e.el);
    e.tex.minFilter = THREE.LinearFilter; e.tex.generateMipmaps = false;
    return { tex: e.tex, w: e.el.videoWidth, h: e.el.videoHeight };
  }
  pauseAll() { for (const e of this.els.values()) e.el.pause(); for (const a of this.sfx.values()) a.pause(); }
  dispose() { this.pauseAll(); for (const e of this.els.values()) { e.tex?.dispose(); e.el.removeAttribute("src"); e.el.load(); } this.els.clear(); for (const i of this.imgs.values()) i.tex.dispose(); this.imgs.clear(); void this.actx?.close(); this.actx = null; for (const u of this.urls.values()) URL.revokeObjectURL(u); this.urls.clear(); }
}

/** Export : décodage exact à l'image (WebCodecs via mediabunny). */
export class ExportSource implements FrameSource {
  private sinks = new Map<string, { input: Input; sink: CanvasSink }>();
  private texs = new Map<string, { tex: THREE.CanvasTexture; w: number; h: number }>();
  constructor(private projectId: string) {}
  private async sinkFor(assetId: string, doc: Composition) {
    let s = this.sinks.get(assetId); if (s) return s;
    const a: any = doc.assets[assetId];
    const blob = await getFile(this.projectId, assetId, a);
    if (!blob) throw new Error(`Rush manquant : « ${a?.name ?? assetId} ». Redonnez le fichier depuis l'éditeur.`);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack(); if (!track) throw new Error("Piste vidéo illisible.");
    s = { input, sink: new CanvasSink(track) }; this.sinks.set(assetId, s); return s;
  }
  doc!: Composition;
  /** Image fixe : décodée une fois dans un canvas (l'orientation EXIF est appliquée par le navigateur). */
  private svgs = new Map<string, ParsedSvg>();
  svg(assetId: string) { return this.svgs.get(assetId) ?? null; }
  private async loadSvg(assetId: string) {
    if (this.svgs.has(assetId)) return;
    const a: any = this.doc.assets[assetId], blob = await getFile(this.projectId, assetId, a);
    if (!blob) throw new Error(`Dessin SVG manquant : « ${a?.name ?? assetId} ». Redonnez le fichier depuis l'éditeur.`);
    this.svgs.set(assetId, parseSvg(await blob.text()));
  }
  private async loadImage(clipId: string, assetId: string) {
    if (this.texs.has(clipId)) return;
    const a: any = this.doc.assets[assetId], blob = await getFile(this.projectId, assetId, a);
    if (!blob) throw new Error(`Image manquante : « ${a?.name ?? assetId} ». Redonnez le fichier depuis l'éditeur.`);
    const bmp = await createImageBitmap(blob), cv = document.createElement("canvas"); cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext("2d")!.drawImage(bmp, 0, 0); bmp.close();
    this.texs.set(clipId, { tex: new THREE.CanvasTexture(cv), w: cv.width, h: cv.height });
  }
  async prepare(state: FrameState) {
    for (const l of state.layers) {
      if (l.p.kind === "shape") { const sa = (l.p.clip as ShapeClip).shape.asset; if (sa) await this.loadSvg(sa); continue; }
      if (l.p.kind !== "video") continue;
      const c = l.p.clip as VideoClip;
      if (this.doc.assets[c.asset]?.type === "image") { await this.loadImage(l.p.id, c.asset); continue; }
      const { sink } = await this.sinkFor(c.asset, this.doc);
      const f = await sink.getCanvas((l.srcMs ?? 0) / 1000); if (!f) continue;
      const cv = f.canvas as HTMLCanvasElement;
      let t = this.texs.get(l.p.id);
      if (!t) { t = { tex: new THREE.CanvasTexture(cv), w: cv.width, h: cv.height }; this.texs.set(l.p.id, t); }
      t.tex.image = cv; t.tex.needsUpdate = true; t.w = cv.width; t.h = cv.height;
    }
  }
  texture(clipId: string) { const t = this.texs.get(clipId); return t ? { tex: t.tex, w: t.w, h: t.h } : null; }
  dispose() { for (const s of this.sinks.values()) s.input.dispose(); for (const t of this.texs.values()) t.tex.dispose(); this.sinks.clear(); this.texs.clear(); }
}

/* ────────────────────────── Compositor ────────────────────────── */
const HEAD = /* glsl */ `precision highp float; varying vec2 vUv; uniform sampler2D tMap; uniform float uTime; uniform vec2 uRes; uniform float uSeed; uniform float uAmount;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
`;
const FS_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const uniformDecl = (def: EffectDef) => paramSpecs(def).map((s) => (s.type === "number" || s.type === "boolean" ? `uniform float ${s.key};` : s.type === "color" ? `uniform vec3 ${s.key};` : "")).join("\n");
const hex3 = (c: string) => new THREE.Vector3(...[1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number]);
function paramUniforms(def: EffectDef, vals: Record<string, any>): Record<string, THREE.IUniform> {
  const u: Record<string, THREE.IUniform> = {};
  for (const s of paramSpecs(def)) {
    const v = vals[s.key];
    if (s.type === "number") u[s.key] = { value: v }; else if (s.type === "boolean") u[s.key] = { value: v ? 1 : 0 }; else if (s.type === "color") u[s.key] = { value: hex3(v) };
  }
  return u;
}
/**
 * Copie des valeurs dans les uniforms EXISTANTS d'un matériau. three.js capture `material.uniforms` au premier rendu :
 * réassigner l'objet ensuite n'a aucun effet (valeurs figées sur la 1re image). Ne jamais écrire `mat.uniforms = …`.
 * Chaque matériau doit recevoir le même jeu de clés à chaque appel (la liste d'uniforms est mise en cache au 1er rendu).
 */
function setUniforms(mat: THREE.ShaderMaterial, uni: Record<string, THREE.IUniform>) {
  for (const k in uni) { const cur = mat.uniforms[k]; if (cur) cur.value = uni[k].value; else mat.uniforms[k] = uni[k]; }
}
/** Valeurs d'un effet à l'instant `local` : keyframes évaluées, puis ramenées dans les bornes. */
function resolveParams(def: EffectDef, raw: Record<string, any> | undefined, local: Ms) {
  const r: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw ?? {})) r[k] = typeof v === "object" && v && "kf" in v ? (typeof v.kf[0][1] === "string" ? evalCol(v, local, "#ffffff") : evalNum(v, local, 0)) : v;
  return coerceParams(def, r);
}

const CROSSFADE = /* glsl */ `precision highp float; varying vec2 vUv; uniform sampler2D tFrom; uniform sampler2D tTo; uniform float uProgress;
vec4 fx(vec2 uv); void main(){ gl_FragColor = fx(vUv); }
vec4 fx(vec2 uv){ vec4 a = texture2D(tFrom, uv); vec4 b = texture2D(tTo, uv); return mix(a, b, uProgress); }`;

export class Compositor {
  w = 0; h = 0;
  private pool: THREE.WebGLRenderTarget[] = [];
  private fsScene = new THREE.Scene(); private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private scene = new THREE.Scene(); private ortho!: THREE.OrthographicCamera; private persp = new THREE.PerspectiveCamera();
  private mats = new Map<string, THREE.ShaderMaterial>(); private geos = new Map<string, THREE.PlaneGeometry>();
  private canvases = new Map<string, { cv: HTMLCanvasElement; tex: THREE.CanvasTexture }>();
  private quad = new THREE.Mesh(); disabled: ReadonlySet<string> = new Set();

  constructor(public renderer: THREE.WebGLRenderer, w: number, h: number) {
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // aucune conversion de couleur : sRGB brut de bout en bout
    renderer.autoClear = false;
    this.fsScene.add(this.fsMesh); this.scene.add(this.quad); this.fsMesh.frustumCulled = false; this.quad.frustumCulled = false;
    this.setSize(w, h);
  }
  setSize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    for (const r of this.pool) r.dispose(); this.pool = [];
    this.ortho = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, -5000, 5000); this.ortho.position.z = 1000;
    for (const c of this.canvases.values()) c.tex.dispose(); this.canvases.clear();
  }
  /* réservoir de textures réutilisées (budget mobile) */
  private acquire(): THREE.WebGLRenderTarget {
    const r = this.pool.pop() ?? new THREE.WebGLRenderTarget(this.w, this.h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, type: THREE.UnsignedByteType });
    return r;
  }
  private release(...rs: THREE.WebGLRenderTarget[]) { for (const r of rs) this.pool.push(r); }
  private clear(rt: THREE.WebGLRenderTarget | null, a = 0) { this.renderer.setRenderTarget(rt); this.renderer.setClearColor(0x000000, a); this.renderer.clear(true, false, false); }

  /* shaders compilés une seule fois, par effet */
  private fxMat(def: EffectDef, kind: "fx" | "overlay" | "transition"): THREE.ShaderMaterial {
    const key = `${kind}:${def.id}`; let m = this.mats.get(key); if (m) return m;
    const decl = kind === "transition" ? "" : HEAD + uniformDecl(def);
    const fs = kind === "transition"
      ? `precision highp float; varying vec2 vUv; uniform sampler2D tFrom; uniform sampler2D tTo; uniform float uProgress; uniform float uTime; uniform vec2 uRes; uniform float uSeed;\nfloat hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }\n${uniformDecl(def)}\nvec4 fx(vec2 uv);\n${def.shader}\nvoid main(){ gl_FragColor = fx(vUv); }`
      : `${decl}\nvec4 fx(vec2 uv);\n${def.shader}\nvoid main(){ gl_FragColor = fx(vUv); }`;
    m = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: fs, uniforms: {}, depthTest: false, depthWrite: false, transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor });
    this.mats.set(key, m); return m;
  }
  private fullscreen(mat: THREE.ShaderMaterial, uniforms: Record<string, THREE.IUniform>, target: THREE.WebGLRenderTarget | null, opaque = false) {
    setUniforms(mat, uniforms); mat.blending = opaque ? THREE.NoBlending : THREE.CustomBlending; mat.needsUpdate = false;
    this.fsMesh.material = mat; this.renderer.setRenderTarget(target); this.renderer.render(this.fsScene, this.fsCam);
  }
  /** Pile fx : texture → texture, en ping-pong. Retourne la texture finale et les RT à libérer. */
  private runFx(tex: THREE.Texture, list: FxRef[] | undefined, local: Ms, t: Ms, seed: number): { tex: THREE.Texture; used: THREE.WebGLRenderTarget[] } {
    const used: THREE.WebGLRenderTarget[] = [];
    for (const f of list ?? []) {
      const def = getEffect(f.id, this.disabled); if (!def?.shader || def.kind !== "fx") continue;
      const out = this.acquire(); used.push(out); this.clear(out);
      this.fullscreen(this.fxMat(def, "fx"), { tMap: { value: tex }, uTime: { value: t / 1000 }, uRes: { value: new THREE.Vector2(this.w, this.h) }, uSeed: { value: seed }, uAmount: { value: 1 }, ...paramUniforms(def, resolveParams(def, f.params, local)) }, out, true);
      tex = out.texture;
    }
    return { tex, used };
  }
  private presMat(meshId: string | undefined, corners: boolean, def?: EffectDef): THREE.ShaderMaterial {
    const key = `pres:${meshId ?? ""}:${corners ? 1 : 0}`; let m = this.mats.get(key); if (m) return m;
    const deform = def?.mesh ? `${uniformDecl(def)}\n${def.mesh.vertex}` : "vec3 deform(vec3 p, vec2 uv){ return p; }";
    const vs = `varying vec2 vUv; uniform float uTime; uniform vec2 uSize; uniform vec2 uC[4]; uniform vec2 uRes; uniform float uCorners;\n${deform}
void main(){ vUv = uv;
  if (uCorners > 0.5) { vec2 n = mix(mix(uC[3], uC[2], uv.x), mix(uC[0], uC[1], uv.x), uv.y); gl_Position = projectionMatrix * viewMatrix * vec4(n.x * uRes.x - uRes.x * 0.5, uRes.y * 0.5 - n.y * uRes.y, 0.0, 1.0); return; }
  vec3 p = vec3(position.xy * uSize, 0.0); p = deform(p, uv); p.xy /= uSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`;
    const fs = `precision highp float; varying vec2 vUv; uniform sampler2D tMap; uniform float uOpacity; uniform float uPremult;
void main(){ vec4 c = texture2D(tMap, vUv); float a = c.a * uOpacity; gl_FragColor = uPremult > 0.5 ? vec4(c.rgb * a, a) : vec4(c.rgb, a); }`;
    m = new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: {}, depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide });
    this.mats.set(key, m); return m;
  }
  private geo(seg: [number, number]) { const k = seg.join("x"); let g = this.geos.get(k); if (!g) { g = new THREE.PlaneGeometry(1, 1, seg[0], seg[1]); this.geos.set(k, g); } return g; }
  private setBlend(m: THREE.ShaderMaterial, blend: string | undefined): number {
    m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation;
    if (blend === "add") { m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneFactor; return 0; }
    if (blend === "screen") { m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcColorFactor; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; return 1; }
    if (blend === "multiply") { m.blendSrc = THREE.DstColorFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; return 1; }
    m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; return 0;
  }

  /** Texture 2D (texte, caption) dessinée à la résolution du canvas, moteur « canvas ». */
  private textTexture(l: Layer, doc: Composition, layout: Layout, src: FrameSource): THREE.Texture | null {
    const c: any = l.p.clip, isCap = l.p.kind === "caption", isShape = l.p.kind === "shape";
    const def = getEffect(isShape ? (c.shape?.preset ?? "svg_draw_v1") : c.style, this.disabled); if (!def?.draw) return null;
    let cv = this.canvases.get(l.p.id);
    if (!cv) { const el = document.createElement("canvas"); el.width = this.w; el.height = this.h; cv = { cv: el, tex: new THREE.CanvasTexture(el) }; this.canvases.set(l.p.id, cv); }
    const g = cv.cv.getContext("2d")!; g.clearRect(0, 0, this.w, this.h);
    let text = c.text ?? "", words: { t: string; s: number; e: number }[] | undefined;
    if (isCap) {
      const src = layout.byId[(c as CaptionClip).from]; if (!src) return null;
      const vc = src.clip as VideoClip, tm = { at: src.at, src: vc.src, speed: vc.speed };
      words = wordsOf(doc, vc.asset).filter((w) => w.s >= vc.src[0] - 1 && w.e <= vc.src[1] + 1).map((w) => ({ t: w.t, s: srcToTimeline(tm, w.s) - l.p.at, e: srcToTimeline(tm, w.e) - l.p.at }));
      text = words.map((w) => w.t).join(" ");
    } else if ((c as TextClip).counter) {
      const k = (c as TextClip).counter!; const p = Math.min(1, l.local / Math.max(1, k.dur));
      text = String(Math.round(k.from + (k.to - k.from) * p)) + (k.suffix ?? "");
    }
    const r = (c as TextClip).reveal, svg = isShape && c.shape?.asset ? src.svg?.(c.shape.asset) ?? undefined : undefined;
    def.draw({ g, w: this.w, h: this.h, t: l.local, dur: l.p.dur, text, words, svg, emphasis: c.emphasis, params: resolveParams(def, isShape ? c.shape?.params : c.params, l.local), reveal: r ? { by: r.by, stagger: r.stagger ?? 40 } : undefined });
    cv.tex.needsUpdate = true; return cv.tex;
  }

  /** Dessine un clip dans `target` (pile fx → présentation quad/mesh/corner pin → blend). */
  private drawLayer(l: Layer, target: THREE.WebGLRenderTarget, doc: Composition, layout: Layout, src: FrameSource, t: Ms, extraOpacity = 1) {
    const c: any = l.p.clip, w = this.w, h = this.h;
    let tex: THREE.Texture | null = null, tw = w, th = h, fitMode: string = "fill";
    const used: THREE.WebGLRenderTarget[] = [];
    if (l.p.kind === "video") {
      const s = src.texture(l.p.id); if (!s) return; tex = s.tex; tw = s.w; th = s.h; fitMode = c.fit ?? DEFAULTS.fit;
    } else if (l.p.kind === "text" || l.p.kind === "caption" || l.p.kind === "shape") { tex = this.textTexture(l, doc, layout, src); }
    else if (l.p.kind === "overlay") {
      const def = getEffect(c.effect, this.disabled); if (!def?.shader) return;
      const mat = this.fxMat(def, "overlay"); const m = this.setBlend(mat, c.blend);
      void m;
      const vals = resolveParams(def, c.params, l.local);
      setUniforms(mat, { tMap: { value: null }, uTime: { value: t / 1000 }, uRes: { value: new THREE.Vector2(w, h) }, uSeed: { value: 0 }, uAmount: { value: 1 }, ...paramUniforms(def, vals) });
      mat.blending = THREE.CustomBlending; this.fsMesh.material = mat; this.renderer.setRenderTarget(target); this.renderer.render(this.fsScene, this.fsCam); return;
    }
    if (!tex) return;
    // fit
    let bw = w, bh = h;
    if (fitMode !== "fill") { const k = fitMode === "contain" ? Math.min(w / tw, h / th) : Math.max(w / tw, h / th); bw = tw * k; bh = th * k; }
    const seed = (l.p.id.charCodeAt(0) || 1) + Math.floor(t / (1000 / (doc.canvas.fps || 30)));
    if (c.fx?.length) {
      // prépasse : image « fittée » à la taille du canvas, puis pile fx
      const fit = this.acquire(); used.push(fit); this.clear(fit);
      const mat = this.presMat(undefined, false), uni = { tMap: { value: tex }, uOpacity: { value: 1 }, uPremult: { value: 0 }, uTime: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) }, uC: { value: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] }, uRes: { value: new THREE.Vector2(w, h) }, uCorners: { value: 0 } };
      this.setBlend(mat, "normal"); this.quad.geometry = this.geo([1, 1]); this.quad.material = mat; setUniforms(mat, uni);
      this.quad.position.set(0, 0, 0); this.quad.scale.set(bw, bh, 1); this.quad.rotation.set(0, 0, 0);
      this.renderer.setRenderTarget(fit); this.renderer.render(this.scene, this.ortho);
      const r = this.runFx(fit.texture, c.fx, l.local, t, seed); used.push(...r.used); tex = r.tex; bw = w; bh = h;
    }
    const motion = c.motion ? getEffect(c.motion.preset, this.disabled)?.motion?.({ t: l.local, dur: l.p.dur, params: c.motion.params ?? {} }) : undefined;
    const tr = resolveTransform(c.transform, l.local, motion);
    const meshDef = c.mesh ? getEffect(c.mesh.id, this.disabled) : undefined;
    const useMesh = !!meshDef?.mesh;
    const mat = this.presMat(useMesh ? meshDef!.id : undefined, !!tr.corners, meshDef);
    const premult = this.setBlend(mat, c.blend);
    const meshVals = useMesh ? resolveParams(meshDef!, c.mesh.params, l.local) : {};
    const C = (tr.corners ?? [[0, 0], [1, 0], [1, 1], [0, 1]]).map((p) => new THREE.Vector2(p[0], p[1]));
    setUniforms(mat, { tMap: { value: tex }, uOpacity: { value: Math.max(0, Math.min(1, tr.opacity * extraOpacity)) }, uPremult: { value: premult }, uTime: { value: t / 1000 }, uSize: { value: new THREE.Vector2(bw * tr.sx, bh * tr.sy) }, uC: { value: C }, uRes: { value: new THREE.Vector2(w, h) }, uCorners: { value: tr.corners ? 1 : 0 }, ...(useMesh ? paramUniforms(meshDef!, meshVals) : {}) });
    this.quad.geometry = this.geo(tr.corners ? [24, 24] : useMesh ? meshDef!.mesh!.segments : [1, 1]);
    this.quad.material = mat;
    this.quad.position.set(tr.x * w - w / 2, h / 2 - tr.y * h, tr.z);
    this.quad.scale.set(bw * tr.sx, bh * tr.sy, 1);
    this.quad.rotation.set(-tr.rx * Math.PI / 180, tr.ry * Math.PI / 180, -tr.rot * Math.PI / 180 - tr.rz * Math.PI / 180);
    let cam: THREE.Camera = this.ortho;
    if (tr.has3d || tr.persp > 0) {
      const dist = tr.persp > 0 ? tr.persp * (h / 1000) * 2 : h * 1.8;
      this.persp.fov = 2 * Math.atan(h / 2 / dist) * 180 / Math.PI; this.persp.aspect = w / h; this.persp.near = 1; this.persp.far = dist * 4;
      this.persp.position.set(0, 0, dist); this.persp.lookAt(0, 0, 0); this.persp.updateProjectionMatrix(); this.persp.updateMatrixWorld(); cam = this.persp;
    }
    this.renderer.setRenderTarget(target); this.renderer.render(this.scene, cam);
    this.release(...used);
  }

  /** Rend l'image au temps `t` vers l'écran (target null) ou une render target. */
  render(doc: Composition, t: Ms, src: FrameSource, opts: { layout?: Layout; state?: FrameState; to?: THREE.WebGLRenderTarget | null; watermark?: string } = {}) {
    const layout = opts.layout ?? layoutDoc(doc), state = opts.state ?? buildFrameState(doc, layout, t);
    const w = this.w, h = this.h;
    let accum = this.acquire(); this.clear(accum, 1);
    const done = new Set<string>(); let graded = !doc.grade;
    const applyGrade = () => {
      graded = true; const def = getEffect(doc.grade!.lut, this.disabled); if (!def?.shader) return;
      const out = this.acquire(); this.clear(out, 1);
      this.fullscreen(this.fxMat(def, "fx"), { tMap: { value: accum.texture }, uTime: { value: t / 1000 }, uRes: { value: new THREE.Vector2(w, h) }, uSeed: { value: 0 }, uAmount: { value: Math.min(1, Math.max(0, evalNum(doc.grade!.amount, t, 1))) }, ...paramUniforms(def, coerceParams(def, {})) }, out, true);
      this.release(accum); accum = out;
    };
    for (const l of state.layers) {
      if (done.has(l.p.id)) continue;
      const base = l.p.kind === "video" || l.p.kind === "adjustment";
      if (!graded && !base) applyGrade();
      if (l.p.kind === "adjustment") {
        const r = this.runFx(accum.texture, (l.p.clip as any).fx, l.local, t, 1);
        if (r.used.length) { const last = r.used.pop()!; this.release(accum, ...r.used); accum = last; }
        continue;
      }
      const tr = state.transitions.find((x) => x.from.p.id === l.p.id);
      if (tr) {
        const a = this.acquire(), b = this.acquire(); this.clear(a); this.clear(b);
        this.drawLayer(tr.from, a, doc, layout, src, t); this.drawLayer(tr.to, b, doc, layout, src, t); done.add(tr.to.p.id);
        const def = getEffect(tr.effect, this.disabled); const custom = def?.kind === "transition" && def.shader ? def : undefined;
        const mat = custom ? this.fxMat(custom, "transition") : this.mats.get("xfade") ?? (() => { const m = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: CROSSFADE, depthTest: false, depthWrite: false, transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }); this.mats.set("xfade", m); return m; })();
        const uni: Record<string, THREE.IUniform> = { tFrom: { value: a.texture }, tTo: { value: b.texture }, uProgress: { value: tr.progress }, uTime: { value: t / 1000 }, uRes: { value: new THREE.Vector2(w, h) }, uSeed: { value: 0 }, ...(custom ? paramUniforms(custom, resolveParams(custom, tr.params, tr.to.local)) : {}) };
        this.fullscreen(mat, uni, accum); this.release(a, b); continue;
      }
      this.drawLayer(l, accum, doc, layout, src, t);
    }
    if (!graded) applyGrade();
    if (opts.watermark) this.drawWatermark(accum, opts.watermark);
    // blit vers l'écran / la cible
    const blit = this.mats.get("blit") ?? (() => { const m = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: "precision highp float; varying vec2 vUv; uniform sampler2D tMap; void main(){ gl_FragColor = vec4(texture2D(tMap, vUv).rgb, 1.0); }", depthTest: false, depthWrite: false }); this.mats.set("blit", m); return m; })();
    this.fullscreen(blit, { tMap: { value: accum.texture } }, opts.to ?? null, true);
    this.release(accum);
  }
  private drawWatermark(target: THREE.WebGLRenderTarget, text: string) {
    let cv = this.canvases.get("__wm");
    if (!cv) {
      const el = document.createElement("canvas"); el.width = this.w; el.height = this.h; const g = el.getContext("2d")!;
      const s = Math.round(this.w * 0.04); g.font = `600 ${s}px "Instrument Sans", system-ui, sans-serif`; g.textAlign = "right"; g.fillStyle = "rgba(255,255,255,0.7)";
      g.shadowColor = "rgba(0,0,0,0.6)"; g.shadowBlur = s * 0.3; g.fillText(text, this.w - s, this.h - s);
      cv = { cv: el, tex: new THREE.CanvasTexture(el) }; this.canvases.set("__wm", cv);
    }
    const mat = this.presMat(undefined, false); this.setBlend(mat, "normal");
    setUniforms(mat, { tMap: { value: cv.tex }, uOpacity: { value: 1 }, uPremult: { value: 0 }, uTime: { value: 0 }, uSize: { value: new THREE.Vector2(this.w, this.h) }, uC: { value: [0, 1, 2, 3].map(() => new THREE.Vector2()) }, uRes: { value: new THREE.Vector2(this.w, this.h) }, uCorners: { value: 0 } });
    this.quad.geometry = this.geo([1, 1]); this.quad.material = mat; this.quad.position.set(0, 0, 0); this.quad.scale.set(this.w, this.h, 1); this.quad.rotation.set(0, 0, 0);
    this.renderer.setRenderTarget(target); this.renderer.render(this.scene, this.ortho);
  }
  dispose() { for (const r of this.pool) r.dispose(); for (const m of this.mats.values()) m.dispose(); for (const g of this.geos.values()) g.dispose(); for (const c of this.canvases.values()) c.tex.dispose(); this.pool = []; }
}

/** Charge les polices déclarées par les effets avant tout rendu (le moteur canvas en dépend). */
export async function ensureFonts(doc: Composition) {
  const fonts = new Set<string>();
  for (const t of doc.tracks) for (const c of t.clips as any[]) { const e = getEffect(c.style ?? ""); e?.fonts?.forEach((f) => fonts.add(f)); }
  getEffect("minimal_clean")?.fonts?.forEach((f) => fonts.add(f));
  await Promise.all([...fonts].map((f) => document.fonts.load(f).catch(() => [])));
}

/* ────────────────────────── Audio : mixage hors-ligne ────────────────────────── */
export async function mixAudio(doc: Composition, layout: Layout, projectId: string, sr = 48000): Promise<AudioBuffer | null> {
  const len = Math.ceil((layout.duration / 1000) * sr); if (len < 1) return null;
  const ctx = new OfflineAudioContext(2, len, sr); let any = false;
  /** Bus d'un clip : volume + fondus, puis chaîne d'effets audio, puis sortie. Tous les morceaux du clip s'y branchent (états des effets continus). */
  const bus = async (afx: FxRef[] | undefined, atS: number, durS: number, gain: number, fade?: [number, number]) => {
    const g = ctx.createGain(); g.gain.value = gain;
    if (fade?.[0]) { g.gain.setValueAtTime(0, atS); g.gain.linearRampToValueAtTime(gain, atS + fade[0] / 1000); }
    if (fade?.[1]) { g.gain.setValueAtTime(gain, atS + durS - fade[1] / 1000); g.gain.linearRampToValueAtTime(0, atS + durS); }
    let last: AudioNode = g;
    for (const f of afx ?? []) {
      const def = getEffect(f.id); if (!def?.audio) continue;
      await def.audio.setup?.(ctx);
      const n = def.audio.build({ ctx, params: constParams(def, f.params), dur: durS }); last.connect(n.input); last = n.output;
    }
    last.connect(ctx.destination); return g;
  };
  const play = (buf: AudioBuffer, at: number, offset: number, dur: number, rate: number, target: AudioNode) => {
    const n = ctx.createBufferSource(); n.buffer = buf; n.playbackRate.value = rate; n.connect(target); n.start(at, offset); n.stop(at + dur); any = true;
  };
  for (const p of layout.list) {
    if (!p.ok) continue;
    const track = doc.tracks[p.trackIdx]; if (track.muted) continue;
    if (p.kind === "video") {
      const c = p.clip as VideoClip, a: any = doc.assets[c.asset]; if (!a?.hasAudio) continue;
      const blob = await getFile(projectId, c.asset, a); if (!blob) continue;
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      try {
        const tr = await input.getPrimaryAudioTrack(); if (!tr) continue;
        const sink = new AudioBufferSink(tr), rate = evalNum(c.speed, 0, 1), g = await bus(c.afx, p.at / 1000, p.dur / 1000, evalNum(c.volume, 0, 1));
        for await (const wb of sink.buffers(c.src[0] / 1000, c.src[1] / 1000)) {
          const skip = Math.max(0, c.src[0] / 1000 - wb.timestamp);
          const at = (p.at + (Math.max(wb.timestamp, c.src[0] / 1000) * 1000 - c.src[0]) / rate) / 1000;
          const remain = Math.min(wb.duration - skip, c.src[1] / 1000 - Math.max(wb.timestamp, c.src[0] / 1000));
          if (remain > 0) play(wb.buffer, at, skip, remain / rate, rate, g);
        }
      } finally { input.dispose(); }
    } else if (p.kind === "audio") {
      const c = p.clip as AudioClip; let ab: ArrayBuffer | null = null;
      if (c.asset.startsWith("sfx:")) { const u = getEffect(c.asset.slice(4))?.url; if (u) ab = await (await fetch(u)).arrayBuffer(); }
      else { const a: any = doc.assets[c.asset]; const b = a && (await getFile(projectId, c.asset, a)); if (b) ab = await b.arrayBuffer(); }
      if (!ab) continue;
      const buf = await ctx.decodeAudioData(ab), off = (c.src?.[0] ?? 0) / 1000, durS = Math.min(p.dur, (buf.duration - off) * 1000) / 1000;
      const g = await bus(c.afx, p.at / 1000, durS, evalNum(c.gain, 0, 1), c.fade);
      play(buf, p.at / 1000, off, durS, 1, g);
    }
  }
  return any ? await ctx.startRendering() : null;
}

/* ────────────────────────── Export MP4 (H.264 + AAC) ────────────────────────── */
export interface ExportOpts { projectId: string; width?: number; fps?: number; watermark?: string; disabled?: ReadonlySet<string>; onProgress?: (p: number, msg: string) => void; signal?: AbortSignal }
export async function exportMp4(doc: Composition, o: ExportOpts): Promise<Blob> {
  if (typeof VideoEncoder === "undefined") throw new Error("Votre navigateur ne gère pas l'export (WebCodecs). Utilisez Chrome, Edge ou Safari récent.");
  const fps = o.fps ?? doc.canvas.fps, W = o.width ?? doc.canvas.w, H = Math.round((W * doc.canvas.h) / doc.canvas.w / 2) * 2, w = Math.round(W / 2) * 2;
  const layout = layoutDoc(doc); if (layout.duration < 1) throw new Error("La timeline est vide.");
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(1); renderer.setSize(w, H, false);
  const comp = new Compositor(renderer, w, H); comp.disabled = o.disabled ?? new Set();
  const src = new ExportSource(o.projectId); src.doc = doc;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const vsrc = new CanvasSource(canvas, { codec: "avc", bitrate: QUALITY_HIGH });
  const asrc = new AudioBufferSource({ codec: "aac", bitrate: 160_000 });
  output.addVideoTrack(vsrc, { frameRate: fps }); output.addAudioTrack(asrc);
  try {
    await ensureFonts(doc);
    await output.start();
    const n = Math.ceil((layout.duration / 1000) * fps);
    for (let i = 0; i < n; i++) {
      if (o.signal?.aborted) throw new DOMException("Export annulé", "AbortError");
      const t = Math.round((i * 1000) / fps), state = buildFrameState(doc, layout, t);
      await src.prepare(state);
      comp.render(doc, t, src, { layout, state, watermark: o.watermark });
      await vsrc.add(i / fps, 1 / fps);
      if (i % 5 === 0) o.onProgress?.((i / n) * 0.9, `Image ${i + 1} / ${n}`);
    }
    o.onProgress?.(0.92, "Mixage audio…");
    const mix = await mixAudio(doc, layout, o.projectId);
    if (mix) await asrc.add(mix);
    vsrc.close(); asrc.close();
    o.onProgress?.(0.96, "Finalisation…");
    await output.finalize();
    return new Blob([output.target.buffer!], { type: "video/mp4" });
  } catch (e) { try { await output.cancel(); } catch { /* ignore */ } throw e; }
  finally { src.dispose(); comp.dispose(); renderer.dispose(); }
}
