# MotionIA — Guide pour créer un effet ou un élément

> **Ce document est autonome.** Une IA qui ne voit aucun autre fichier du projet peut, avec lui seul, écrire un effet correct et savoir exactement ce qu'elle peut (et ne peut pas) manipuler.
> Il décrit l'état réel du code (phase 1). Tout ce qui est écrit ici a été relevé dans le code et couvert par `npm test`.

---

## 0. Comment l'utiliser

**Pour toi :** envoie ce fichier à une IA avec ta demande. Modèle de message :

```
Voici le guide de création d'éléments de MotionIA (ADD_ELEMENTS.md).
Crée-moi : <décris l'effet voulu : ce qu'on voit, quand on l'utilise, les réglages souhaités>.
Règles : respecte strictement le guide, n'invente aucun champ, uniform ou import qui n'y figure pas.
Réponds avec : (1) le fichier complet src/effects/<id>.ts, (2) les 2 lignes à ajouter dans src/effects/index.ts,
(3) un exemple JSON pour l'utiliser dans un projet, (4) si ma demande dépasse le périmètre du §8,
dis-le clairement et décris la modification du cœur nécessaire, séparément.
```

**Pour l'IA :** livre toujours 1) le fichier complet, 2) les deux lignes d'enregistrement, 3) un exemple JSON d'utilisation, 4) les réglages par défaut justifiés. Ne modifie jamais un autre fichier que ceux cités ici.

**Ce que « un élément » veut dire.** Tout ce qui s'ajoute **sans toucher au moteur** est un *effet* (un fichier dans `src/effects/` + une ligne dans `src/effects/index.ts`). Il en existe 11 types (`kind`), listés au §3. Le reste (nouveaux champs de clip, nouveaux types de piste, nouvelles capacités de rendu) demande de modifier le cœur : voir §8.

---

## 1. Principe : 1 fichier + 1 ligne

```
src/effects/mon_effet_v1.ts     ← le fichier (export default defineEffect({...}))
src/effects/index.ts            ← +1 import, +1 entrée dans EFFECTS
```

À partir de là, **automatiquement** et sans autre modification :
- l'effet apparaît dans l'éditeur : onglet **Effets** (groupé par type, bouton « Appliquer » qui agit sur la sélection : clip, projet entier, transition entre deux clips, nouvelle couche…), menus « remplacer » de l'Inspector, curseurs bornés générés depuis ses paramètres ;
- il est envoyé à l'IA de montage (catalogue généré depuis le registre) et son identifiant est ajouté à l'enum de sa réponse ;
- il apparaît dans l'admin (interrupteur on/off) ;
- le rendu (aperçu et export MP4) l'exécute.

Le catalogue, l'enum et les formulaires sont **générés**, jamais écrits à la main.

---

## 2. Le contrat `defineEffect`

```ts
import { z } from "zod";
import { defineEffect } from "@/lib/schema";

export default defineEffect({
  id: "mon_effet_v1",              // OBLIGATOIRE. snake_case, ^[a-z][a-z0-9_]{1,40}$, unique, = nom du fichier
  kind: "fx",                      // OBLIGATOIRE. fx|mesh|overlay|transition|caption_style|text_style|motion_preset|lut|sfx|audio_fx
                                   //   (réservés, non rendus en phase 1 : shape_preset)
  status: "active",                // OBLIGATOIRE. "active" | "deprecated" (voir §9)
  cost: "light",                   // OBLIGATOIRE. "light" | "heavy" (indicatif, affiché dans l'admin)
  describe: "…",                   // OBLIGATOIRE. 20–240 caractères, en français : ce qu'on voit + QUAND l'utiliser (§10)

  params: z.object({ … }),         // optionnel. Paramètres réglables (règles au §4). Défaut : aucun paramètre.

  // Selon le kind (un seul de ces blocs est utile) :
  shader: `…GLSL…`,               // fx, lut, overlay, transition  → définit  vec4 fx(vec2 uv)
  mesh: { segments: [48, 48], vertex: `…GLSL…` },  // mesh → définit  vec3 deform(vec3 p, vec2 uv)
  engine: "canvas",                // caption_style, text_style → toujours "canvas" en phase 1
  draw: ({ g, w, h, t, dur, text, words, emphasis, params, reveal }) => { … },  // caption_style, text_style
  motion: ({ t, dur, params }) => ({ scale, opacity, dx, dy, rot }),             // motion_preset
  url: "/sfx/mon_son_v1.mp3", duration: 650,                                      // sfx
  audio: { setup?, build: ({ ctx, params, dur }) => ({ input, output }) },        // audio_fx (graphe Web Audio, voir §5.9)
  fonts: ['800 60px "Instrument Sans"'],  // optionnel : polices à charger avant le rendu (styles de texte)
});
```

Types exacts (extrait de `src/lib/schema.ts`) :

```ts
type Ms = number; // millisecondes entières
type EffectKind = "fx"|"mesh"|"overlay"|"transition"|"caption_style"|"text_style"|"shape_preset"|"motion_preset"|"lut"|"sfx"|"audio_fx";
interface DrawArgs {
  g: CanvasRenderingContext2D;  // contexte 2D déjà EFFACÉ, taille w×h
  w: number; h: number;         // taille du canvas de rendu en pixels (540 de large en aperçu, pleine taille à l'export)
  t: Ms; dur: Ms;               // temps LOCAL au clip (0 = début du clip) et durée du clip
  text: string;                 // texte à dessiner (texte du clip, compteur, ou mots de la caption joints par des espaces)
  words?: { t: string; s: Ms; e: Ms }[];  // caption seulement : mots, temps RELATIFS au début du clip
  emphasis?: [number, number];  // caption : indices (dans `words`) des mots à mettre en valeur
  params: Record<string, any>;  // paramètres résolus, bornés, complétés des défauts
  reveal?: { by: "letters"|"words"|"lines"; stagger: Ms };  // texte seulement : révélation demandée
}
interface AudioFxDef {
  setup?: (ctx: BaseAudioContext) => Promise<void>;     // optionnel : charger un AudioWorklet (voir ensureWorklet dans lib/dsp.ts)
  build: (a: { ctx: BaseAudioContext; params: Record<string, any>; dur: number }) => { input: AudioNode; output: AudioNode };  // dur en SECONDES
}
interface MotionOut { scale?: number; opacity?: number; dx?: number; dy?: number; rot?: number }
```

