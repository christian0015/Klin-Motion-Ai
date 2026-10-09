//src/components/Editor.tsx
/**
 * Editor.tsx — mise en page de l'éditeur, barre d'outils, panneaux Rushs / Brief / Historique, loaders et erreurs globaux,
 *              orchestration : import, proxy, analyse IA (estimation → confirmation → job), export, sauvegarde auto, raccourcis.
 * Contient : <Editor/>, panneaux latéraux, modale de confirmation de crédits.
 * Ne contient PAS : rendu (Preview/render.tsx), timeline, formulaires d'effets (Inspector), maths de temps (engine.ts).
 */
"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { nanoid } from "nanoid";
import Preview from "./Preview";
import Timeline from "./Timeline";
import Inspector from "./Inspector";
import EffectsPanel from "./EffectsPanel";
import { useEditor, type VersionMeta } from "@/lib/store";
import { ApiError, api, fingerprint, getFile, hasLocal, importRush, makeAudioProxy, makeImageProxy, makeProxy, probe, remember, uploadBlob } from "@/lib/media";
import { exportMp4 } from "@/lib/render";
import { GenerateButton, Suggestions, type GenInfo } from "./GeneratePanel";
import { layoutDoc, validate } from "@/lib/engine";
import { getEffect } from "@/effects";
import type { Asset, Brief, Composition } from "@/lib/schema";

type MediaAsset = Extract<Asset, { type: "video" | "image" | "audio" }>;

interface Me { gen?: GenInfo; credits: number; limits: { watermark: boolean }; analysis: { proxyShortSide: number; proxyFps: number; imageProxySide: number }; disabledEffects: string[] }
interface Initial { id: string; name: string; rev: number; brief: Brief; doc: Composition }

