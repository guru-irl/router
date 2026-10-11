---
'@tanstack/router-plugin': patch
---

Skip `node_modules` modules in the code splitter's route file transform, so dependency modules no longer pass through its loader in Rspack and webpack.