---

## 3. Les 11 types et où ils se branchent

| `kind` | S'utilise dans le JSON via | Reçoit | Produit | Rendu en phase 1 |
|---|---|---|---|---|
| `fx` | `clip.fx: [{id, params}]` sur un clip vidéo/texte/sous-titre, ou sur un **calque d'effets** (`adjustment`) | l'image du clip | une image | oui |
| `lut` | `composition.grade: {lut: id, amount}` (look global) | l'image composée des couches vidéo | une image | oui (shader, pas de fichier .cube) |
| `overlay` | clip d'une piste `overlay` : `{effect: id, params, at, dur, blend}` | rien (pas d'image) | une image plein cadre avec alpha | oui |
| `mesh` | `clip.mesh: {id, params}` | la géométrie (plan subdivisé) | des sommets déplacés | oui |
| `transition` | `composition.transitions: [{between:[A,B], effect: id, dur, params}]` | les images des deux clips | une image | oui |
| `caption_style` | clip d'une piste `caption` : `style: id` (+ `params`) | mots chronométrés | un dessin 2D | oui |
| `text_style` | clip d'une piste `text` : `style: id` (+ `params`) | le texte | un dessin 2D | oui |
| `motion_preset` | `clip.motion: {preset: id, params}` | temps local, durée | échelle, opacité, décalage, rotation | oui |
| `sfx` | clip d'une piste `audio` : `asset: "sfx:<id>"` | — | un son | oui |
| `audio_fx` | `clip.afx: [{id, params}]` sur un **clip vidéo avec son** ou un **clip audio** | le son du clip | un son transformé | oui (lecture + export) |
| `shape_preset` | clip d'une piste `shape` | — | — | **non (phase 2)** |

Champs réservés (acceptés par le type mais **ignorés** au rendu) : `Component` (overlay React/R3F), `engine: "sdf" | "extrude"`.

---

### Quel effet sur quel média ?

| Effet | Vidéo | **Image / photo** | Texte, sous-titres | Son (clip audio) |
|---|---|---|---|---|
| `fx` (image) | oui | **oui** | oui | — |
| `mesh` (déformation) | oui | **oui** | oui | — |
| `motion_preset` (animation) | oui | **oui** (ex. `ken_burns_v1`) | oui | — |
| transformation, blend, `transition`, `lut` | oui | **oui** | oui (sauf `lut`) | — |
| `audio_fx` (son) | oui, **si le rush a du son** | non (pas de son) | — | oui |
| `overlay` | piste dédiée | piste dédiée | — | — |

Une image est un clip de piste vidéo : tout ce qui s'applique à une vidéo s'applique à une photo, **sans effet spécifique à écrire**. Seuls les effets audio ne la concernent pas.

## 4. Les paramètres (`params: z.object({...})`)

Les paramètres génèrent **trois choses** : les curseurs de l'Inspector, la ligne du catalogue IA, et les `uniform` GLSL.

### 4.1 Types autorisés (et seulement ceux-là)

```ts
z.number().min(0).max(1).default(0.5)        // curseur borné            → uniform float
z.boolean().default(true)                    // case à cocher            → uniform float (0.0 / 1.0)
z.string().default("#00F0FF")                // couleur SI le défaut est "#RRGGBB" → sélecteur → uniform vec3 (0..1)
z.enum(["a", "b"]).default("a")              // liste                    → AUCUN uniform (inutilisable en shader)
z.string().default("")                       // texte libre              → AUCUN uniform
```

### 4.2 Règles strictes
1. **Tout nombre a `.min()`, `.max()` ET `.default()`.** Sans bornes, le curseur devient inutilisable (±1 000 000) ; le test de conformité refuse bornes absentes et défaut hors bornes.
2. **Une couleur est un `z.string().default("#RRGGBB")`** (6 chiffres hexa). Sans ce défaut, ce n'est pas reconnu comme couleur.
3. Pas d'objets imbriqués, tableaux, unions, `.transform()`, `.refine()`, `.optional()` sans défaut : ils sont ignorés ou cassent le formulaire.
4. **Noms de paramètres** (pour `fx`, `lut`, `overlay`, `transition`, `mesh`, qui deviennent des `uniform`) : lettres/chiffres uniquement (`^[a-zA-Z][a-zA-Z0-9]*$`), jamais un mot réservé GLSL ni un nom déjà pris. **Interdits :** `tMap tFrom tTo uTime uRes uSeed uAmount uProgress uSize uC uCorners uOpacity uPremult vUv position uv hash fx deform main input output sample filter half fixed common active partition class union enum default switch case do for while if else return discard break continue float int bool vec2 vec3 vec4 mat2 mat3 mat4 uniform varying attribute const in out inout void true false struct precision layout flat smooth texture` (liste complète dans `src/effects/registry.test.ts`).
5. Les noms de paramètres des styles de texte (`draw`) n'ont pas ces contraintes (pas d'uniform).