export default function Editor({ initial }: { initial: Initial }) {
  // Abonnement CIBLÉ : surtout pas au store entier (le temps `t` change à chaque image et ferait recréer l'aperçu).
  const s = useEditor(useShallow((st) => ({ doc: st.doc, save: st.save, name: st.name, brief: st.brief, status: st.status, progress: st.progress, message: st.message, sync: st.sync, versions: st.versions, past: st.past, future: st.future, disabled: st.disabled, projectId: st.projectId, problems: st.problems })));
  const [me, setMe] = useState<Me | null>(null);
  const [left, setLeft] = useState<"rushs" | "effects" | "brief" | "history">("rushs");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [confirm, setConfirm] = useState<{ credits: number; minutes: number; balance: number; tokens: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const say = useCallback((kind: "ok" | "err", msg: string) => { setToast({ kind, msg }); setTimeout(() => setToast(null), 7000); }, []);
  const act = useEditor.getState();
  const onMissing = useCallback((id: string) => useEditor.getState().setSync(id, { state: "missing" }), []);
  const onProblem = useCallback((id: string, msg: string) => useEditor.getState().setProblem(id, msg), []);

  /* ───── chargement ───── */
  useEffect(() => {
    act.load(initial);
    api<Me>("me").then((m) => { setMe(m); act.setDisabled(m.disabledEffects); }).catch(() => {});
    void act.loadVersions();
    (async () => {
      for (const [id, a] of Object.entries(initial.doc.assets)) {
        if (a.type !== "video" && a.type !== "image" && a.type !== "audio") continue;
        const fp = (a as { fp?: string }).fp; if (!fp) continue;
        const local = await hasLocal(fp);
        useEditor.getState().setSync(id, { state: local ? (a.remote ? "synced" : "local") : a.remote ? "synced" : "missing", progress: a.remote ? 1 : 0 });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  /* ───── sauvegarde auto (debounce 1,5 s) + garde-fou de fermeture ───── */
  useEffect(() => { if (s.save !== "dirty") return; const id = setTimeout(() => void useEditor.getState().saveNow(), 1500); return () => clearTimeout(id); }, [s.doc, s.name, s.brief, s.save]);
  useEffect(() => { const f = (e: BeforeUnloadEvent) => { if (useEditor.getState().save !== "saved") e.preventDefault(); }; window.addEventListener("beforeunload", f); return () => window.removeEventListener("beforeunload", f); }, []);

  /* ───── raccourcis ───── */
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const st = useEditor.getState(), mod = e.metaKey || e.ctrlKey;
      if (e.code === "Space") { e.preventDefault(); st.setPlaying(!st.playing); }
      else if (e.key.toLowerCase() === "s" && !mod) st.splitAtPlayhead();
      else if (e.key === "Delete" || e.key === "Backspace") st.deleteSelected();
      else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? st.redo() : st.undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); st.redo(); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, []);

  const warnings = useMemo(() => validate(s.doc, (id) => !!getEffect(id, new Set(s.disabled))), [s.doc, s.disabled]);
  const mediaAssets = Object.entries(s.doc.assets).filter((e): e is [string, MediaAsset] => e[1].type === "video" || e[1].type === "image" || e[1].type === "audio");
  const videoAssets = Object.entries(s.doc.assets).filter(([, a]) => a.type === "video") as [string, Extract<Composition["assets"][string], { type: "video" }>][];
  const used = useMemo(() => new Set(layoutDoc(s.doc).list.filter((p) => p.kind === "video" || p.kind === "audio").map((p) => (p.clip as { asset: string }).asset)), [s.doc]);
  const hasVideoUsed = videoAssets.some(([id]) => used.has(id));
  const busy = s.status !== "ready" && s.status !== "idle" && s.status !== "error";

  /* ───── import + envoi cloud en arrière-plan (non bloquant) ───── */
  const syncOriginal = async (assetId: string, file: File, fp: string) => {
    const m = await useEditor.getState().syncAsset(assetId, file, fp); if (m) say("err", m);
  };
  const addVideos = async (files: File[]) => {
    for (const file of files) {
      const p = await importRush(file), assetId = nanoid(6);
      useEditor.getState().apply("Ajouter un rush", (d) => {
        d.assets[assetId] = { type: "video", name: file.name, w: p.w, h: p.h, dur: p.dur, fps: p.fps, rot: p.rot, hasAudio: p.hasAudio, bytes: p.bytes, fp: p.fp };
        let tr = d.tracks.find((t) => t.kind === "video" && t.magnetic);
        if (!tr) { d.tracks.unshift({ id: "v1", kind: "video", magnetic: true, clips: [] }); tr = d.tracks[0]; }
        (tr.clips as any[]).push({ id: nanoid(6), asset: assetId, src: [0, p.dur] });
      });
      useEditor.getState().setSync(assetId, { state: "local", progress: 0 });
      if (!p.decodable) {
        const m = `Codec « ${p.codec} » non lisible par ce navigateur : l'aperçu restera noir et l'analyse échouera. Convertissez la vidéo en H.264 (MP4).`;
        useEditor.getState().setProblem(assetId, m); say("err", m);
      }
      void syncOriginal(assetId, file, p.fp);
    }
  };
  /** Un seul point d'entrée : vidéos, images et sons sont aiguillés selon leur type. */
  const addMedia = async (list: FileList | null) => {
    if (!list?.length) return;
    const files = Array.from(list), st = () => useEditor.getState();
    act.setStatus("importing", 0, "Lecture des médias…");
    try {
      await addVideos(files.filter((f) => f.type.startsWith("video/")));
      for (const f of files) {
        if (f.type.startsWith("image/")) { const r = await st().importImage(f); if (!r.ok) say("err", r.msg ?? "Image illisible."); }
        else if (f.type.startsWith("audio/")) { const r = await st().importAudio(f); if (!r.ok) say("err", r.msg ?? "Audio illisible."); }
        else if (!f.type.startsWith("video/")) say("err", `« ${f.name} » : type non pris en charge (vidéo, image ou audio).`);
      }
      act.setStatus("ready");
    } catch (e) { act.setStatus("error", 0, (e as Error).message); say("err", (e as Error).message); }
  };
  /** Redonne un fichier à un rush. Projet d'exemple : n'importe quelle vidéo convient et remplace les métadonnées fictives. */
  const placeAsset = (assetId: string) => { const r = useEditor.getState().placeAsset(assetId); if (r.msg) say("err", r.msg); };
  const removeRush = (assetId: string, name: string) => {
    const n = layoutDoc(useEditor.getState().doc).list.filter((p) => (p.kind === "video" || p.kind === "audio") && (p.clip as { asset?: string }).asset === assetId).length;
    if (!window.confirm(`Supprimer « ${name} » ?${n ? ` ${n} clip(s) de la timeline seront retirés (Ctrl+Z les restaure).` : ""} La copie cloud est supprimée.`)) return;
    const st = useEditor.getState(); st.removeAsset(assetId);
    void api(`projects/${st.projectId}/assets/${assetId}`, "DELETE").catch(() => {});
  };
  const relink = async (assetId: string, a: { fp: string }, file?: File) => {
    if (!file) return;
    if (a.fp.startsWith("example-")) {
      try {
        const p = await probe(file); await remember(p.fp, file);
        useEditor.getState().apply("Relier une vraie vidéo", (d) => {
          const x = d.assets[assetId]; if (x?.type !== "video") return;
          Object.assign(x, { name: file.name, w: p.w, h: p.h, dur: p.dur, fps: p.fps, rot: p.rot, hasAudio: p.hasAudio, bytes: p.bytes, fp: p.fp });
          delete x.remote; delete x.proxy;
          for (const t of d.tracks) if (t.kind === "video") for (const c of t.clips) if (c.asset === assetId) {
            c.src = [Math.min(c.src[0], Math.max(0, p.dur - 100)), Math.min(c.src[1], p.dur)];
            if (c.src[1] <= c.src[0]) c.src = [0, p.dur];
          }
        });
        useEditor.getState().setSync(assetId, { state: "local", progress: 0 }); void syncOriginal(assetId, file, p.fp);
        say("ok", "Vidéo reliée. Les mots de l'exemple restent fictifs : lancez « Monter avec l'IA » pour obtenir la vraie transcription.");
      } catch (e) { say("err", (e as Error).message); }
      return;
    }
    if ((await fingerprint(file)) !== a.fp) { say("err", "Ce fichier ne correspond pas au rush d'origine."); return; }
    await remember(a.fp, file); useEditor.getState().setSync(assetId, { state: "local" }); say("ok", "Rush relié.");
  };

  /* ───── analyse IA : proxys → estimation → confirmation → job → un seul patch ───── */
  const prepareAndEstimate = async () => {
    const targets = mediaAssets.filter(([id]) => used.has(id));   // vidéos, images ET sons placés : l'IA les voit tous
    if (!targets.some(([, a]) => a.type === "video")) { say("err", "Aucun rush vidéo dans la timeline : ajoutez une vidéo, ou utilisez « Ajouter à la timeline » dans le panneau Médias."); return; }
    try {
      const cfg = me?.analysis ?? { proxyShortSide: 240, proxyFps: 12, imageProxySide: 768 }, st = useEditor.getState();
      let i = 0;
      for (const [id, a] of targets) {
        if (a.proxy) { i++; continue; }
        const name = a.name ?? id, fp = (a as { fp?: string }).fp ?? id;
        st.setStatus("proxying", i / targets.length, `Préparation de « ${name} »…`);
        const file = await getFile(st.projectId, id, a as { fp?: string; remote?: string; bytes?: number }, () => st.setSync(id, { state: "downloading" }));
        if (!file) throw new Error(fp.startsWith("example-") ? "Le projet d'exemple n'a pas de vraie vidéo : utilisez « Relier une vraie vidéo » dans le panneau Médias." : `Média manquant : « ${name} ». Redonnez le fichier dans le panneau Médias.`);
        const progress = (p: number) => st.setStatus("proxying", (i + p) / targets.length, `Préparation de « ${name} »…`);
        const proxy = a.type === "video" ? await makeProxy(file, a, cfg, progress) : a.type === "image" ? await makeImageProxy(file, cfg.imageProxySide) : await makeAudioProxy(file, progress);
        const key = await uploadBlob(proxy, { projectId: st.projectId, assetId: id, kind: "proxy", type: proxy.type || (a.type === "video" ? "video/mp4" : a.type === "image" ? "image/jpeg" : "audio/wav"), fp });
        useEditor.getState().silent((d) => { const x = d.assets[id]; if (x && (x.type === "video" || x.type === "image" || x.type === "audio")) x.proxy = key; });
        i++;
      }
      st.setStatus("proxying", 1, "Enregistrement…");
      for (let n = 0; n < 20 && useEditor.getState().save !== "saved"; n++) { await useEditor.getState().saveNow(); await new Promise((r) => setTimeout(r, 200)); }
      const est = await api("analyze/estimate", "POST", { projectId: st.projectId });
      st.setStatus("ready"); setConfirm({ credits: est.credits, minutes: est.minutes, balance: est.balance, tokens: est.tokens });
    } catch (e) { act.setStatus("error", 0, (e as Error).message); say("err", (e as Error).message); }
  };
  const launch = async () => {
    setConfirm(null); const st = useEditor.getState(); const before = st.doc;
    try {
      st.setStatus("analyzing", 0.02, "Analyse lancée…");
      const { jobId } = await api("analyze", "POST", { projectId: st.projectId });
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const j = await api(`jobs/${jobId}`);
        st.setStatus("analyzing", j.progress, j.message ?? "Analyse en cours…");
        if (j.status === "failed") throw new Error(j.error ?? "L'analyse a échoué : crédits remboursés.");
        if (j.status === "done") {
          const v = await api(`projects/${st.projectId}/versions/${j.versionId}`);
          st.replaceDoc(v.doc, "Montage IA"); useEditor.getState().setSuggestions(v.meta?.suggestions ?? []);
          useEditor.getState().setCompare({ a: before, b: v.doc, labelA: "Avant l'IA", labelB: "Après l'IA" });
          st.setStatus("ready"); void st.loadVersions(); api<Me>("me").then(setMe).catch(() => {});
          say(j.fallback ? "err" : "ok", j.fallback ? j.message : "Montage prêt. Comparez avant / après dans l'historique."); break;
        }
      }
    } catch (e) {
      st.setStatus("error", 0, (e as Error).message); say("err", (e as Error).message);
      api<Me>("me").then(setMe).catch(() => {});
    }
  };

  /* ───── export ───── */
  const doExport = async (width: number) => {
    const st = useEditor.getState(); abort.current = new AbortController(); st.setPlaying(false);
    try {
      st.setStatus("exporting", 0, "Préparation…");
      const blob = await exportMp4(st.doc, { projectId: st.projectId, width, watermark: me?.limits.watermark ? "MotionIA" : undefined, disabled: new Set(st.disabled), signal: abort.current.signal, onProgress: (p, m) => useEditor.getState().setStatus("exporting", p, m) });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${st.name || "montage"}.mp4`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
      st.setStatus("ready"); say("ok", "Export terminé."); void api("events", "POST", { type: "export_done", projectId: st.projectId });
    } catch (e) { st.setStatus(e instanceof DOMException && e.name === "AbortError" ? "ready" : "error", 0, (e as Error).message); if (!(e instanceof DOMException)) say("err", (e as Error).message); }
  };

  /* ───── versions ───── */
  const openVersion = async (v: VersionMeta, as: "restore" | "compare") => {
    const full = await api(`projects/${s.projectId}/versions/${v.id}`);
    if (as === "compare") { act.setCompare({ on: true, side: "b", a: s.doc, b: full.doc, labelA: "Actuelle", labelB: v.label ?? v.kind }); return; }
    act.replaceDoc(full.doc, `Restaurer : ${v.label ?? v.kind}`); say("ok", "Version restaurée (annulable avec Ctrl+Z).");
  };
  const manualVersion = async () => { const label = prompt("Nom de cette version ?"); if (!label) return; await api(`projects/${s.projectId}/versions`, "POST", { label, doc: s.doc }); void act.loadVersions(); say("ok", "Version enregistrée."); };
  const compareOriginal = async () => { const { originalDoc } = await import("@/lib/engine"); act.setCompare({ on: true, side: "b", a: originalDoc(s.doc), b: s.doc, labelA: "Original (rushs bruts)", labelB: "Montage" }); act.setPlaying(false); };

  const saveLabel = { saved: "Enregistré", saving: "Enregistrement…", dirty: "Modifications non enregistrées", failed: "Échec de l'enregistrement", conflict: "Conflit de version" }[s.save];
  const aiVersion = s.versions.find((v) => v.kind === "ai");

  return (
    // <div className="flex h-dvh min-h-[640px] flex-col">
    <div className="flex min-h-dvh lg:min-h-[640px] lg:h-dvh flex-col">
      {/* barre d'outils */}
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <Link href="/dashboard" className="font-display text-3xl leading-none text-ink" aria-label="Retour aux projets">MotionIA</Link>
        <input className="field !w-52 !py-1" value={s.name} onChange={(e) => act.rename(e.target.value)} aria-label="Nom du projet" maxLength={120} />
        <span className={`chip ${s.save === "saved" ? "" : s.save === "saving" ? "text-accent-2" : "!border-bad/50 text-bad"}`}>{s.save === "saving" && <i className="spinner" />}{saveLabel}</span>
        {s.save === "conflict" && <><button className="btn !py-1" onClick={() => location.reload()}>Recharger</button><button className="btn !py-1" onClick={() => void act.saveNow(true)}>Écraser avec ma version</button></>}
        {s.save === "failed" && <button className="btn !py-1" onClick={() => void act.saveNow()}>Réessayer</button>}
        <span className="mx-auto" />
        <button className="btn !py-1" onClick={act.undo} disabled={!s.past.length} title="Ctrl+Z">Annuler</button>
        <button className="btn !py-1" onClick={act.redo} disabled={!s.future.length} title="Ctrl+Maj+Z">Rétablir</button>
        {me && <span className="chip" title="Crédits restants">{me.credits} crédits</span>}
        <button className="btn btn-primary" onClick={prepareAndEstimate} disabled={busy || !hasVideoUsed}>Monter avec l'IA</button>
        <select className="field !w-auto !py-1.5" value="" disabled={busy || !s.doc.tracks.length} onChange={(e) => { if (e.target.value) void doExport(+e.target.value); }} aria-label="Exporter">
          <option value="">Exporter en MP4</option><option value={s.doc.canvas.w}>Pleine résolution ({s.doc.canvas.w} px)</option><option value={720}>720 px de large</option>
        </select>
      </header>

      {/* bandeau de statut / loaders */}
      {(busy || s.status === "error") && (
        <div className={`flex items-center gap-3 border-b px-4 py-2 text-sm ${s.status === "error" ? "border-bad/40 bg-bad/10 text-bad" : "border-line bg-raised"}`} role="status" aria-live="polite">
          {busy && <i className="spinner" />}
          <span className="flex-1">{s.message || { importing: "Import…", proxying: "Préparation…", analyzing: "Analyse…", exporting: "Export…" }[s.status as string]}</span>
          {busy && <div className="h-1.5 w-40 overflow-hidden rounded bg-line"><div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(s.progress * 100)}%` }} /></div>}
          {s.status === "exporting" && <button className="btn !py-0.5" onClick={() => abort.current?.abort()}>Annuler</button>}
          {s.status === "error" && <button className="btn !py-0.5" onClick={() => act.setStatus("ready")}>Fermer</button>}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_minmax(220px,36%)] lg:grid-cols-[300px_minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)_minmax(220px,36%)]">
        {/* gauche */}
        <aside className="min-h-0 overflow-y-auto border-b border-line bg-panel lg:row-span-1 lg:border-b-0 lg:border-r">
          <div className="flex border-b border-line text-sm">{([["rushs", "Médias"], ["effects", "Effets"], ["brief", "Brief"], ["history", "Historique"]] as const).map(([k, l]) => <button key={k} onClick={() => setLeft(k)} className={`flex-1 py-2 ${left === k ? "border-b-2 border-accent" : "text-muted"}`}>{l}</button>)}</div>
          {left === "rushs" && (
            <div className="space-y-3 p-3">
              <label className="btn btn-primary w-full cursor-pointer">Ajouter des médias<input type="file" accept="video/*,image/*,audio/*" multiple hidden onChange={(e) => { void addMedia(e.target.files); e.target.value = ""; }} /></label>
              <p className="text-[11px] text-muted">Vidéos, images (PNG, JPEG, WebP, GIF) et sons (MP3, WAV, M4A, OGG).</p>
              {me?.gen && <GenerateButton gen={me.gen} credits={me.credits} say={say} onDone={() => api<Me>("me").then(setMe).catch(() => {})} />}
              {me?.gen && <Suggestions gen={me.gen} credits={me.credits} say={say} onDone={() => api<Me>("me").then(setMe).catch(() => {})} />}
              {!mediaAssets.length && <p className="font-display text-2xl text-muted">Déposez vos vidéos, images et sons pour commencer.</p>}
              {mediaAssets.map(([id, a]) => {
                const sy = s.sync[id], fp = (a as { fp?: string }).fp ?? "", example = fp.startsWith("example-");
                const mb = (a as { bytes?: number }).bytes ? ` · ${((a as { bytes: number }).bytes / 1048576).toFixed(1)} Mo` : "";
                const meta = a.type === "audio" ? `${(a.dur / 1000).toFixed(1)} s${mb}` : a.type === "image" ? `${a.w}×${a.h}${mb}` : `${(a.dur / 1000).toFixed(1)} s · ${a.w}×${a.h}${mb}`;
                return (
                  <div key={id} className="cursor-grab rounded-lg border border-line p-2 text-xs" draggable title="Glissez ce média sur une piste de la timeline"
                    onDragStart={(e) => { e.dataTransfer.setData("application/x-motionia-asset", id); e.dataTransfer.effectAllowed = "copy"; useEditor.getState().setDragAsset(id); }} onDragEnd={() => useEditor.getState().setDragAsset(null)}>
                    <p className="truncate font-medium" title={a.name}><span className="chip mr-1.5">{a.type === "video" ? "Vidéo" : a.type === "image" ? "Image" : "Audio"}</span>{a.name ?? id}</p>
                    <p className="mt-0.5 text-muted">{meta}</p>
                    <input className="field mt-1.5 !py-1" placeholder="Description (optionnel, lue par l'IA)" defaultValue={a.desc ?? ""} maxLength={500} onBlur={(e) => act.apply("Description du média", (d) => { const x = d.assets[id]; if (x && (x.type === "video" || x.type === "image" || x.type === "audio")) x.desc = e.target.value || undefined; })} />
                    <p className={`mt-1.5 ${sy?.state === "missing" ? "text-warn" : "text-muted"}`}>
                      {sy?.state === "uploading" ? `Synchronisation… ${Math.round(sy.progress * 100)} %` : sy?.state === "synced" ? "Synchronisé ✓" : sy?.state === "downloading" ? "Téléchargement depuis le cloud…" : sy?.state === "missing" ? (example ? "Exemple : aucune vidéo réelle" : "Fichier absent de cet appareil") : "Local (non synchronisé)"}
                      {a.proxy ? " · prêt pour l'IA" : ""}{!used.has(id) ? " · non utilisé dans la timeline" : ""}
                    </p>
                    {sy?.error && <p className="mt-1 text-warn">{sy.error}</p>}
                    <div className="mt-1.5 flex gap-1.5">
                      {!used.has(id) && <button className="btn !px-2 !py-0.5" onClick={() => placeAsset(id)}>Ajouter à la timeline</button>}
                      <button className="btn !px-2 !py-0.5 text-bad" onClick={() => removeRush(id, a.name ?? id)}>Supprimer</button>
                    </div>
                    {s.problems[id] && <p className="mt-1.5 rounded border border-bad/40 bg-bad/10 p-1.5 text-bad">{s.problems[id]}</p>}
                    {sy?.state === "missing" && <label className="btn mt-1.5 w-full cursor-pointer !py-1">{example ? "Relier une vraie vidéo" : "Redonner le fichier"}<input type="file" accept={`${a.type}/*`} hidden onChange={(e) => { void relink(id, { fp }, e.target.files?.[0]); e.target.value = ""; }} /></label>}
                  </div>
                );
              })}
              {warnings.length > 0 && (
                <div className="rounded-lg border border-warn/40 bg-warn/5 p-2 text-xs text-warn">
                  <p className="mb-1 font-medium">{warnings.length} avertissement{warnings.length > 1 ? "s" : ""}</p>
                  <ul className="max-h-32 space-y-0.5 overflow-y-auto">{warnings.slice(0, 20).map((w, i) => <li key={i}><button className="text-left underline-offset-2 hover:underline" onClick={() => w.clipId && act.select(w.clipId)}>{w.msg}</button></li>)}</ul>
                </div>
              )}
            </div>
          )}
          {left === "effects" && <EffectsPanel />}
          {left === "brief" && <BriefPanel />}
          {left === "history" && (
            <div className="space-y-2 p-3 text-sm">
              <div className="flex gap-2"><button className="btn flex-1 !py-1" onClick={manualVersion}>Enregistrer une version</button><button className="btn flex-1 !py-1" onClick={compareOriginal} disabled={!videoAssets.length}>Voir l'original</button></div>
              {!s.versions.length && <p className="text-xs text-muted">Aucune version pour l'instant. Chaque analyse IA et chaque sauvegarde créent une version.</p>}
              {s.versions.map((v) => (
                <div key={v.id} className="rounded-lg border border-line p-2 text-xs">
                  <p className="font-medium">{v.label ?? v.kind} <span className="chip ml-1">{v.kind}</span></p>
                  <p className="text-muted">{new Date(v.createdAt).toLocaleString("fr-FR")}{v.meta?.tokensIn ? ` · ${v.meta.tokensIn + (v.meta.tokensOut ?? 0)} tokens` : ""}</p>
                  <div className="mt-1.5 flex gap-1.5"><button className="btn !px-2 !py-0.5" onClick={() => void openVersion(v, "compare")}>Comparer</button><button className="btn !px-2 !py-0.5" onClick={() => void openVersion(v, "restore")}>Restaurer</button></div>
                </div>
              ))}
              {aiVersion && <p className="text-[11px] text-muted">Restaurer crée une nouvelle entrée d'historique : rien n'est écrasé.</p>}
            </div>
          )}
        </aside>
        {/* centre */}
        <main className="min-h-[360px] min-w-0 p-3"><Preview onMissing={onMissing} onProblem={onProblem} /></main>
        {/* droite */}
        <aside className="hidden min-h-0 border-l border-line bg-panel lg:block"><Inspector /></aside>
        {/* bas */}
        <section className="min-h-0 border-t border-line bg-panel lg:col-span-3"><Timeline /></section>
      </div>
      <div className="border-t border-line bg-panel lg:hidden"><div className="h-80"><Inspector /></div></div>

      {confirm && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Confirmer l'analyse">
          <div className="panel w-full max-w-sm p-5">
            <h2 className="font-display text-4xl">Lancer le montage IA ?</h2>
            <p className="mt-2 text-sm text-muted">{confirm.minutes.toFixed(1)} min de rushs analysés (≈ {confirm.tokens.toLocaleString("fr-FR")} tokens).</p>
            <p className="mt-3 text-lg font-semibold">{confirm.credits} crédits</p>
            <p className={`text-sm ${confirm.balance < confirm.credits ? "text-bad" : "text-muted"}`}>Solde : {confirm.balance} crédits. {confirm.balance < confirm.credits ? "Solde insuffisant : ajoutez des crédits depuis votre tableau de bord." : "Remboursés automatiquement si l'analyse échoue."}</p>
            <div className="mt-5 flex gap-2"><button className="btn flex-1" onClick={() => setConfirm(null)}>Annuler</button><button className="btn btn-primary flex-1" disabled={confirm.balance < confirm.credits} onClick={launch}>Lancer</button></div>
          </div>
        </div>
      )}
      {toast && <div role="alert" className={`fixed bottom-4 left-1/2 z-50 max-w-md -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-xl ${toast.kind === "ok" ? "border-ok/40 bg-panel text-ok" : "border-bad/40 bg-panel text-bad"}`}>{toast.msg}</div>}
    </div>
  );
}

