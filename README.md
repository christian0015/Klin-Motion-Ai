# MotionIA (nom provisoire) — Éditeur vidéo IA pour réseaux sociaux

> **Pour Claude Code.** Lis ce document en entier avant d'écrire une ligne. Il est la source de vérité du projet : s'il contredit ton intuition, c'est lui qui gagne ; s'il est incomplet, tranche en respectant les principes de la section 2 et note la décision dans la section 12.

---

## 0. Démarrage rapide

```bash
npm install
cp .env.example .env.local      # renseigner les variables (section 3.2)
npm run dev                     # http://localhost:3000
npm test                        # tests engine + schema
npm run build                   # build de production
```
Apparence : **couleurs et polices se changent uniquement dans `src/app/globals.css`** (bloc `@theme` + URL Google Fonts en tête). Trois polices : `--font-sans` (sans relief), `--font-display` (calligraphique, titres), `--font-mono` (timecodes, JSON).
**Ajouter un effet ou un élément : lire `ADD_ELEMENTS.md`** (guide autonome, à envoyer tel quel à une IA). `npm test` vérifie la conformité de chaque effet.
Premier compte admin : mettre votre e-mail dans `ADMIN_EMAILS` avant la première connexion Google.

---

## 1. Vision

Des créateurs (solopreneurs, coachs, infopreneurs, créateurs B2B) veulent publier sans avoir le temps ni les compétences de montage. Ils déposent leurs rushs et décrivent ce qu'ils veulent ; une IA (Gemini, lecture vidéo native) analyse, décide du montage et produit **un JSON de composition** (cuts, sous-titres, effets, SFX, filtres) ; **notre moteur** le rend en preview et l'exporte. L'utilisateur retouche ensuite à la main dans un éditeur qui agit **directement sur ce JSON**.

Format prioritaire : **speech-to-edit** (une personne qui parle, enrichie de VFX, sous-titres cinétiques, overlays 3D). Le modèle de données reste générique pour accueillir d'autres formats (showcase produit, edit sur musique).

Positionnement : « Dépose tes rushs, récupère un montage propre au look cinématique », coût quasi nul pour l'exploitant (rendu et édition côté client), effets livrés régulièrement.

**Le propriétaire ne doit avoir à faire que deux choses : mettre les clés (variables d'environnement) et ajouter des effets.** Tout le reste (utilisateurs, crédits, coûts, tarifs, désactivation d'un effet) se gère depuis l'espace **admin**.

### Deux parties de travail

| Partie | Qui | Contenu |
|---|---|---|
| **Phase 1 — Plateforme** | Claude Code (ce README) | Landing, auth Google, profil, projets, éditeur (timeline, preview, historique avant/après), état, loaders, API, prompt Gemini automatique, export, **crédits et admin**. Plateforme **prête à recevoir** effets et SFX. |
| **Phase 2 — Effets** | Claude / Gemini, un par un | Chaque effet, SFX, LUT, style de texte, effet de déformation s'ajoute via le contrat de la section 11, sans toucher au moteur. |

---

## 2. Principes non négociables

1. **Peu de fichiers, responsabilités centralisées.** Le propriétaire déteste les arbres de 50 fichiers. Cible : **≈ 25 fichiers applicatifs**. Aucun dossier `utils/`, `helpers/`, `hooks/`, `types/`, `constants/`. Une fonction utilisée par un seul fichier vit dans ce fichier. On ne scinde un fichier qu'au-delà de ~600 lignes, et on met alors la carte (section 4) à jour.
2. **Aucun fichier inexpliqué.** Chaque fichier commence par un en-tête de 3 à 6 lignes : rôle, contenu, ce qu'il ne doit **pas** contenir. Exemple :
   ```ts
   /**
    * engine.ts — maths du temps et résolution de la timeline.
    * Contient : srcToTimeline, resolveAnchors, layoutMagnetic, buildFrameState, validate.
    * Ne contient PAS : rendu, UI, accès réseau.
    */
   ```
3. **Une seule source de vérité : `lib/schema.ts`.** Types, validation zod, valeurs par défaut, migrations et contrat d'effet y vivent. Rien n'est redéfini ailleurs.
4. **Le registre d'effets est la seule source du catalogue.** Le formulaire de l'Inspector, le prompt de l'IA, l'enum de sa réponse et le rendu sont **générés** depuis lui. Ajouter ou retirer un effet met tout à jour sans autre modification.
5. **L'UI est une vue du JSON.** Toute modification passe par une action du store qui applique un *patch* (immer). Aucun état local de composant ne duplique le document.
6. **Le moteur est pur et déterministe.** `renderFrame(doc, tMs)` ne dépend que de ses arguments : pas de `Date.now()`, pas de `Math.random()` (bruit seedé par `clipId + frame`), pas d'animation CSS/SMIL.
7. **Temps en millisecondes entières** partout. Conversion en frames uniquement dans le rendu.
8. **Local d'abord.** Les rushs sont lus depuis la mémoire/le disque local tant qu'ils y sont. Le cloud est une copie de synchronisation envoyée en arrière-plan, jamais un aller-retour imposé.
9. **Le coût est mesuré, pas supposé.** Chaque appel IA, chaque octet stocké écrit une ligne dans le registre (`ledger`). Rien ne coûte sans être visible dans l'admin.
10. **Ajouter un effet = 1 fichier + 1 ligne** dans `effects/index.ts`. Si ce n'est pas vrai à la fin de la phase 1, la phase 1 est ratée.
11. **Sécurité de base** : clés uniquement côté serveur, vérification de propriété dans **chaque** route API, rôle admin vérifié côté serveur, validation zod de toute entrée. Garde-fous détaillés en 9.6 (limiteur de débit, sessions, en-têtes, cache).
12. **Ne code pas les noms de modèles, de SDK ni les tarifs de mémoire.** Vérifie la documentation officielle actuelle (Gemini API, Auth.js, Next.js, fournisseur de paiement). Modèles et constantes de coût vivent dans la constante `ANALYSIS` (`lib/gemini.ts`).
13. **Langue** : identifiants et code en anglais, commentaires et textes d'interface en français.

---

## 3. Stack et dépendances autorisées

Next.js (App Router) + TypeScript strict + Tailwind. Toute autre dépendance doit être justifiée en une ligne dans la section 12.

| Besoin | Choix |
|---|---|
| Validation, types | `zod` |
| État, historique | `zustand` + `immer` (patches) |
| Auth | Auth.js (Google) + adaptateur MongoDB, sessions JWT |
| Base | **Mongoose** (voir 3.1) |
| Stockage des originaux et proxys | **Cloudflare R2** (API S3-compatible, bucket privé, URL signées) — voir D4 |
| Rendu | `three`, `@react-three/fiber`, `@react-three/drei` |
| Texte SDF (optionnel) | `troika-three-text` (via drei) |
| Export | WebCodecs + muxer MP4 (ex. `mediabunny` ou équivalent à vérifier) |
| IA | SDK Gemini officiel actuel |
| Paiement | Interface `PaymentProvider` (voir 9.3), adaptateur choisi plus tard |
| IDs | `nanoid` |
| Tests | `vitest` (uniquement `engine` et `schema`) |

Hébergement visé : Vercel + MongoDB Atlas + R2 (à confirmer, section 12).

### 3.1 Mongoose : règles
- Tous les modèles dans `lib/db.ts`.
- `Project.doc` est de type `Mixed`, **validé par zod avant chaque sauvegarde** (pas de second schéma de composition). `Mixed` ne détecte pas les changements : remplace le champ entier via `$set` et applique le contrôle `rev` (`findOneAndUpdate` avec `rev` attendu).
- Connexion mise en cache sur `globalThis` (rechargement à chaud et serverless).
- Auth.js : réutilise le client MongoDB natif sous-jacent de la connexion Mongoose pour l'adaptateur.

