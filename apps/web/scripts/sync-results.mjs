// Copies the latest conformance results into the site so the landing page shows real numbers.
import { copyFileSync, existsSync } from "node:fs";
for (const f of ["summary.json", "web.json"]) {
  const src = new URL(`../../../packages/conformance/results/${f}`, import.meta.url);
  if (existsSync(src)) copyFileSync(src, new URL(`../lib/conformance-${f}`, import.meta.url));
}