function BriefPanel() {
  const brief = useEditor((s) => s.brief); const act = useEditor.getState();
  return (
    <div className="space-y-3 p-3 text-xs">
      <label className="block"><span className="mb-1 block text-muted">Plateforme</span>
        <select className="field" value={brief.platform} onChange={(e) => act.setBrief({ platform: e.target.value as Brief["platform"] })}><option value="tiktok">TikTok</option><option value="reels">Reels</option><option value="shorts">Shorts</option><option value="other">Autre</option></select></label>
      <label className="block"><span className="mb-1 block text-muted">Ce que vous voulez, en vos mots</span>
        <textarea className="field min-h-28" maxLength={2000} placeholder="Ex. : un montage dynamique, garde seulement les meilleures phrases, sous-titres jaunes, ambiance cinéma." value={brief.prompt ?? ""} onChange={(e) => act.setBrief({ prompt: e.target.value })} /></label>
      <label className="block"><span className="mb-1 block text-muted">Durée visée (secondes)</span>
        <input type="number" min={5} max={600} className="field" value={brief.targetDur ? Math.round(brief.targetDur / 1000) : ""} onChange={(e) => act.setBrief({ targetDur: e.target.value ? +e.target.value * 1000 : undefined })} /></label>
      <label className="block"><span className="mb-1 block text-muted">Style</span><input className="field" maxLength={200} placeholder="cinéma, punchy, sobre…" value={brief.style ?? ""} onChange={(e) => act.setBrief({ style: e.target.value })} /></label>
      <label className="block"><span className="mb-1 block text-muted">Langue parlée</span><input className="field" maxLength={12} placeholder="fr, en, ar…" value={brief.lang ?? ""} onChange={(e) => act.setBrief({ lang: e.target.value })} /></label>
      <p className="text-muted">L'IA lit ce texte comme une demande, jamais comme une instruction système.</p>
    </div>
  );
}
