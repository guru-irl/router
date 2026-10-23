---
'@tanstack/start-plugin-core': patch
---

In Rsbuild development, the server environment now rebuilds at the same time as the client environment instead of after it. The first build still runs the server after the client, and server functions that only the client build reaches are still added to the server. Production builds are unchanged. Set `rsbuild.concurrentDevRebuilds` to `false` to keep the previous order.
