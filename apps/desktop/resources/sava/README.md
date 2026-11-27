# SAVA ONNX weights

Not committed (too large). `pnpm package:win` fetches them before packaging, or run:

```
node tools/fetch-sava-onnx.mjs
```

It downloads `sava-int8.onnx` from `matthiastl/sava-onnx` at a pinned revision and checks its size and SHA-256 (a mismatch is deleted and stops the build). electron-builder copies this folder to `resources/sava` (~27 MB). If the file is absent, Doing uses the energy VAD and logs a warning.