### 3.2 Variables d'environnement (les seules choses que le propriétaire renseigne)
`MONGODB_URI`, `APP_ORIGIN` (URL publique, sert à vérifier l'en-tête `Origin`), `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `GEMINI_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `ADMIN_EMAILS`, `CRON_SECRET`, et plus tard les clés du fournisseur de paiement. `.env.example` les liste toutes avec un commentaire d'une ligne (noms exacts à vérifier dans la documentation actuelle d'Auth.js) ; l'admin affiche leur **présence**, jamais leur valeur.

---

## 4. Carte des fichiers à créer

```
src/
  app/
    page.tsx                         Landing + bouton « Continuer avec Google »
    legal/page.tsx                   Confidentialité + conditions + remboursements (une page)
    dashboard/page.tsx               Profil, crédits et consommation, liste des projets
    editor/[id]/page.tsx             Charge le projet côté serveur, monte <Editor/>
    admin/page.tsx                   Espace admin (utilisateurs, coûts, tarifs, effets, jobs)
    api/[[...path]]/route.ts         TOUTE l'API + garde-fous (limiteur, origine, rôle) ; table des routes en tête
    api/auth/[...nextauth]/route.ts  Handlers Auth.js (quelques lignes)
    layout.tsx, globals.css          Standard
  components/
    Editor.tsx       Layout, barre d'outils, panneau Historique/Versions, loaders globaux
    Timeline.tsx     Pistes, clips, glisser/rogner/couper, playhead, zoom, snapping
    Preview.tsx      Canvas R3F + transport (lecture, pause, scrub), comparaison A/B
    Inspector.tsx    Propriétés du clip sélectionné, générées depuis les zod des effets ; onglet « JSON »
  lib/
    schema.ts        LE modèle JSON (zod), types, defaults, migrate(), defineEffect()
    engine.ts        Temps, ancres, speed, piste magnétique → FrameState ; validate()
    render.tsx       Pipeline de rendu texture d'abord ; FrameSource ; export WebCodecs
    store.ts         zustand+immer : projet, sélection, playhead, undo/redo, versions, statuts
    gemini.ts        Constante ANALYSIS, catalogue → prompt, appel, schéma de réponse, fusion, repli
    media.ts         Client : probe, sources locales (mémoire/OPFS), proxy, upload en arrière-plan
    billing.ts       Crédits (estimation, réservation, règlement, remboursement), tarifs, PaymentProvider
    db.ts            Mongoose : modèles et index (users, projects, versions, jobs, ledger, events, settings, ratelimits)
  auth.ts            Config Auth.js (sessions, cookies, sessionVersion)
  effects/
    index.ts         Registre : un import par effet (phase 2 : un fichier par effet)
    engine.test.ts   Tests de engine + schema (vitest)
public/sfx/          Fichiers audio des SFX
.env.example         Variables d'environnement commentées
README.md            Ce document
```

Aucun autre fichier sans justification. **Pas de `middleware`/`proxy`** : protection des pages côté serveur dans les pages et l'API.

---

## 5. Modèle JSON (spécification)

### 5.1 Primitives

```ts
type Ms  = number;                                    // entier, millisecondes
type Num = number | { kf: [t: Ms, v: number, ease?: string][] };  // t relatif au début du clip
type Col = string | { kf: [t: Ms, v: string][] };     // "#RRGGBB" ou keyframes
type P   = [x: number, y: number];                    // normalisé 0..1, origine en haut à gauche
```

Tout paramètre numérique ou couleur, y compris ceux des effets, accepte une valeur **ou** des keyframes.

### 5.2 Projet et composition

```ts
Project = {
  id, ownerId, name,
  rev: number,                         // concurrence optimiste
  brief: Brief,                        // intention de l'utilisateur, lue par l'IA
  doc: Composition,
  thumb?: string,                      // petite vignette (dataURL ≤ 20 Ko)
  createdAt, updatedAt
}

Brief = { platform: "tiktok" | "reels" | "shorts" | "other",
          prompt?: string,             // ce que l'utilisateur veut faire, en ses mots
          targetDur?: Ms, style?: string, lang?: string }

Composition = {
  v: 2,                                // version de schéma → migrate()
  canvas: { w: number, h: number, fps: number },     // défaut 1080×1920 @30
  assets: Record<string, Asset>,
  grade?: { lut: string, amount: Num },              // look global
  tracks: Track[],                     // ordre = du bas vers le haut
  transitions: { between: [string, string], effect: string, dur: Ms, params?: object }[]
}
```

### 5.3 Assets

```ts
Asset =
 | { type: "video", desc?: string, w, h, dur: Ms, fps, rot?: 0|90|180|270, hasAudio: boolean,
     bytes: number,
     fp: string,                       // empreinte (hash) pour re-lier les originaux locaux
     remote?: string,                  // clé de stockage de l'original synchronisé
     proxy?: string,                   // clé de stockage du proxy d'analyse
     words?: Word[] }
 | { type: "audio", remote?: string, dur: Ms, desc?: string, words?: Word[] }
 | { type: "image", remote?: string, w, h }
 | { type: "svg" | "lottie" | "model3d", remote?: string }
 | { type: "generated", kind: "image" | "video", prompt: string,
     status: "pending" | "ready" | "failed", ref?: string }   // ref = asset résultat

Word = { t: string, s: Ms, e: Ms }     // temps SOURCE ; ordre et nombre immuables,
                                       // seul le texte `t` est éditable
```

Les métadonnées (`w`, `h`, `dur`, `fps`, `bytes`, `fp`) sont remplies **par l'app** (`media.probe`), jamais par l'IA. `words` est rempli par l'IA. `remote` n'existe qu'une fois l'original synchronisé ; l'état « local / en cours / synchronisé / manquant » est calculé à l'exécution par `media.ts`, pas stocké.

### 5.4 Pistes et clips

```ts
Track = { id, kind: "video"|"adjustment"|"overlay"|"text"|"caption"|"shape"|"audio",
          magnetic?: boolean,          // clips enchaînés, sans `at` (l'app calcule)
          locked?: boolean, muted?: boolean, clips: Clip[] }

// Bloc commun à tout élément visuel
Visual = {
  id: string,                          // stable (nanoid) : les ancres s'y réfèrent
  at?: Ms, dur?: Ms,                   // temps timeline
  anchor?: { clip: string, words: [number, number], offset?: Ms, dur?: Ms },
  transform?: Transform,
  motion?: { preset: string, params?: object },   // ce que choisit l'IA
  blend?: "normal"|"add"|"screen"|"multiply"|"overlay",
  matte?: { from: string, mode: "alpha"|"luma"|"invert" },
  behind?: string,                     // le sujet de ce clip passe devant (rotoscopie auto)
  fx?: { id: string, params?: Record<string, Num|Col|string|boolean> }[],  // pile texture → texture
  mesh?: { id: string, params?: Record<string, Num|Col|string|boolean> },  // remplace la géométrie
                                       // de présentation (drap, vague, vidéo sur modèle 3D…)
  z?: number
}

Transform = {
  pos?: { x: Num, y: Num, z?: Num },   // centre de la boîte du clip
  scale?: Num | { x: Num, y: Num },    // 1 = taille naturelle après fit
  rot?: Num,                           // degrés, sens horaire
  rot3d?: { x: Num, y: Num, z: Num }, persp?: number,
  pivot?: P,
  corners?: [P, P, P, P],              // corner pin 4 coins : remplace pos/scale/rot/rot3d
  opacity?: Num
}

VideoClip      = Visual & { asset, src: [Ms, Ms], speed?: Num, fit?: "cover"|"contain"|"fill", volume?: Num }
AdjustmentClip = { id, at?: Ms, dur?: Ms, span?: [string, string], fx: {id, params?}[] }
OverlayClip    = Visual & { effect: string, params?: object }          // cadres, icônes 3D, HUD…
TextClip       = Visual & { text?: string, counter?: { from, to, suffix?, dur: Ms },
                            style: string,                              // un text_style du registre
                            reveal?: { by: "letters"|"words"|"lines", effect: string, stagger?: Ms },
                            fill?: { type: "color"|"gradient"|"media", ... }, stroke?: {...}, glow?: Num }
CaptionClip    = Visual & { from: string, style: string, emphasis?: [number, number] }
ShapeClip      = Visual & { space?: "2d"|"3d",
                            shape: { preset?: string, asset?: string, path?: [Ms, number, number][],
                                     morph?: { t: Ms, to: string }[], fill?: ..., stroke?: ..., extrude?: number } }
AudioClip      = { id, asset, src?: [Ms, Ms], at?: Ms, anchor?: ..., gain?: Num, fade?: [Ms, Ms] }
```

**Règle de timing.** Un clip est positionné par exactement **une** méthode : piste magnétique (aucun `at`), `at`+`dur`, ou `anchor` (+ `dur` optionnel). `AdjustmentClip` peut utiliser `span` : il suit les clips plutôt que des millisecondes.

**Moteur de rendu du texte.** Il n'est pas dans le JSON : il est déclaré par le `text_style`/`caption_style` (champ `engine`, section 11.1). Le JSON reste identique quel que soit le moteur.

### 5.5 Règles de résolution (à implémenter dans `engine.ts`)

1. **Deux espaces de temps.** Les mots vivent en temps *source* (dans l'asset). Le temps *timeline* d'un mot = `clip.at + (mot.s − clip.src[0]) / speed`, avec intégrale si `speed` est une rampe. **Toute** conversion source ↔ timeline passe par **une seule paire de fonctions** `srcToTimeline` / `timelineToSrc`.
2. **Piste magnétique.** Les clips s'enchaînent ; `at` est calculé (longueur de `src` intégrée par la vitesse). Une transition fait chevaucher les deux clips de `dur`.
3. **Ancres.** `anchor.words [i, j]` → début = début du mot `i` + `offset`, fin = fin du mot `j` (ou `dur`). Si les mots sortent de `clip.src`, le clip ancré n'est pas rendu et `validate()` émet un avertissement.
4. **Ordre de rendu.** Pistes du bas vers le haut. `grade` s'applique à l'image composée des pistes `video` uniquement. Un clip `adjustment` s'applique à tout ce qui est composé **en dessous** pendant sa durée. Overlays, textes, formes et captions se dessinent par-dessus.
5. **Suppression d'un clip référencé.** Les éléments qui s'y ancraient sont convertis en `at`/`dur` absolus (valeurs figées), jamais détruits.
6. **Coordonnées.** Normalisées 0..1, origine en haut à gauche, `pos` = centre. Éléments dessinés à la résolution du **canvas**, pas à celle du média. `fit` règle les médias vidéo.
7. **Le fps du canvas** est la référence ; les médias d'autre fps sont rééchantillonnés.
8. **Defaults** appliqués par le schéma (`fit: "cover"`, `z: 0`, `speed: 1`…). Le JSON demandé à l'IA reste le plus mince possible.
9. **Effet inconnu ou désactivé** (retiré du registre ou coupé par l'admin) : le moteur l'ignore avec un avertissement visible dans l'éditeur, sans crash. Un effet `deprecated` continue de se rendre.

### 5.6 Exemple minimal (doit passer la validation)

```json
{
  "v": 2,
  "canvas": { "w": 1080, "h": 1920, "fps": 30 },
  "assets": {
    "r1": { "type": "video", "w": 1920, "h": 1080, "dur": 42500, "fps": 30, "hasAudio": true,
            "bytes": 85000000, "fp": "…",
            "words": [ { "t": "Voici", "s": 0, "e": 320 }, { "t": "pourquoi", "s": 340, "e": 700 } ] },
    "r2": { "type": "video", "w": 1080, "h": 1920, "dur": 18000, "fps": 30, "hasAudio": true,
            "bytes": 42000000, "fp": "…" }
  },
  "grade": { "lut": "teal_orange", "amount": 0.7 },
  "tracks": [
    { "id": "v1", "kind": "video", "magnetic": true, "clips": [
      { "id": "c1", "asset": "r1", "src": [0, 3200], "speed": 1,
        "transform": { "scale": { "kf": [[0, 1], [3200, 1.15, "outCubic"]] } },
        "mesh": { "id": "cloth_wave_v1", "params": { "amp": 0.05 } } },
      { "id": "c2", "asset": "r2", "src": [5000, 9000] }
    ]},
    { "id": "adj1", "kind": "adjustment", "clips": [
      { "id": "a1", "span": ["c1", "c2"], "fx": [ { "id": "bw" } ] } ]},
    { "id": "txt", "kind": "text", "clips": [
      { "id": "t1", "anchor": { "clip": "c1", "words": [1, 1] },
        "text": "Pourquoi", "style": "big_number",
        "reveal": { "by": "letters", "effect": "rise", "stagger": 40 },
        "motion": { "preset": "pop_in" } } ]},
    { "id": "cap", "kind": "caption", "clips": [
      { "id": "k1", "from": "c1", "style": "kinetic_bold", "emphasis": [1, 1] } ]},
    { "id": "ov", "kind": "overlay", "clips": [
      { "id": "o1", "effect": "frame_neon_v1", "params": { "color": "#00F0FF" }, "at": 0, "dur": 3200, "blend": "add" } ]}
  ],
  "transitions": [ { "between": ["c1", "c2"], "effect": "glitch_cut", "dur": 200 } ]
}
```

Dans la phase 1, les effets ci-dessus peuvent ne pas exister encore : le moteur applique la règle 5.5.9.

---

## 6. Flux de bout en bout (local d'abord)

1. **Import.** L'utilisateur dépose des rushs. `media.probe(file)` lit `w`, `h`, `dur`, `fps`, `rot`, `hasAudio`, `bytes` et calcule `fp`. Champ optionnel « description » par rush. Les `File` restent **en mémoire** (objets adossés au disque, jamais d'`ArrayBuffer` complet) et sont copiés dans **OPFS** pour survivre à un rechargement ; demander `navigator.storage.persist()`.
2. **Source d'un asset** : `media.getSource(asset)` essaie dans l'ordre **mémoire → OPFS → téléchargement depuis `remote`**. Le téléchargement n'a lieu que si le fichier est introuvable localement (autre appareil, cache vidé) ; il est visible dans l'interface et compté dans le registre.
3. **Synchronisation en arrière-plan.** Dès l'import, l'original est envoyé au stockage par morceaux **reprenables** (URL signées), sans bloquer l'édition ni l'analyse. Progression visible (« synchronisé ✓ »). Quotas de stockage par plan.
4. **Proxy d'analyse (client).** `media.makeProxy(file)` ré-encode **uniquement pour l'IA** : petit côté (défaut **240 p**), `proxyFps` (défaut **12**), audio parole conservé (mono, débit modeste). L'original reste **intact** ; édition, preview et export lisent toujours l'original. Si WebCodecs est absent : message clair. **Aucune transformation côté stockage, aucun crédit de transformation.**
5. **Estimation et confirmation.** Avant l'analyse, l'app calcule les tokens estimés et les **crédits** (9.2) et demande confirmation. Les crédits sont **réservés**.
6. **Analyse.** `POST /api/analyze` crée un *job* lancé en tâche de fond ; le client interroge `GET /api/jobs/:id`. Le proxy peut partir **avant** que l'original ait fini de se synchroniser. Le serveur envoie les proxys à Gemini (API de fichiers, attendre l'état prêt), fait **un appel unique** (section 7), valide, fusionne, enregistre une **version `ai`**, règle les crédits sur les tokens réels.
7. **Édition.** L'éditeur charge la version, l'utilisateur modifie (patches), sauvegarde auto (debounce ~1,5 s, `rev`).
8. **Export.** Côté client : `renderFrame` image par image → WebCodecs → MP4, à partir des sources locales.

Statuts globaux (store) : `idle | importing | proxying | analyzing | ready | exporting | error`, avec progression et message ; la synchronisation a son propre indicateur par asset.

---

## 7. Analyse Gemini (`lib/gemini.ts`)

**Principe : un appel, la vidéo vers le JSON.** Gemini est le directeur artistique : il comprend le type de vidéo, transcrit, décide des cuts, du style, des effets, des SFX et des filtres, en suivant le `brief.prompt` de l'utilisateur. L'app fusionne et valide.

### 7.1 Entrée

Pour **chaque rush**, envoyer le proxy **et** un bloc texte :

```
RUSH r1 — desc: "<description utilisateur>" — w:1920 h:1080 — dur:42500ms — fps_source:30 — rot:0 — audio:oui
```

Puis le `brief` (plateforme, prompt, durée cible, style, langue) et le **catalogue**.

### 7.2 Catalogue et prompt système : générés automatiquement

`catalogForPrompt()` (dans `gemini.ts`) parcourt le **registre actif** (effets du code **moins** ceux désactivés dans `settings` par l'admin, **sans** les `deprecated`) et produit, pour chaque entrée : `id` **exact**, `kind`, `describe` (quand l'utiliser), **paramètres avec type, minimum, maximum et valeur par défaut** (tirés du zod de l'effet), puis pour les SFX : `id`, description et durée ; pour les LUT et styles : `id` et description. Format **compact** (une ligne par entrée). Le texte du prompt n'est jamais écrit à la main pour les effets.

- L'enum des `effect`/`id` de la réponse structurée est tiré du même registre : l'IA **ne peut pas** inventer un effet.
- Ajouter ou retirer un effet, ou le couper depuis l'admin, change le catalogue à la requête suivante, sans redéploiement.
- Le catalogue grossira : utiliser la mise en cache de contexte du fournisseur quand elle est disponible, et mesurer sa taille en tokens dans le registre.

### 7.3 Configuration `ANALYSIS` (constante unique)

Nom du modèle, `proxyShortSide` (240), `proxyFps` (12), **`samplingFps`** (défaut **4**, à tester à 2/4/12), résolution média (basse), température, timeouts, et les **constantes de tokenisation** (tokens par image selon la résolution, tokens audio par seconde, tarifs) **lues dans la documentation actuelle**.

Pourquoi `samplingFps` est distinct de `proxyFps` : le nombre d'images **réellement analysées** est un paramètre de l'appel, pas de la vidéo (par défaut l'API échantillonne à 1 image/s) ; la résolution source ne change pas le nombre de tokens par image, seulement la bande passante. Le coût suit `images analysées × tokens par image + audio`. À 12 images/s en basse résolution, c'est de l'ordre de 8 fois le coût d'un échantillonnage à 1 image/s. La précision d'un cut vient des mots et de l'audio, pas du nombre d'images : mesurer avant d'augmenter.

### 7.4 Sortie

L'IA produit **uniquement** la partie qui lui appartient : `words` par rush, `grade`, `tracks` (clips avec ancres sur index de mots), `transitions`. Jamais `w`, `h`, `dur`, `fp`, `proxy`, `remote`.

- Schéma de réponse **simplifié** dérivé de zod (limites de complexité des schémas structurés).
- Validation complète par zod. Échec → **une** nouvelle tentative en renvoyant l'erreur. Nouvel échec → **repli** : montage séquentiel simple des rushs, sans effets, et **remboursement** des crédits réservés.
- Valeurs hors bornes **ramenées dans les bornes**, pas rejetées.
- Chaque réponse brute est conservée (version `ai`) avec `model`, `tokensIn`, `tokensOut`, `latencyMs`, et écrit une ligne `ledger`.

### 7.5 Précision des temps

Les timestamps d'un LLM vidéo sont approximatifs. En v1 on les accepte, **on journalise** (versions + corrections manuelles) et on décidera avec les données s'il faut des signaux déterministes. Le schéma ancre déjà sur des index de mots, donc rien à migrer.

---

## 8. Rendu et éditeur

### 8.0 Pipeline de rendu : **texture d'abord** (`render.tsx`)

Principe fondamental : **tout clip est d'abord une texture**. Cela permet aux effets de modifier l'image elle-même (déformation incluse), pas seulement de superposer.

Pour chaque image de la timeline :
1. **Source → texture.** Chaque clip visible (vidéo, image, texte, forme, overlay) est rendu dans une *render target* (réservoir de textures réutilisées).
2. **Pile `fx` (texture → texture).** Les effets `fx` du clip s'enchaînent en ping-pong (UV warp, aberration chromatique, LUT locale, etc.).
3. **Présentation.** La texture est plaquée sur une géométrie : par défaut un **quad plat** positionné par `transform` (pos, scale, rot, rot3d + perspective, ou `corners` pour le corner pin). Si le clip a un `mesh`, cet effet **remplace la géométrie** : plan subdivisé déformé en vertex shader (drap, vague, page qui se plie, drapeau) ou **modèle 3D** sur lequel la vidéo est projetée (tapis, écran, objet).
4. **Composition** dans l'ordre des pistes, avec `blend` et `matte` ; les `adjustment` s'appliquent à l'accumulé en dessous ; le `grade` clôt les pistes vidéo ; puis overlays, textes, captions.
5. **Budget mobile.** Nombre maximal de render targets simultanées et résolution réduite en preview ; effets `cost: "heavy"` désactivables ; l'export rend à pleine résolution.

`FrameSource.get(assetId, srcMs)` fournit les images sources : implémentation `<video>` pour la preview, WebCodecs (exacte à l'image) pour l'export. Les deux appellent le même `renderFrame`.

### 8.1 Texte
Trois moteurs, choisis par le style (pas par le JSON) :
- **`canvas`** (défaut) : dessin 2D en texture. Toutes polices, dégradés, contours, ombres, animation lettre par lettre, et **rendu correct de l'arabe** (mise en forme du navigateur).
- **`sdf`** : texte SDF (troika) pour les effets par glyphe et les shaders. **Tester l'arabe** avant de l'autoriser pour des sous-titres.
- **`extrude`** : lettres 3D extrudées pour titres héros ; polices limitées, arabe probablement non supporté.
Le **DOM** sert uniquement à éditer le texte à l'écran dans l'interface, jamais au rendu ni à l'export. Les polices sont chargées (API `FontFace`) avant tout rendu.

### 8.2 Éditeur
- Fonctionne sur le JSON uniquement. **Inspector** : formulaires générés depuis les `zod` des effets (curseurs bornés) ; onglet **JSON** (lecture, édition avec validation zod en direct).
- Raccourcis : espace, `S` (couper), `Suppr`, `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`.
- Appliquer le résultat de l'IA = **un seul patch**.
- **Timeline** : pistes empilées, clips déplaçables, rognage, coupe au playhead, zoom, snapping (playhead, bords, mots), mute/lock, ripple sur la piste magnétique, mots des captions visibles et éditables (texte seulement).
- **Preview** : canvas 9:16, lecture/pause/scrub, audio synchronisé, résolution réduite.

### 8.3 Export
MP4 H.264 + AAC, 1080×1920 @30 par défaut (720p en option), progression, annulation, téléchargement. Audio : mixage hors-ligne (clips, SFX, gains, fades). Filigrane si le plan n'autorise pas l'export propre. Si WebCodecs est absent : message clair (pas de repli en v1). L'export n'a pas de coût serveur et ne consomme pas de crédits.

### 8.4 Historique et versions (avant/après)
- **Annuler/rétablir** : pile de patches en mémoire (≈ 200).
- **Versions persistantes** : `ai` (sortie IA), `auto` (sauvegarde auto, les 50 dernières), `manual` (nommées).
- **Comparaison A/B** : deux versions, la preview bascule (ou écran partagé). « Original » = rushs bruts enchaînés, sans IA.
- **Restaurer** crée une nouvelle version (rien n'est écrasé).

### 8.5 Chargements et erreurs
Loaders par statut, erreurs explicites et actionnables, indicateur de sauvegarde (« enregistré / en cours / échec »), conflit `rev` (409 → recharger ou forcer), fichier manquant (redemander le rush, ou le télécharger depuis le cloud).

---

## 9. Données, API, crédits, admin

### 9.1 Collections (Mongoose)
`users` (Auth.js + `prefs`, `plan`, `role: "user" | "admin"`, `credits`, `storageBytes`, `suspended`, `sessionVersion`), `projects`, `versions`, `jobs`, `ledger` (mouvements de crédits et coûts), `events` (`project_created`, `analysis_done`, `export_done`…), `settings` (document unique : tarifs, quotas par plan, durée d'inactivité avant purge, effets désactivés), `ratelimits` (compteurs à expiration automatique, voir 9.6).

Admin : `role` posé à l'inscription si l'email figure dans la variable `ADMIN_EMAILS` ; **toujours vérifié côté serveur**.

### 9.2 Crédits et coûts (`billing.ts`)
- **Unité** : le crédit. Les **tarifs en crédits par action** (analyse par minute de vidéo, génération, stockage par Go et par mois) sont dans `settings`, modifiables depuis l'admin.
- **Estimer** (`estimateAnalysis`) avant l'appel : tokens prévus (formule 7.3) → crédits. L'utilisateur confirme.
- **Réserver** les crédits au lancement du job, **régler** sur les tokens réels à la fin, **rembourser** en cas d'échec ou de repli. Solde insuffisant ou compte suspendu → aucun appel IA.
- **Registre** `ledger` : `{ userId, kind: "spend"|"grant"|"refund", action, credits, costUsd?, tokensIn?, tokensOut?, bytes?, refId?, ts }`. `costUsd` = tokens × tarifs de `settings`, ou octets × tarif de stockage.
- **Stockage** : compteur `storageBytes` par utilisateur, quota par plan, **purge** des rushs après la durée d'inactivité (tâche planifiée protégée par secret, `/api/cron/cleanup`).
- L'utilisateur voit son solde et son historique dans le dashboard.

### 9.3 Paiement (`PaymentProvider`, interface dans `billing.ts`)
```ts
interface PaymentProvider {
  createCheckout(user: User, packId: string): Promise<{ url: string }>;
  handleWebhook(req: Request): Promise<{ userId: string; packId: string; amount: number; currency: string; ref: string } | null>;
  portalUrl?(user: User): Promise<string>;
}
```
Le webhook crédite le compte et écrit une ligne `ledger` (`grant`, action `purchase`). **v1 : adaptateur `manual`** (l'admin accorde des crédits à la main) ; l'adaptateur réel se branche ensuite sans toucher au reste. **Attention** : Stripe n'ouvre pas de compte marchand pour une entité établie au Maroc (vérifié le 3 oct. 2026, à reconfirmer sur la page officielle de Stripe) ; options usuelles : société dans un pays supporté (ex. Stripe Atlas) ou prestataire *Merchant of Record*. Décision du propriétaire (D5).

### 9.4 Espace admin (`app/admin/page.tsx`, un seul fichier)
- **Utilisateurs** : plan, solde de crédits, **consommation et coût estimé par utilisateur** (tokens, stockage), revenus encaissés, **marge**.
- Actions : accorder/retirer des crédits, changer de plan, suspendre, supprimer.
- **Tarifs et quotas** : modifier les tarifs en crédits, les quotas par plan, la durée avant purge.
- **Effets** : liste du registre avec **interrupteur** (désactiver un effet bancal sans redéployer), indication `deprecated`, taille du catalogue en tokens.
- **Jobs** : liste, erreurs, relance, coût par job.
- **Santé** : présence des clés, dernier appel IA, erreurs récentes.

### 9.5 Routes (toutes dans `api/[[...path]]/route.ts`, table en commentaire en tête)

```
GET    /api/me                         Profil, crédits, consommation
PATCH  /api/me                         Préférences
DELETE /api/me                         Supprime compte et toutes les données
GET    /api/projects                   Liste (sans doc)
POST   /api/projects                   Crée
GET    /api/projects/:id               Projet complet
PATCH  /api/projects/:id               { rev, doc? | name? | brief? } → 409 si rev ≠
DELETE /api/projects/:id
GET    /api/projects/:id/versions
POST   /api/projects/:id/versions      Version manuelle { label, doc }
POST   /api/projects/:id/restore/:vid
POST   /api/upload/sign                { projectId, assetId, kind: "original"|"proxy", size, type, part? }
POST   /api/analyze/estimate           { projectId } → { tokens, credits }
POST   /api/analyze                    { projectId } → { jobId }
GET    /api/jobs/:id                   Statut, progression, versionId
POST   /api/generate                   Phase 2 (stub : { projectId, assetId } → job)
POST   /api/billing/checkout           { packId } → { url }
POST   /api/billing/webhook            Appelé par le fournisseur de paiement
GET    /api/admin/stats                (admin) agrégats : coûts, revenus, marge
GET    /api/admin/users                (admin) liste et consommation
PATCH  /api/admin/users/:id            (admin) crédits, plan, suspension
PATCH  /api/admin/settings             (admin) tarifs, quotas, effets désactivés
GET    /api/admin/jobs                 (admin)
POST   /api/cron/cleanup               Purge d'inactivité (secret)
```

**Quotas et limites** : limite quotidienne d'analyses, taille et durée maximales des proxys, limite de fréquence par utilisateur. Dépassement → message clair, jamais d'appel IA.

**Profil** : nom, avatar (Google), plateforme et langue par défaut, plan, solde et historique de crédits, stockage utilisé, suppression du compte.

**Landing** : promesse, démo (placeholder), « comment ça marche » en 3 étapes, offre gratuite, tarifs en crédits, bouton Google, liens légaux. Mobile d'abord.

### 9.6 Sécurité et performance (petite couche, sans prouesses)

Objectif : un socle raisonnable avec peu de code. Tout vit dans `api/[[...path]]/route.ts` (fonction `guard()` appelée par **chaque** route), `auth.ts` et `next.config.ts`. **Aucun nouveau fichier.**

**Sessions et jetons**
- Connexion Google uniquement (aucun mot de passe stocké). Sessions JWT dans des cookies `httpOnly`, `Secure`, `SameSite=Lax` (réglages par défaut d'Auth.js, à ne pas affaiblir). Aucun jeton ni clé dans `localStorage` ou dans le code client.
- Durée de vie 7 jours, renouvelée au plus une fois par jour. Le JWT ne contient que `userId` et `sessionVersion`.
- **Révocation** : `users.sessionVersion` est comparé à celui du jeton ; l'incrémenter (déconnexion partout, suspension, suspicion de fuite) invalide toutes les sessions. Vérification de `suspended` et `sessionVersion` mise en cache 60 s.
- Le rôle `admin` n'est **jamais** lu depuis le jeton : il est relu en base à chaque requête admin.
- `AUTH_SECRET` long et aléatoire ; procédure de rotation notée dans `.env.example`.
- Pour toute requête qui modifie des données : l'en-tête `Origin` doit correspondre à `APP_ORIGIN` et le `Content-Type` doit être `application/json`. Pas de CORS ouvert.

**Limiteur de débit.** Compteurs dans la collection `ratelimits` avec expiration automatique (index TTL) : fonctionne en serverless, contrairement à une mémoire locale. Clé = classe de route + `userId` (ou IP si non connecté). Dépassement → **429** + en-tête `Retry-After` ; l'interface affiche un compte à rebours. Valeurs de départ, regroupées dans une constante `LIMITS` en tête du fichier d'API :

| Cible | Limite | Sanction |
|---|---|---|
| Échecs de connexion (callback Auth.js en erreur ou refusé), par IP | 5 en 5 min | **blocage de 2 min** pour cette IP |
| Routes d'authentification, par IP | 30 / min | 429 |
| API connecté, par utilisateur | 120 / min | 429 |
| API non connecté, par IP | 30 / min | 429 |
| `/api/analyze` | 3 lancements / 10 min et **1 job actif** par utilisateur | 429 |
| `/api/upload/sign` | 60 / 10 min ; quota de stockage vérifié avant de signer | 429 / 402 |
| `/api/generate`, `/api/billing/checkout` | 10 / 10 min | 429 |
| Routes admin | 60 / min | 429 |

L'IP est lue dans l'en-tête fourni par l'hébergeur, jamais dans un en-tête arbitraire envoyé par le client. Le webhook de paiement n'est pas limité par IP : **signature obligatoire** et idempotence par `ref`.

**Attaques par volume (niveau raisonnable)**
- La protection réseau contre le DoS relève de la **configuration**, pas du code : activer le pare-feu et la protection anti-bot de l'hébergeur, ou placer le domaine derrière Cloudflare (l'offre gratuite inclut une protection de base).
- Côté application : corps de requête limité (document ≤ 1 Mo), plafonds dans le schéma (nombre de pistes et de clips, longueur des textes), pages de liste plafonnées, zod en mode strict (champs inconnus rejetés), un job IA actif par utilisateur et un plafond global de jobs simultanés (au-delà : file d'attente ou 503).
- Les abus de coût sont couverts par les crédits et quotas (9.2).

**Données et fichiers**
- Bucket R2 **privé** ; accès uniquement par URL signées de courte durée (15 min), liées à une clé précise, une taille maximale et un type de contenu vérifiés côté serveur ; tâche de purge des envois orphelins.
- Requêtes Mongo typées : ne jamais injecter un objet venu du client dans un filtre (rejeter les clés commençant par `$`). Propriété du projet vérifiée à chaque accès.
- Le contenu venant de l'utilisateur (textes, SVG, Lottie) n'est **jamais** inséré dans le DOM comme HTML ; pas de `dangerouslySetInnerHTML`. Les SVG et Lottie sont rastérisés par décodage d'image, leurs scripts éventuels sont ignorés.
- **Injection de prompt** : les vidéos et le `brief.prompt` sont des données, pas des instructions. La sortie de Gemini n'est jamais exécutée : seule la validation zod avec enum du registre la fait entrer dans le projet.
- Secrets uniquement en variables d'environnement ; ne jamais journaliser jetons, clés ni contenu des rushs.
- En-têtes dans `next.config.ts` : CSP restrictive (autorisant le domaine R2, `blob:` et les workers/WASM nécessaires), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `frame-ancestors 'none'`, `Permissions-Policy`.
- **Journal d'audit** : les actions admin (crédits accordés, suspension, changement de tarif, interrupteur d'effet) écrivent un événement `admin_action` (qui, quoi, quand).
- Suppression de compte : supprime aussi les objets R2 et toutes les données liées. Sauvegardes Atlas activées (configuration).

**Cache et rapidité**
- Listes : projection sans `doc`, pagination (20 par page), `lean()`, index `projects(ownerId, updatedAt)`, `versions(projectId, createdAt)`, `ledger(userId, ts)`, `jobs(userId, status)`, TTL sur `ratelimits` et `events`.
- `GET /api/projects/:id` renvoie `ETag = rev` (réponse 304 si inchangé). Versions : métadonnées d'abord, document à la demande. Réponses personnelles en `Cache-Control: private, no-store`.
- `settings` mis en cache mémoire 30 à 60 s (une modification admin est immédiate sur l'instance concernée, sous 60 s ailleurs). Le catalogue du prompt est calculé une fois par processus et invalidé quand le registre ou la liste des effets désactivés change.
- Statiques (SFX, LUT, polices, modèles 3D) dans `public/` avec nom versionné (`_v1`) et `Cache-Control: public, max-age=31536000, immutable`.
- Client : réservoir de textures réutilisé, shaders compilés une seule fois, sons décodés gardés en mémoire, sources en OPFS (section 6), sauvegarde auto avec debounce.

---

## 10. Phase 1 — Jalons et critères d'acceptation

| # | Jalon | Terminé quand |
|---|---|---|
| M1 | Base : landing, auth Google, dashboard, `db.ts` (Mongoose), `legal` | Connexion, création/suppression de projet, profil modifiable, suppression de compte |
| M2 | `schema.ts` + `engine.ts` + tests | L'exemple 5.6 valide ; tests : `srcToTimeline` (vitesse constante et rampe), ancres, piste magnétique, suppression d'un clip référencé, effet inconnu ignoré, `migrate` |
| M3 | `store.ts` + Editor/Timeline/Inspector | Édition complète sur un JSON d'exemple, undo/redo, onglet JSON, sauvegarde auto avec `rev` |
| M4 | `render.tsx` + Preview + export | Pipeline texture d'abord ; preview fluide ; export MP4 identique à la preview image par image ; audio mixé ; filigrane ; un effet `mesh` de démonstration prouve la déformation |
| M5 | `media.ts` + `gemini.ts` + `/api/analyze` | Du dépôt de rushs à une version `ai` éditable ; local d'abord, sync en arrière-plan ; catalogue auto ; repli fonctionnel ; réponses brutes et coûts journalisés |
| M6 | `billing.ts` + dashboard crédits + `admin` | Estimation, réservation, règlement, remboursement ; adaptateur `manual` ; admin complet (9.4) ; interrupteur d'effet qui modifie le catalogue IA |
| M7 | Versions, comparaison A/B, durcissement | Historique, A/B, restauration, quotas, purge d'inactivité, erreurs, états de chargement ; limiteur de débit testé (429 + `Retry-After`, blocage 2 min après 5 échecs de connexion), en-têtes de sécurité, révocation par `sessionVersion`, cache (9.6) |
| M8 | Contrat d'effet validé | Trois effets de démonstration (un `fx`, un `overlay`, un `mesh`) ajoutés **chacun en 1 fichier + 1 ligne**, visibles dans l'Inspector, le catalogue IA et l'admin |

Règle de livraison : à la fin de chaque jalon, la carte (section 4) et les décisions (section 12) sont à jour.

---

## 11. Phase 2 — Effets, un par un

### 11.1 Contrat (défini dans `lib/schema.ts`)

```ts
defineEffect({
  id: "chromatic_aberration_v1",     // unique, suffixe de version
  kind: "fx",                        // fx | mesh | overlay | transition | caption_style | text_style
                                     // | shape_preset | motion_preset | lut | sfx
  status: "active",                  // "active" | "deprecated" (masqué à l'IA, se rend encore)
  describe: "Séparation RVB sur les impacts ; à utiliser sur un mot choc ou un cut.",
                                     // 1 phrase lue par Gemini : QUAND l'utiliser
  params: z.object({ intensity: z.number().min(0).max(1).default(0.5) }),
                                     // bornes obligatoires ; tout numérique est animable
  cost: "light",                     // "heavy" = désactivé en preview sur appareil faible

  // selon le kind :
  shader: "…GLSL fragment…",         // fx / transition : texture → texture
  mesh: { segments: [64, 64], vertex: "…GLSL vertex…" },
                                     // kind "mesh" : déformation de sommets (drap, vague, drapeau)
  Component: undefined,              // overlay, caption_style, text_style, mesh à base de modèle 3D :
                                     //   composant R3F ({ texture, params, t, size })
  engine: "canvas",                  // text_style / caption_style : "canvas" | "sdf" | "extrude"
  url: undefined,                    // lut (.cube/.png) ou sfx (.mp3 dans public/sfx)
  duration: undefined,               // sfx : durée en ms (lue par l'IA)
  fonts: [],                         // chargées avant le rendu
})
```

À partir de ce seul fichier : le formulaire de l'Inspector, l'enum et le catalogue de l'IA (7.2), l'interrupteur de l'admin et le rendu sont générés.

### 11.2 Procédure pour chaque effet
1. Créer `effects/<id>.ts(x)` ; ajouter **une ligne** dans `effects/index.ts`.
2. Vérifier : fonction pure du temps (aucun aléa non seedé), paramètres bornés avec valeurs par défaut, rendu correct à 3 résolutions, `cost` renseigné, `describe` utile à l'IA.
3. Tester sur un projet d'exemple, preview **et** export.
4. Cocher la case dans le backlog ci-dessous.

### 11.3 Backlog (dans l'ordre)
- [ ] **fx** : `zoom_punch`, `shake`, `chromatic_aberration`, `negative`, `bw`, `vignette`, `film_grain`
- [ ] **lut** : 5 à 8 looks (teal & orange, cinéma froid, chaud, noir et blanc contrasté…)
- [ ] **caption_style** : `kinetic_bold`, `karaoke_highlight`, `minimal_clean` (tester l'arabe/darija)
- [ ] **text_style** : `big_number`, `digital_hud`, reveals (lettres, mots, lignes), `counter`
- [ ] **overlay** : `frame_neon`, `viewfinder` (cadre caméra), bordures lumineuses
- [ ] **transition** : `glitch_cut`, `whip`, `zoom_blur`, `flash`
- [ ] **sfx** : bibliothèque d'une vingtaine de sons libres de droits (vérifier chaque licence)
- [ ] **shape_preset** : `arrow`, `circle`, `underline`, `cursor_trail` (+ morph vers cercle/main)
- [ ] **fx shader** : `uv_warp` (vague, étirement)
- [ ] **mesh** : `cloth_wave` (drap), `flag`, `page_curl`, `video_on_model` (vidéo projetée sur un modèle 3D comme un tapis) ; vraie simulation physique de tissu = effet `heavy`, plus tard
- [ ] **svg / lottie** : support des assets, dégradés et couleurs animées
- [ ] **model3d** : icônes 3D (modèles glb libres, vérifier la licence)
- [ ] **text engines** : `sdf` puis `extrude`
- [ ] **matte / fill média / blend modes**
- [ ] **corner pin éditable**
- [ ] **`behind` (rotoscopie)** : segmentation par l'app, masque calculé à basse résolution avec cache ; expérimental sur mobile
- [ ] **`generated`** : appel d'API de génération, jobs asynchrones, états `pending/ready/failed`, crédits et coûts, stockage, repli en cas d'échec

---

## 12. Décisions prises (à confirmer par le propriétaire)

| # | Sujet | Décision par défaut |
|---|---|---|
| D1 | Rushs : où vivent-ils ? | **Local d'abord** (mémoire + OPFS) pour éditer, prévisualiser, exporter ; **copie cloud en arrière-plan** pour l'édition multi-appareil. On ne retélécharge que si le fichier local manque. Évite l'aller-retour upload/téléchargement et la facture de bande passante. |
| D2 | Export côté client | Oui. **Le filigrane est contournable** côté client ; acceptable en v1, sinon rendu serveur payant plus tard. |
| D3 | Coût de l'analyse | Proxy client 240 p / 12 fps ; **échantillonnage 4 fps** par défaut (réglable) ; estimation et confirmation de crédits avant chaque analyse ; mesurer tokens/minute sur un jeu d'évaluation avant de fixer les tarifs. |
| D4 | Stockage | **Cloudflare R2 validé** (bucket privé, URL signées, envoi par morceaux, frais de sortie nuls). Cloudinary n'est pas utilisé pour la vidéo (limite d'upload de 100 Mo en gratuit, crédits partagés) ; éventuellement images et vignettes plus tard. **Aucune transformation côté stockage** : le navigateur fabrique le proxy. L'accès à l'original passe par une simple clé `remote` derrière un seul module, donc un changement de fournisseur reste une copie de fichiers. |
| D5 | Paiement | Interface `PaymentProvider` + adaptateur `manual` en v1. Stripe indisponible pour un marchand marocain : choisir société étrangère (Atlas) ou *Merchant of Record*, puis écrire l'adaptateur. |
| D6 | Sessions | JWT. |
| D7 | Langue de l'interface | Français uniquement en v1. |
| D8 | Musique | Pas de bibliothèque en v1 (licences). L'utilisateur peut importer son propre audio. |
| D9 | Mesure du produit | Événements dans `events` pour savoir si les gens reviennent (projets créés, analyses, exports). |
| D10 | Légal | Page `legal` : confidentialité (envoi des proxys à un tiers, durée de conservation, suppression), conditions, remboursements ; indispensable pour l'écran de consentement Google et pour vendre des crédits. |
| D11 | Tests | Uniquement `engine` et `schema`. |
| D12 | Piste vidéo magnétique | Oui, par défaut sur la piste principale. |
| D13 | Rendu texture d'abord | Oui : condition pour les effets de déformation (`mesh`) et le corner pin ; coût mobile maîtrisé par un réservoir de textures et des classes de coût. |
| D14 | Texte | Moteur `canvas` par défaut ; `sdf` et `extrude` en option ; DOM jamais pour le rendu. |
| D15 | Sécurité | Petite couche (9.6) : limiteur en base avec TTL, sessions JWT révocables, en-têtes, audit admin. Protection DoS réseau par configuration de l'hébergeur ou de Cloudflare. Pas de 2FA ni de pare-feu sur mesure en v1. |

Hors périmètre v1 : collaboration en équipe, application native, rendu serveur, bibliothèque musicale, multi-langues de l'interface, marketplace d'effets, adaptateur de paiement réel (l'interface est prête), 2FA, pare-feu applicatif sur mesure, audit de sécurité externe.

---

## 13. Premier pas conseillé

1. Crée le squelette de la section 4 avec les en-têtes de fichier (rôle, contenu, exclusions) et des corps vides.
2. Écris `schema.ts` complet (section 5) + l'exemple 5.6 + les tests de `engine.ts` **avant** l'interface.
3. Avance jalon par jalon (section 10). Demande confirmation au propriétaire sur D1, D2 et D5 **avant** M4.

## 12 bis. Décisions prises pendant la construction

| # | Sujet | Décision |
|---|---|---|
| D16 | Fichiers ajoutés | `components/Dashboard.tsx` et `components/Admin.tsx` : les pages `dashboard/page.tsx` et `admin/page.tsx` restent **serveur** (garde d'accès, pas de middleware) et montent ces composants client. Tests dans `lib/engine.test.ts`. Configs ajoutées : `next.config.ts`, `postcss.config.mjs`, `vitest.config.mts`. |
| D17 | Dépendances ajoutées | `aws4fetch` (signature R2/S3 sans SDK lourd) ; `@auth/mongodb-adapter` ; **Mongoose 8** (l'adaptateur Auth.js exige le driver MongoDB 6) ; `next-auth@beta` (Auth.js v5) ; Next 16. |
| D18 | Modèle d'analyse | `gemini-3.8-flash` dans `ANALYSIS.model` (doc Gemini consultée le 3 oct. 2026). `tokensPerFrame: 66` et `audioTokensPerSec: 32` sont à relire dans la doc et à mesurer avant de fixer les tarifs. |
| D19 | Rendu, phase 1 | Fait : texture d'abord, fx en ping-pong, mesh, corner pin, blend normal/add/screen/multiply, adjustment, grade, transitions (fondu + shaders), texte et sous-titres canvas. **Reporté en phase 2** : `matte`, `behind`, `shape`, `Component` R3F d'overlay (les overlays passent par un `shader` plein cadre), moteurs `sdf`/`extrude`, `pivot`, blend `overlay` (rendu comme `normal`). |
| D20 | Convention de shaders | Décrite en tête de `lib/schema.ts` : `fx(vec2 uv)` pour fx/lut/overlay/transition, `deform(vec3 p, vec2 uv)` pour mesh ; un uniform est déclaré automatiquement par paramètre. |
| D21 | Routes ajoutées | `POST /api/events`, `GET /api/projects/:id/versions/:vid`, `POST /api/admin/jobs/:id/retry`. Envoi/téléchargement R2 via `POST /api/upload/sign` (`action` = put, init, part, complete, done, get). **CORS R2** : autoriser PUT/GET depuis `APP_ORIGIN` et exposer `ETag`. |
| D22 | Vérifié / non vérifié | Passent : build de production, typage strict, 15 tests engine+schema, démarrage du serveur, landing, en-têtes de sécurité, rejet d'origine. **Non testés** (ni navigateur ni clés dans mon environnement) : rendu WebGL, export WebCodecs, Google OAuth, R2, Gemini, MongoDB. Prévoir une passe manuelle par jalon. |
| D23 | Chemins des vidéos | **Aucune URL n'est stockée dans le JSON** (une URL signée expire en 15 min). Un asset porte une empreinte `fp` (SHA-256 de la taille, du nom, de la date et des 64 Ko de début et de fin) et, une fois synchronisé, des clés R2 `remote` / `proxy` de la forme `u/<userId>/<projectId>/<assetId>/<original|proxy>`. Résolution à la lecture (`media.ts › getFile`) : mémoire → OPFS (copie locale persistante, nommée par `fp`) → téléchargement via URL signée générée à la demande par `POST /api/upload/sign` (`action: "get"`). Le projet d'exemple n'a ni fichier ni clé : ses rushs s'affichent « Exemple : aucune vidéo réelle » et le bouton « Relier une vraie vidéo » remplace leurs métadonnées par celles du fichier choisi. |
| D24 | MongoDB et objets vides | Mongoose supprimait `assets: {}` des documents enregistrés (option `minimize`). Corrigé par `minimize: false` sur Project et Version, **et** par un `migrate()` tolérant (il remet `assets`, `transitions`, `clips`, `canvas` manquants) utilisé par toutes les lectures de document. Un projet illisible affiche un message, plus un 404. |
| D25 | Rendu : deux causes d'écran noir corrigées | (1) `Editor` s'abonnait au store entier (donc à `t`, qui change à chaque image) et passait une nouvelle fonction à l'aperçu : la source vidéo était détruite et recréée à chaque image. Abonnement ciblé (`useShallow`) + callbacks stables (refs). (2) three.js capture `material.uniforms` au premier rendu : les réassigner figeait les valeurs sur la 1re image et mélangeait texte et vidéo. Les valeurs sont maintenant copiées dans les uniforms existants (`setUniforms`) ; `store.test.ts` interdit toute réassignation. |
| D26 | Proxy d'analyse | Format choisi selon ce que le navigateur sait encoder : MP4 (H.264 + AAC), sinon WebM (VP9/VP8 + Opus). Le type MIME réel est envoyé à R2 puis à Gemini. En cas d'échec, le message donne la vraie raison (codec non décodable, souvent HEVC/H.265). L'analyse ne porte que sur les rushs **placés dans la timeline**. |
| D27 | Pistes et rushs | Ajouter une piste crée toujours un élément par défaut éditable (texte, sous-titres, overlay, calque d'effets, vidéo) ; si c'est impossible, rien n'est créé. Sous-titres sans transcription : 3 mots d'exemple visibles, remplacés par la vraie parole à l'analyse. Audio : import d'un fichier son (stocké localement). « Formes » retiré du menu (non rendu en phase 1). Supprimer un rush retire ses clips, son état de synchro et ses fichiers cloud (`DELETE /api/projects/:id/assets/:assetId`). |
| D28 | Images et sons | Assets `image` et `audio` de première classe (name, bytes, fp, remote). Import unique « Ajouter des médias » (vidéo, image, son aiguillés par type) ; images et sons suivent le même chemin que les vidéos (mémoire → OPFS → R2 par URL signée) et sont synchronisés en arrière-plan. Une image se place dans un clip de piste vidéo (`src: [0, durée]`, fit `contain`) et reçoit donc tous les effets, déformations, animations et blends ; elle est rendue en aperçu (`Image` → texture) et à l'export (canvas → texture). Le son est lu en aperçu par `<audio>` et mixé hors-ligne à l'export (`OfflineAudioContext`). Le montage IA conserve les pistes d'images et de sons ajoutées à la main (il ne les voit pas). |
| D29 | Temps entiers | `lib/normalize.ts` arrondit tous les temps du document (at, dur, src, fondus, ancres, images clés, transitions, mots) après CHAQUE modification (`store.apply`) et à la lecture (`migrate`). Un glisser-déposer à la souris produit des décimales : elles ne sortent plus du store, et les documents déjà abîmés sont réparés à l'ouverture. |
| D30 | L'IA voit tous les médias | Vidéos (proxys), **images** (JPEG réduit à 768 px) et **sons** (WAV mono 16 kHz) placés sur la timeline sont envoyés à Gemini avec leur description ; l'IA les place elle-même (images en piste vidéo libre, sons en piste audio avec `gain`/`fade`/`afx`). Les médias non utilisés par l'IA que l'utilisateur avait placés sont conservés. Certaines offres Gemini limitent le nombre de fichiers audio par requête : en cas d'erreur 400 « audio », l'analyse est retentée avec un seul son (sans consommer d'essai). **À vérifier avec ta clé.** |
| D31 | Replis IA réglables | Admin › Tarifs et quotas › « Analyse IA » : modèle principal, **nombre de replis 0 à 2**, modèles de repli, délai entre essais. Seules les erreurs passagères (503, 429, 500, 504, UNAVAILABLE…) déclenchent un repli ; une erreur de requête (400, 403) échoue tout de suite. Message utilisateur lisible, crédits remboursés. Défauts vérifiés dans la doc Gemini : `gemini-3.8-flash` → `gemini-3.7-flash` → `gemini-3.5-flash`. |
| D32 | Effets audio | Nouveau type `audio_fx` (graphe Web Audio, `afx` sur clips vidéo et audio), lecture temps réel (`MediaElementAudioSourceNode`) et export hors-ligne (`OfflineAudioContext`, un bus par clip). Fournis : echo, delay, reverb_room, radio_voice, autotune (AudioWorklet, moteur testé sur sinusoïdes). CSP : `script-src blob:` pour charger le worklet. Réglages constants. Un effet qui échoue renvoie le son non modifié (jamais de silence). |
| D33 | Forme d'onde | Calculée une fois par fichier (crêtes par tranche de 50 ms, en flux) et dessinée dans les clips audio de la timeline. |
| D34 | Paiement : Polar | **Polar** (Merchant of Record, accepte les particuliers, versement possible au Maroc via Stripe Connect Express) : il encaisse, gère la TVA et les litiges, puis appelle `POST /api/billing/webhook`. Checkout hébergé (aucune donnée de carte chez nous), portail client pour factures et résiliation. SDK `@polar-sh/sdk/2026-10`. Sans `POLAR_ACCESS_TOKEN`, repli sur « manuel » (l'admin accorde les crédits). Vente en USD. |
| D35 | Interrupteurs de paiement | Admin › Tarifs et quotas › Paiement. **Paiement en une fois : ACTIF par défaut** (aucun prélèvement sans consentement). **Abonnements : INACTIFS par défaut.** Désactiver les abonnements ne suspend personne : `cancel_at_period_end` est posé chez Polar pour chaque abonné actif (pas de renouvellement), l'offre reste active jusqu'à la fin de la période payée, puis retour à l'offre gratuite à l'événement `subscription.revoked`. Un renouvellement qui arriverait quand même est honoré (crédits donnés) et le suivant est annulé. |
| D36 | Règles de paiement | Produits identifiés par l'**ID produit Polar** saisi dans l'admin (jamais par des métadonnées). Idempotence par `order.id` dans le registre. Remboursement : crédits retirés au prorata, une seule fois par montant remboursé (le solde peut devenir négatif et bloque l'usage). Événement plus ancien que l'état connu ignoré. Les crédits d'abonnement n'expirent pas. Le prix affiché dans l'app est indicatif : **seul le prix du produit Polar est facturé**. |
| D37 | Génération de médias | `POST /api/generate` (image ou vidéo) : crédits réservés, tâche suivie par `GET /api/jobs/:id`, résultat stocké dans R2 puis ajouté au projet côté client (aucune écriture serveur dans le document : pas de conflit avec la sauvegarde auto). Images via l'**API Interactions** de Gemini (`gemini-3.1-flash-lite-image` par défaut, 1K), vidéos via **Veo** (`veo-3.1-fast-generate-preview`, 720p, 4/6/8 s). **La vidéo est une opération longue : chaque interrogation du client la fait avancer d'un cran** (pas de tâche de fond qui dépasserait la durée maximale de la fonction). Abandon et remboursement après 12 min. Réglages admin : modèles, crédits par image / par seconde, durée max, quotas journaliers, vidéo réservée aux comptes payants (par défaut). |
| D38 | L'IA propose, l'utilisateur décide | Après l'analyse, l'IA peut **suggérer** jusqu'à 4 illustrations (prompt, raison, instant) ; rien n'est généré sans clic et le coût est affiché. Toutes les images générées portent un filigrane invisible SynthID posé par Google. |
| D39 | Gestes de la timeline | Réordonner les pistes (poignée ⠿ + flèches ▲▼ ; le haut de la liste = premier plan), glisser un clip vers une autre piste du même type (piste principale : insertion selon le centre du clip, `at`/`dur` retirés ou figés, transitions du clip supprimées), glisser un média depuis l'onglet Médias vers une piste compatible (ou vers une zone vide : piste créée), remplacer le média d'un clip (position, effets et durée conservés). |
| D40 | Tous les types d'effets visibles | Onglet **Effets** : 11 types regroupés (images, looks, transitions, overlays, déformations, animations, styles de texte et de sous-titres, formes, effets audio, sons), recherche, « Appliquer » selon la sélection. Un type sans effet disponible n'est pas affiché. Menus « remplacer » dans l'Inspector pour fx, déformation, overlay, effet audio. Transitions réglables dans l'Inspector (effet + durée). Ajout de `crossfade_v1` et `slide_v1`. |
