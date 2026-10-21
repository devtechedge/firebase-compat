# Differential conformance suite

The same cases run with the unmodified `firebase` JS SDK against the official Firebase
Emulator Suite and against firebase-compat. A case passes only when both backends produce an
identical normalized result (values, error codes, ordering).

```bash
# 1. start the official emulators (needs Java 21 and firebase-tools)
cd packages/conformance/emulator && firebase emulators:start --project demo-compat
# 2. run the cases against both backends and compare
pnpm --filter @firebase-compat/conformance conformance --target emulator
pnpm --filter @firebase-compat/conformance conformance --target compat
node packages/conformance/src/run.mjs --compare packages/conformance/results/emulator.json packages/conformance/results/compat.json
```

Results: `results/summary.json`, `results/report.md`, and `results/web.json` for the browser
(WebChannel) scenario produced by `tools/capture/compare.mjs`.
