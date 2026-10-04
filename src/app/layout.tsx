// src/app/layout.tsx
/** layout.tsx — coquille HTML commune. */

import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = "https://klinmotionai.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),

  title: {
    default: "Klin Motion Ai — Montage vidéo par IA & effets 3D",
    template: "%s | Klin Motion Ai",
  },

  description:
    "Klin Motion Ai comprend vos vidéos, organise vos rushs et crée des montages avec l’IA, des effets 3D avancés, des sous-titres cinétiques et des animations dignes d’After Effects.",

  applicationName: "Klin Motion Ai",

  keywords: [
    "montage vidéo IA",
    "éditeur vidéo IA",
    "intelligence artificielle vidéo",
    "montage vidéo automatique",
    "effets 3D",
    "motion design",
    "sous-titres cinétiques",
    "AI video editor",
    "AI video editing",
    "Klin Motion Ai",
  ],

  authors: [{ name: "Klin Motion Ai" }],
  creator: "Klin Motion Ai",
  publisher: "Klin Motion Ai",

  alternates: {
    canonical: "/",
  },

  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-video-preview": -1,
      "max-snippet": -1,
    },
  },

  verification: {
    google: "dKt8mHbbvvZzsXGkW9k8pZALuGId_GhmM_obYLt6WM8",
  },

  openGraph: {
    type: "website",
    locale: "fr_FR",
    url: siteUrl,
    siteName: "Klin Motion Ai",

    title: "Des rushs → une vidéo professionnelle pour vos plateformes",

    description:
      "Klin Motion Ai comprend vos rushs, sélectionne les meilleurs moments et crée un montage pensé pour vos réseaux sociaux, avec effets 3D, sous-titres et animations avancées.",

    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Klin Motion Ai — Des rushs à une vidéo professionnelle",
      },
    ],
  },

  twitter: {
    card: "summary_large_image",
    title: "Klin Motion Ai — Montage vidéo par IA & effets 3D",
    description:
      "L’IA comprend votre vidéo. Klin Motion Ai la monte, l’anime et vous permet de la pousser plus loin.",
    images: ["/og-image.png"],
  },

  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0910",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}