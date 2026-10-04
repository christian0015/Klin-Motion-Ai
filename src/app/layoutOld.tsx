//src/app/layout.tsx
/** layout.tsx — coquille HTML commune. Les polices et couleurs viennent de globals.css (aucune police ici). */
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "MotionIA — le montage vidéo qui se fait tout seul", template: "%s · MotionIA" },
  description: "Déposez vos rushs, décrivez ce que vous voulez : l'IA monte, vous retouchez. Sous-titres cinétiques, effets, export MP4.",
};
export const viewport: Viewport = { themeColor: "#0a0910", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
