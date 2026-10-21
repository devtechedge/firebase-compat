import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "firebase-compat: self-hosted backend for the unmodified Firebase SDK",
  description: "Auth, Firestore, Realtime Database and Storage compatible with the official Firebase JS SDK. Differentially tested against the Firebase Emulator Suite.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand"><img src="/favicon.svg" width={22} height={22} alt="" /> firebase-compat</Link>
          <nav>
            <Link href="/demo">Demo app</Link>
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/docs">Docs</Link>
            <a href="https://github.com/devtechedge/firebase-compat">GitHub</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer>MIT licensed. Not affiliated with Google. Firebase is a trademark of Google LLC.</footer>
      </body>
    </html>
  );
}
