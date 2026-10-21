"use client";
// The dashboard and demo talk to a firebase-compat server chosen by the user (default localhost).
import { useEffect, useState } from "react";

export const DEFAULT_SERVER = process.env.NEXT_PUBLIC_COMPAT_URL || "http://localhost:8787";
const KEY = "firebase-compat-server";

export function useServerUrl(): [string, (v: string) => void] {
  const [url, setUrl] = useState(DEFAULT_SERVER);
  useEffect(() => { const saved = localStorage.getItem(KEY); if (saved) setUrl(saved); }, []);
  return [url, (v: string) => { localStorage.setItem(KEY, v); setUrl(v); }];
}

export async function admin<T = any>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("firebase-compat-admin-token") : null;
  const res = await fetch(`${base.replace(/\/$/, "")}/__admin/${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}
