# SAVA ONNX weights

Not committed (too large). Fetch the pinned int8 graph before packaging:

```
node tools/fetch-sava-onnx.mjs
```

Places `sava-int8.onnx` here. electron-builder copies this folder to `resources/sava` (~27 MB extra). If the file is absent, Hirora uses the energy VAD and logs a warning.
