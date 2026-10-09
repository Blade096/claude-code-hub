import type { ReactNode } from "react";
import { defaultLocale } from "@/i18n/config";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={defaultLocale}>
      <body>{children}</body>
    </html>
  );
}
