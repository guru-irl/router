---
'@tanstack/start-plugin-core': patch
---

Rsbuild: the server function replay after each compilation no longer validates modules that carry no server function metadata, which shortens rebuilds in large apps
