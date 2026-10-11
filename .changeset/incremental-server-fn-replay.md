---
'@tanstack/start-plugin-core': patch
---

Rsbuild: with Rspack versions whose `compilation.modules` is a lazy view, the server function replay only reads the modules added or rebuilt in each compilation after the first, instead of every module