### 4.3 Comment les valeurs arrivent à l'effet
Dans le document, chaque paramètre est une **constante** ou une **animation** :
```json
{ "intensity": 0.4 }
{ "intensity": { "kf": [[0, 0], [500, 1, "outCubic"], [2000, 0.2]] } }       // nombre animé : [tempsMs, valeur, easing?]
{ "color": { "kf": [[0, "#FF0000"], [1000, "#0000FF"]] } }                    // couleur animée
```
À chaque image : animation évaluée → valeur **bornée** dans [min, max] (jamais rejetée) → clés inconnues supprimées → paramètres manquants remplacés par leur défaut → envoyée à l'effet. L'effet reçoit donc **toujours** des valeurs valides et complètes.
Le temps des keyframes est **relatif au début du clip** (pour `grade`, c'est le temps de la timeline ; pour une transition, le début du 2ᵉ clip).
Easings : `linear inQuad outQuad inOutQuad inCubic outCubic inOutCubic outBack outExpo hold`.

---

## 5. Les types, un par un

### 5.0 Conventions GLSL communes (fx, lut, overlay, transition, mesh)
- **GLSL ES 1.00 style**, compilé par three.js (`ShaderMaterial`) : `texture2D(...)`, `gl_FragColor`. **Pas** de `#version`, **pas** de `void main()`, **pas** de `in/out`. Le système ajoute un `main()` qui appelle ton code.
- **Les littéraux flottants s'écrivent avec un point** : `1.0`, jamais `1` (erreur de compilation sinon, dans les opérations avec des float). Boucles : bornes constantes.
- Ne **redéclare jamais** un uniform fourni (liste ci-dessous) ; tes paramètres sont déclarés automatiquement (`uniform float amp;`, `uniform vec3 color;`…).
- Repère UV : `(0,0)` en bas à gauche, `(1,1)` en haut à droite ; `uv.y = 1` est le **haut** de l'image.
- **Couleurs :** valeurs sRGB brutes 0–1, aucune conversion gamma à faire ni à éviter : tout est traité tel quel de bout en bout. L'alpha n'est **pas** prémultiplié dans les textures d'entrée.
- **`uTime` = temps GLOBAL de la timeline en secondes** (pas le temps du clip). Pour une animation propre à un clip, expose un paramètre et fais-le animer par keyframes (`{"kf":[[0,0],[1000,1]]}`), plutôt que de dépendre de `uTime`.
- **Indépendance de résolution — règle essentielle** : l'aperçu rend en 540 px de large, l'export en 1080 px ou plus. N'écris jamais de tailles en pixels absolus ; exprime-les en fractions de `uRes.x`/`uRes.y`/`min(uRes.x,uRes.y)`.
- Déterminisme : pas d'aléa non seedé. Utilise `hash(vec2)` (fourni).
- Budget : un effet `light` = au plus ~16 lectures de texture par pixel. Plus → marque-le `cost: "heavy"`.

### 5.1 `fx` — transformer l'image d'un clip
Fichier généré autour de ton code (c'est exactement ce qui est compilé) :
```glsl
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;   // l'image du clip, déjà cadrée à la taille du canvas
uniform float uTime;      // secondes, temps global
uniform vec2  uRes;       // taille du canvas de rendu en pixels
uniform float uSeed;      // graine qui change à chaque image (stable pour un clip donné)
uniform float uAmount;    // = 1.0 pour un fx
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
/* uniforms de tes paramètres */
vec4 fx(vec2 uv);
/* TON CODE : doit définir  vec4 fx(vec2 uv) { ... }  */
void main(){ gl_FragColor = fx(vUv); }
```
Ce que tu peux faire : lire `tMap` à n'importe quelle coordonnée (flou, décalage, séparation RGB, distorsion, pixelisation, grain, vignette, couleur…), écrire une couleur + alpha.
Ce que tu ne peux pas : lire d'autres clips, l'image précédente, le temps du clip, les mots, l'audio.
Un `fx` s'applique **après** le cadrage de la vidéo (cover/contain), donc sur l'image du cadre, pas sur la source brute.

```ts
//src/effects/vignette.ts
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
export default defineEffect({
  id: "vignette", kind: "fx", status: "active", cost: "light",
  describe: "Assombrit les bords pour concentrer le regard ; à utiliser sur un plan serré ou une phrase importante.",
  params: z.object({
    intensity: z.number().min(0).max(1).default(0.55),
    softness: z.number().min(0.1).max(1).default(0.6),
  }),
  shader: /* glsl */ `
    vec4 fx(vec2 uv) {
      vec4 c = texture2D(tMap, uv);
      float d = distance(uv, vec2(0.5));
      float v = 1.0 - intensity * smoothstep(0.25, 0.25 + softness, d);
      return vec4(c.rgb * v, c.a);
    }`,
});
```
Un `fx` placé sur un clip `adjustment` (calque d'effets) s'applique à **tout ce qui est composé en dessous**, pendant la durée du calque.

### 5.2 `lut` — le look global
Même convention que `fx` (mêmes uniforms), avec deux différences : `uAmount` vaut l'intensité `grade.amount` (0–1) choisie par l'utilisateur — **utilise-le pour mélanger** avec l'original (`mix(original, gradé, uAmount)`) ; et les `params` d'une `lut` ne sont pas réglables (valeurs par défaut seulement). Pas de fichier `.cube` en phase 1.
Il s'applique après toutes les couches vidéo et calques d'effets, **avant** textes, sous-titres et overlays.
```ts
shader: /* glsl */ `
  vec4 fx(vec2 uv) {
    vec4 c = texture2D(tMap, uv);
    float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    vec3 o = mix(c.rgb * vec3(0.82, 1.0, 1.12), c.rgb * vec3(1.16, 1.0, 0.84), smoothstep(0.2, 0.75, l));
    return vec4(mix(c.rgb, o, uAmount), c.a);
  }`,
```

### 5.3 `overlay` — une couche plein cadre générée
Mêmes uniforms que `fx`, **sans image** : `tMap` n'a pas de contenu (n'y lis rien). Tu génères la couleur et l'alpha de chaque pixel. L'overlay est dessiné **plein cadre au-dessus** de ce qui est en dessous, selon le `blend` du clip.
**Limites :** pour un overlay, `transform` (position, échelle, rotation, opacité), `motion`, `fx` et `mesh` du clip sont **ignorés**. L'opacité et la position se gèrent donc **dans tes paramètres** (ajoute `opacity`, `x`, `y`…). Privilégie les blends `normal` et `add` ; `screen`/`multiply` ne sont pas prémultipliés correctement pour les overlays.
Sortie : `vec4(couleur, alpha)` — couleur non prémultipliée.
```ts
//src/effects/frame_neon_v1.ts
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
export default defineEffect({
  id: "frame_neon_v1", kind: "overlay", status: "active", cost: "light",
  describe: "Cadre néon lumineux autour de l'image ; pour un passage punchy, une intro ou un mot choc (utiliser avec blend add).",
  params: z.object({
    color: z.string().default("#00F0FF"),
    thickness: z.number().min(0.002).max(0.03).default(0.008),
    glow: z.number().min(0).max(1).default(0.6),
    pulse: z.number().min(0).max(1).default(0.3),
    inset: z.number().min(0).max(0.15).default(0.035),
  }),
  shader: /* glsl */ `
    vec4 fx(vec2 uv) {
      vec2 p = min(uv, 1.0 - uv) * uRes;
      float d = min(p.x, p.y);
      float m = min(uRes.x, uRes.y);
      float th = thickness * m;
      float e = abs(d - inset * m);
      float core = 1.0 - smoothstep(th * 0.5, th, e);
      float halo = exp(-e / (th * 6.0)) * glow;
      float pul = 1.0 + pulse * 0.5 * sin(uTime * 9.42);
      float a = clamp(core + halo * 0.5, 0.0, 1.0);
      return vec4(color * (core + halo * 0.6) * pul, a);
    }`,
});
```

### 5.4 `mesh` — déformer la géométrie
Le clip est dessiné sur un plan subdivisé `segments[0] × segments[1]` (entiers de 1 à 128). Tu fournis `vec3 deform(vec3 p, vec2 uv)` : tu reçois la position d'un sommet et retournes sa nouvelle position.
```glsl
varying vec2 vUv;
uniform float uTime;   // secondes, temps global
uniform vec2  uSize;   // taille de l'élément en pixels (après échelle)
uniform vec2  uRes;    // taille du canvas de rendu en pixels
/* uniforms de tes paramètres (déclarés automatiquement) */
/* TON CODE : vec3 deform(vec3 p, vec2 uv) { ...; return p; } */
```
- `p.xy` est en **pixels**, centré : de `-uSize/2` à `+uSize/2`. `p.z` démarre à 0. `uv` va de (0,0) à (1,1), `uv.y = 1` en haut.
- **Exprime les déplacements relativement à `uRes.y`** (ex. `amp * uRes.y * 0.36`), jamais en pixels fixes (aperçu et export n'ont pas la même résolution).
- **`p.z` n'est visible que si le clip a de la perspective** (`transform.rot3d` ou `transform.persp`). Sinon la caméra est orthographique et seuls les décalages en `x` et `y` se voient : déforme `x`/`y` pour un effet toujours visible.
- Un mesh ne change **pas** la couleur (le fragment est fixé : texture × opacité). Pour de la couleur, ajoute un `fx`.
- Si le clip utilise `transform.corners` (corner pin), la déformation mesh est ignorée.
```ts
//src/effects/cloth_wave_v1.ts  (corps)
mesh: {
  segments: [48, 48],
  vertex: /* glsl */ `
    vec3 deform(vec3 p, vec2 uv) {
      float k = amp * uRes.y * 0.36;
      float ph = uv.x * freq * 6.2831 + uTime * speed * 6.2831;
      p.z += sin(ph) * k * (0.3 + uv.y);
      p.y += cos(ph) * k * 0.2;
      p.x += sin(uv.y * freq * 6.2831 + uTime * speed * 6.2831) * k * 0.15;
      return p;
    }`,
},
```

### 5.5 `transition` — passer d'un clip au suivant
S'applique **uniquement entre deux clips consécutifs d'une piste vidéo magnétique** : le 2ᵉ clip est avancé de `dur` ms, ce qui crée un chevauchement ; pendant ce chevauchement l'effet est évalué. Si l'effet est introuvable/désactivé, un fondu enchaîné simple est utilisé.
```glsl
precision highp float;
varying vec2 vUv;
uniform sampler2D tFrom;   // image du clip qui sort
uniform sampler2D tTo;     // image du clip qui entre
uniform float uProgress;   // 0.0 → 1.0 sur la durée de la transition
uniform float uTime; uniform vec2 uRes; uniform float uSeed;
float hash(vec2 p){ … }
/* uniforms de tes paramètres */
vec4 fx(vec2 uv);
/* TON CODE : vec4 fx(vec2 uv) — retourne la couleur finale (mélange de tFrom et tTo) */
```
`tMap` n'existe pas ici. Les paramètres viennent de `transitions[i].params`. Transitions fournies : `crossfade_v1` (fondu), `slide_v1` (glissement, paramètre `dir`), `glitch_cut` (glitch). Dans l'éditeur, une transition se choisit dans l'Inspector d'un clip de la piste principale (« Transition vers le clip suivant ») ou depuis l'onglet Effets.
```ts
//src/effects/glitch_cut.ts  (corps)
params: z.object({ intensity: z.number().min(0).max(2).default(1) }),
shader: /* glsl */ `
  vec4 fx(vec2 uv) {
    float p = uProgress;
    float k = sin(p * 3.14159) * intensity;
    float row = floor(uv.y * 24.0);
    float j = (hash(vec2(row, floor(uTime * 30.0))) - 0.5) * k * 0.2;
    vec2 u = vec2(uv.x + j, uv.y);
    float s = k * 0.02;
    vec4 a = vec4(texture2D(tFrom, u + vec2(s, 0.0)).r, texture2D(tFrom, u).g, texture2D(tFrom, u - vec2(s, 0.0)).b, texture2D(tFrom, u).a);
    vec4 b = vec4(texture2D(tTo, u + vec2(s, 0.0)).r, texture2D(tTo, u).g, texture2D(tTo, u - vec2(s, 0.0)).b, texture2D(tTo, u).a);
    float cut = step(0.5, p + (hash(vec2(row, 7.0)) - 0.5) * 0.3 * k);
    return mix(a, b, cut);
  }`,
```

### 5.6 `caption_style` et `text_style` — dessiner du texte (moteur canvas)
Tu écris une fonction `draw` qui dessine avec l'API Canvas 2D standard sur `g`. Elle est appelée **à chaque image**, `g` est déjà effacé. Le résultat devient une texture plein cadre (taille `w × h`), puis passe par les `fx`, la transformation, le blend et le mesh du clip comme n'importe quelle image.
- **Tout en fractions de `w` et `h`** (taille de police : `w * 0.075`, position : `h * params.y`), jamais en pixels fixes.
- `t` = temps local au clip en ms ; `words[i].s/e` = temps des mots **relatifs au début du clip** (caption). Pour savoir quel mot est prononcé : `words.findIndex(x => t >= x.s && t < x.e)`.
- `caption_style` : tu reçois `words` (le mot actif se calcule avec `t`) et `emphasis`. `text_style` : tu reçois `text` et éventuellement `reveal` (`by` + `stagger` en ms entre unités).
- **Pur et déterministe :** aucun `Math.random()` ni `Date.now()` (le test les interdit). Pour de l'aléa : `import { seeded } from "@/lib/engine"` → `seeded(cléTexte, numéroImage)` (0–1). Autres helpers autorisés : `ease(nom, x01)`, `evalNum`.
- Polices : déclare-les dans `fonts` (chaînes de forme CSS `'800 60px "Nom"'`) pour qu'elles soient chargées avant le rendu. Pour une nouvelle police : ajoute-la à l'URL Google Fonts en tête de `src/app/globals.css` (ex. `&family=Bebas+Neue`), puis utilise son nom dans `g.font`. Auto-hébergée : fichier dans `public/fonts/` + `@font-face` dans `globals.css`.
- La transformation du clip (position, échelle, rotation) s'applique à **toute la couche**, pivot au centre du canvas : pour déplacer le texte, joue plutôt sur un paramètre `y`.
- Les champs `fill`, `stroke`, `glow` d'un clip texte existent dans le schéma mais ne sont **pas** transmis à `draw` en phase 1 : mets ces réglages dans tes `params`.
```ts
//src/effects/minimal_clean.ts (corps)
id: "minimal_clean", kind: "caption_style", engine: "canvas", status: "active", cost: "light",
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
  let x = (w - (widths.reduce((a, b) => a + b, 0) + gap * (group.length - 1))) / 2; const y = h * params.y;
  group.forEach((wd, i) => {
    g.lineWidth = size * 0.2; g.strokeStyle = "rgba(0,0,0,0.85)"; g.strokeText(wd.t, x, y);
    g.fillStyle = from + i === idx ? params.highlight : params.color; g.fillText(wd.t, x, y);
    x += widths[i] + gap;
  });
},
```

### 5.7 `motion_preset` — animer l'entrée/sortie d'un élément
Fonction **pure** `motion({ t, dur, params })` → `{ scale?, opacity?, dx?, dy?, rot? }` (champs omis = neutres). Les valeurs sont **combinées** à la transformation du clip : `scale` et `opacity` se **multiplient**, `dx`/`dy` s'**ajoutent** à la position (en fraction du canvas, y vers le bas), `rot` s'ajoute en degrés (sens horaire). `t` est le temps local en ms, `dur` la durée du clip.
**Attention :** ici `params` arrive **tel qu'écrit dans le document, sans bornage ni défauts** : lis-le avec des valeurs de repli (`params.speed ?? 1`). Ne s'applique ni aux overlays, ni aux formes.
```ts
motion: ({ t, dur }) => ({
  scale: 0.55 + 0.45 * ease("outBack", t / 320),                       // import { ease } from "@/lib/engine"
  opacity: Math.min(1, t / 140) * Math.min(1, Math.max(0, (dur - t) / 140)),
}),
```

### 5.8 `sfx` — un effet sonore
1. Dépose le fichier dans `public/sfx/` avec un nom **versionné** (`whoosh_v1.mp3` ; formats `.mp3 .ogg .wav .m4a`). Ce dossier est servi avec un cache à vie : **ne remplace jamais un fichier existant**, crée `_v2`.
2. Déclare l'effet :
```ts
export default defineEffect({
  id: "whoosh_v1", kind: "sfx", status: "active", cost: "light",
  describe: "Souffle rapide pour souligner un changement de plan ou l'apparition d'un titre.",
  url: "/sfx/whoosh_v1.mp3", duration: 650,       // duration en ms, > 0
});
```
3. Utilisation (clip d'une piste `audio`) : `{ "id": "s1", "asset": "sfx:whoosh_v1", "at": 1200, "dur": 650, "gain": 0.8 }`. **`dur` est obligatoire** pour un son (sans `dur`, le clip a une durée nulle et reste muet). Le clip peut aussi s'ancrer à un mot (`anchor`). `fade: [entréeMs, sortieMs]` est supporté.

### 5.9 `audio_fx` — transformer le son d'un clip (vidéo OU audio)
Un effet audio est un **petit graphe Web Audio** : tu crées des nœuds (`ctx.createGain()`, `createDelay()`, `createBiquadFilter()`, `createConvolver()`, `createWaveShaper()`, `new AudioWorkletNode(...)`…), tu les relies, et tu retournes `{ input, output }`. Le système branche le son du clip sur `input` et `output` vers la sortie.
- **Il s'applique à tout clip qui a du son** : clip audio (musique, voix, sfx) **et clip vidéo dont le rush a une piste audio** (c'est la voix de la vidéo). Pour une image ou une vidéo sans son, la section n'apparaît pas dans l'Inspector et `afx` est sans effet.
- **Un seul code, deux contextes** : le même `build` tourne en **lecture** (AudioContext temps réel) et à l'**export** (OfflineAudioContext). N'utilise donc que le `ctx` reçu : jamais `new AudioContext()`, jamais d'horloge, jamais `Math.random()` (utilise un générateur à graine, voir `reverb_room_v1`) — sinon l'aperçu et l'export ne sonneraient pas pareil.
- **Paramètres constants** sur la durée du clip (pas d'images clés pour l'audio) : ce que tu reçois dans `params` est borné et complété, comme pour les autres effets. Mêmes règles de `z.object` (§4) ; les noms ne sont pas des uniforms GLSL, donc aucune restriction de noms.
- `build` est **synchrone**. Si tu as besoin de code asynchrone (charger un worklet), fais-le dans `setup(ctx)`, appelé et attendu avant `build`.
- Volume et fondus du clip sont appliqués **avant** ton effet ; les queues (écho, réverbération) se prolongent après la fin du clip en lecture, mais l'export s'arrête à la fin de la timeline.
- `dur` = durée du clip en **secondes** (utile pour dimensionner un buffer).
- Les effets qui exigent du **calcul sur le signal** (décalage de hauteur, vocodeur…) ne sont pas des nœuds standard : écris le traitement comme un `AudioWorkletProcessor`, fournis son code **sous forme de texte** et charge-le avec `ensureWorklet` (`src/lib/dsp.ts`). Modèle réel : `autotune_v1` + son moteur `PitchCorrector`, testé sur des sinusoïdes (`src/lib/dsp.test.ts`). Le texte du worklet ne doit référencer aucune variable extérieure.

Exemple — écho (retard avec rétroaction filtrée) :
```ts
//src/effects/echo_v1.ts
import { z } from "zod";
import { defineEffect } from "@/lib/schema";
export default defineEffect({
  id: "echo_v1", kind: "audio_fx", status: "active", cost: "light",
  describe: "Écho qui se répète en s'estompant ; pour une voix dans un grand espace ou un mot qui doit résonner.",
  params: z.object({
    time: z.number().min(60).max(1000).default(320),
    feedback: z.number().min(0).max(0.9).default(0.45),
    mix: z.number().min(0).max(1).default(0.4),
    tone: z.number().min(800).max(12000).default(4000),
  }),
  audio: {
    build: ({ ctx, params }) => {
      const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
      const delay = ctx.createDelay(1.5), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
      delay.delayTime.value = params.time / 1000; fb.gain.value = params.feedback; wet.gain.value = params.mix;
      lp.type = "lowpass"; lp.frequency.value = params.tone;
      input.connect(dry); dry.connect(output);
      input.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay);   // boucle de rétroaction
      lp.connect(wet); wet.connect(output);
      return { input, output };
    },
  },
});
```
Effets audio fournis : `echo_v1` (écho), `delay_v1` (une répétition), `reverb_room_v1` (réverbération de pièce), `radio_voice_v1` (voix radio/téléphone), `autotune_v1` (correction de hauteur, voix seule ; latence ≈ 20 ms). Utilisation : `"afx": [{ "id": "echo_v1", "params": { "mix": 0.25 } }]` sur un clip vidéo ou audio ; les effets s'enchaînent dans l'ordre du tableau (8 maximum).

### 5.10 Réservés (non rendus en phase 1)
`shape_preset`, `Component` (overlay en composant R3F), `engine: "sdf" | "extrude"`. Ne les utilise pas : ils ne produisent rien. Voir §8 pour les activer.

---

## 6. Ordre de composition (pour comprendre ce qu'un effet voit)

1. Les **pistes** sont dessinées du bas (index 0) vers le haut. Dans une piste, ordre du tableau puis `z`.
2. Chaque clip visuel : image → (cadrage cover/contain/fill) → pile `fx` (dans l'ordre) → transformation + `motion` + `mesh` (ou `corners`) → blend sur ce qui est déjà composé.
3. Un clip `adjustment` applique ses `fx` à **tout ce qui est déjà composé**, pendant sa durée.
4. Le look global (`grade`) s'applique dès qu'on passe à la première couche qui n'est ni vidéo ni calque d'effets (donc avant textes/overlays).
5. Transitions : pendant le chevauchement de deux clips, les deux sont rendus séparément puis mélangés par la transition.
6. Blends : `normal`, `add`, `screen`, `multiply` ; `overlay` est rendu comme `normal`.
7. Limites du document : 24 pistes, 400 clips par piste, 12 `fx` par clip, 1 Mo de JSON, texte ≤ 500 caractères.

---

## 7. Le document JSON (pour utiliser et tester ton effet)

Objets **stricts** : toute clé inconnue est rejetée. Temps en **millisecondes entières**. Identifiants de 1 à 48 caractères.

```
Composition { v: 2, canvas:{w,h,fps}, assets:{ [id]: Asset }, grade?:{lut:id, amount:Num}, tracks:Track[], transitions:Transition[] }
Num = number | { kf: [[tMs, valeur, easing?], …] }       Col = "#RRGGBB" | { kf: [[tMs, "#RRGGBB"], …] }

Asset (vidéo) { type:"video", name?, desc?, w,h, dur, fps, rot?, hasAudio, bytes, fp, remote?, proxy?, words?: Word[] }
Asset (image) { type:"image", name?, desc?, w, h, fp?, remote?, proxy?, bytes? }          // se place dans un VideoClip : src:[0, duréeMs] = image fixe (fit "contain" par défaut)
Asset (audio) { type:"audio", name?, desc?, dur, fp?, remote?, proxy?, bytes?, words? }   // se place dans un AudioClip
Word { t:"mot", s:ms, e:ms }                               // temps de la SOURCE, jamais de la timeline

Track { id, kind, locked?, muted?, clips[] }               // kind: video | adjustment | overlay | text | caption | shape | audio
                                                           // piste video : magnetic?: true → clips enchaînés sans « at », ripple automatique

Champs visuels communs { at?, dur?, anchor?, transform?, motion?, blend?, fx?[], mesh?, z?, (matte?, behind? : ignorés) }
Anchor { clip: idDuClipVidéo, words:[i,j], offset?, dur? } // ancre un élément sur les INDEX de mots i..j (jamais en ms)
Transform { pos?:{x,y,z?}, scale?: Num | {x:Num,y:Num}, rot?: Num (°, horaire), rot3d?:{x,y,z}, persp?: 0..4000,
            corners?: [[x,y]×4] (corner pin, ordre HG,HD,BD,BG, 0..1), opacity?: Num }
            // pos : fraction du canvas, (0.5,0.5) = centre, y vers le bas. pivot : ignoré.

VideoClip      { id, asset, src:[ms,ms], speed?:Num, fit?:"cover"|"contain"|"fill", volume?:Num, afx?:[{id,params}] (effets audio), …communs }
               // « asset » peut être une vidéo OU une image : les fx, mesh, motion, transform et blend s'appliquent de la même façon aux images.
AdjustmentClip { id, at?, dur?, span?:[idClipA,idClipB], fx:[…] }       // span : suit automatiquement ces clips
OverlayClip    { id, effect, params?, at?, dur?, blend? }                // (transform/motion/fx/mesh ignorés)
TextClip       { id, text?, counter?:{from,to,suffix?,dur}, style, params?, reveal?:{by,effect,stagger?}, …communs }
CaptionClip    { id, from: idDuClipVidéo, style, params?, emphasis?:[i,j], …communs }   // durée = celle du clip source
AudioClip      { id, asset: idAsset | "sfx:idEffet", src?, at?, anchor?, gain?:Num, fade?:[in,out], dur?, afx?:[{id,params}] }
Transition     { between:[idA,idB], effect, dur, params? }               // uniquement entre deux clips d'une piste video magnétique
```

Exemple complet qui valide (utilise `vignette`, `bw`, `frame_neon_v1`, `cloth_wave_v1`, `teal_orange`, `pop_in`, `clean_title`, `minimal_clean`, `glitch_cut`) :
```json
{
  "v": 2, "canvas": { "w": 1080, "h": 1920, "fps": 30 },
  "assets": {
    "r1": { "type": "video", "w": 1920, "h": 1080, "dur": 42500, "fps": 30, "hasAudio": true, "bytes": 85000000, "fp": "x1",
            "words": [{ "t": "Voici", "s": 0, "e": 320 }, { "t": "pourquoi", "s": 340, "e": 700 }] },
    "r2": { "type": "video", "w": 1080, "h": 1920, "dur": 18000, "fps": 30, "hasAudio": true, "bytes": 42000000, "fp": "x2" }
  },
  "grade": { "lut": "teal_orange", "amount": 0.7 },
  "tracks": [
    { "id": "v1", "kind": "video", "magnetic": true, "clips": [
      { "id": "c1", "asset": "r1", "src": [0, 3200], "speed": 1, "afx": [{ "id": "echo_v1", "params": { "mix": 0.25 } }],
        "transform": { "scale": { "kf": [[0, 1], [3200, 1.15, "outCubic"]] } },
        "mesh": { "id": "cloth_wave_v1", "params": { "amp": 0.05 } },
        "fx": [{ "id": "vignette", "params": { "intensity": 0.6 } }] },
      { "id": "c2", "asset": "r2", "src": [5000, 9000] } ] },
    { "id": "adj1", "kind": "adjustment", "clips": [{ "id": "a1", "span": ["c1", "c2"], "fx": [{ "id": "bw", "params": { "amount": 0.0 } }] }] },
    { "id": "txt", "kind": "text", "clips": [
      { "id": "t1", "anchor": { "clip": "c1", "words": [1, 1] }, "text": "Pourquoi", "style": "clean_title",
        "params": { "color": "#FFD84D" }, "reveal": { "by": "letters", "effect": "rise", "stagger": 40 }, "motion": { "preset": "pop_in" } }] },
    { "id": "cap", "kind": "caption", "clips": [{ "id": "k1", "from": "c1", "style": "minimal_clean", "params": { "highlight": "#FF4F7B" } }] },
    { "id": "ov", "kind": "overlay", "clips": [{ "id": "o1", "effect": "frame_neon_v1", "params": { "color": "#00F0FF" }, "at": 0, "dur": 3200, "blend": "add" }] }
  ],
  "transitions": [{ "between": ["c1", "c2"], "effect": "glitch_cut", "dur": 200, "params": { "intensity": 1 } }]
}
```

---

## 8. Périmètre : ce qu'un effet peut faire — et ce qui demande de modifier le cœur

**Un effet peut :** lire l'image du clip (fx), générer une image (overlay), déformer la géométrie (mesh), mélanger deux clips (transition), dessiner du texte animé (styles), animer position/échelle/opacité/rotation (motion), jouer un son (sfx), colorer l'ensemble (lut) ; recevoir des paramètres bornés, animables par keyframes ; être activé/désactivé sans redéploiement.

**Un effet ne peut pas** (limites volontaires) : lire un autre clip, la frame précédente, l'audio, la transcription (hors styles de texte), le document ; appeler le réseau ; modifier le document ; charger un fichier image/texture.

**Ce qui demande de toucher au cœur** (à demander séparément, jamais dans un fichier d'effet) :

| Besoin | Où modifier |
|---|---|
| Temps local du clip dans les shaders (`uLocal`) | `src/lib/render.tsx` : ajouter l'uniform dans `runFx`/`drawLayer` |
| Textures supplémentaires (bruit, image, .cube) | `render.tsx` + champ d'assets d'effet dans `schema.ts` |
| Effets temporels (traînées, feedback) | `render.tsx` : render target persistante entre images |
| Animer les réglages d'un effet audio dans le temps | `render.tsx` : automation d'`AudioParam` dans `routeAudio` et `mixAudio` |
| Nouveau champ sur un clip | `schema.ts` (objet strict) + `Inspector.tsx` + `responseSchema` dans `gemini.ts` |
| Nouveau type de piste | union `TrackS` dans `schema.ts` + `engine.ts` (layout) + `render.tsx` + `Timeline.tsx` |
| `shape`, `matte`, `behind`, `Component` R3F, `sdf`, `extrude`, `pivot`, particules, modèles 3D | `render.tsx` (phase 2) |
| `fill`/`stroke`/`glow` des textes transmis à `draw` | `render.tsx` (`textTexture`) |

---

## 9. Enregistrement, nommage, versions

```ts
// src/effects/index.ts
import monEffet from "./mon_effet_v1";                       // 1) l'import
export const EFFECTS: EffectDef[] = [
  vignette, bw, /* … */ monEffet,                            // 2) l'entrée
];
```
- **Nom = `id` = nom de fichier**, en `snake_case`, avec suffixe de version (`_v1`) pour tout effet susceptible d'évoluer.
- **Ne change jamais l'apparence d'un effet existant** : des projets l'utilisent. Crée `mon_effet_v2.ts`, puis passe l'ancien en `status: "deprecated"` : il **reste rendu** dans les projets existants, mais disparaît du catalogue IA et des menus.
- L'admin peut désactiver un effet à chaud : il est retiré du prompt IA et du rendu (les projets l'ignorent avec un avertissement visible).
- Un `id` en double est refusé par le test de conformité.

---

## 10. Écrire un bon `describe` (le catalogue lu par l'IA de montage)

Chaque effet devient une ligne du prompt, que l'IA lit pour choisir :
`- frame_neon_v1 [overlay] : <describe> {color:color="#00F0FF", thickness:num[0.002..0.03]=0.008, …}`
- **Une phrase, en français : ce qu'on voit + quand l'utiliser.** Ex. « Fait onduler l'image comme un drap dans le vent ; pour une transition poétique ou un moment onirique. »
- Pas de jargon technique, pas d'implémentation. 20 à 240 caractères.
- Les bornes et défauts des paramètres sont ajoutés automatiquement : ne les répète pas.
- Chaque caractère coûte des tokens à chaque analyse : sois dense. L'admin affiche la taille du catalogue.

---

## 11. Vérifier son travail

```bash
npm run typecheck      # le fichier compile
npm test               # test de conformité du registre : id, describe, bornes, noms d'uniforms, signature shader, pureté de draw/motion, build() des effets audio sur un contexte factice
npm run dev            # puis essayer visuellement
```
Le test de conformité (`src/effects/registry.test.ts`) **échoue** si : id invalide/en double, `describe` hors 20–240 caractères, nombre sans bornes ou défaut hors bornes, nom de paramètre réservé, shader sans `vec4 fx(vec2 uv)` ou avec `main`/`#version`/redéclaration d'un uniform fourni, mesh sans `vec3 deform(vec3 p, vec2 uv)`, style de texte utilisant `Math.random`/`Date.now`, motion non pure, sfx sans URL `/sfx/…` ou sans durée.
Il **ne vérifie pas** la compilation GLSL ni le rendu : test visuel obligatoire.

Test visuel : `npm run dev` → Tableau de bord → « Essayer avec un exemple » → sélectionner un clip → l'effet est dans les menus de l'Inspector (par type). Un overlay s'ajoute via l'onglet **JSON** (ajouter un clip `{ "id": "o2", "effect": "mon_effet_v1", "at": 0, "dur": 3000 }` dans une piste `overlay`). **Console du navigateur :** une erreur `THREE.WebGLProgram: Shader Error` signifie que ton GLSL ne compile pas (l'application ne plante pas, l'effet ne s'affiche simplement pas). Vérifie l'aperçu **et** un export (résolutions différentes).

---

## 12. Pièges fréquents (checklist finale)

- [ ] `1` au lieu de `1.0` dans le GLSL.
- [ ] Tailles/distances en pixels absolus au lieu de fractions de `uRes` / `w` / `h`.
- [ ] `uTime` utilisé comme temps du clip (c'est le temps global ; passe par un paramètre animé).
- [ ] Nombre sans `.min().max().default()` ; couleur sans défaut `"#RRGGBB"`.
- [ ] Nom de paramètre réservé (`input`, `filter`, `sample`, `texture`, `default`…) ou déjà un uniform fourni.
- [ ] Paramètre `enum`/`string` utilisé dans un shader (n'existe pas côté GPU).
- [ ] Overlay qui compte sur `transform`/`opacity`/`motion`/`fx` du clip (ignorés : mets-les en paramètres).
- [ ] Mesh qui déforme seulement `p.z` (invisible sans perspective) ; mesh qui veut changer la couleur.
- [ ] `main()`, `#version`, `in/out`, redéclaration d'un uniform, `texture()` au lieu de `texture2D()`.
- [ ] `Math.random()` / `Date.now()` dans `draw` ou `motion`.
- [ ] `motion` qui suppose des `params` complets (ils ne sont ni bornés ni complétés).
- [ ] Son sans `dur` sur son clip audio ; fichier `public/sfx` remplacé au lieu d'être versionné.
- [ ] Effet existant modifié au lieu de créer `_v2`.
- [ ] Effet audio : `new AudioContext()`, `Math.random()` ou horloge dans `build` (aperçu ≠ export) ; réglages supposés animables (ils sont constants).
- [ ] Effet audio qui suppose du **stéréo** ou une **durée** : le son peut être mono, et seules les queues de l'effet dépassent le clip.
- [ ] Texte d'un worklet qui référence une variable extérieure (le minifieur la renomme : le worklet casse en production).
- [ ] Oubli de la ligne dans `src/effects/index.ts` (import **et** entrée du tableau).
