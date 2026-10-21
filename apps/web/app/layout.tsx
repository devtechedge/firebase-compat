import "./globals.css";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import ThemeToggle from "./ThemeToggle";

const themeBoot = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark")t="dark";document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="dark";}})();`;

export const metadata: Metadata = {
  title: "firebase-compat: self-hosted backend for the unmodified Firebase SDK",
  description: "Auth, Firestore, Realtime Database and Storage compatible with the official Firebase JS SDK. Differentially tested against the Firebase Emulator Suite.",
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }], apple: "/favicon.svg" },
};

export const viewport: Viewport = { themeColor: "#0b0d12" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>
        <header className="top">
          <Link href="/" className="brand"><img src="/favicon.svg" width={22} height={22} alt="" /> firebase-compat</Link>
          <nav>
            <Link href="/demo">Demo app</Link>
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/docs">Docs</Link>
            <a href="https://github.com/devtechedge/firebase-compat">GitHub</a>
          </nav>
          <span className="spacer" />
          <ThemeToggle />
        </header>
        <main>{children}</main>
        <footer>MIT licensed. Not affiliated with Google. Firebase is a trademark of Google LLC.</footer>
      </body>
    </html>
  );
}
