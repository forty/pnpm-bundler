# pnpm-bundle

*WIP. This is quick and dirty code to figure out how these things work*

Some tests on bundling pnpm module in a dependency-free tarball without merging the files (like `esbuild` or `webpack` would do).

This script takes as parameters a pnpm repository (must have a `pnpm-lock.yaml`) and a package in this repo (the "main importer id")

Example: bundling the core package of pnpm (it would normally be more interesting to bundle packages/pnpm, but it's already esbuild-ed, so it's not interesting currently)
``` sh
node ./index.js ./my/repos/pnpm package/core
```

The main importer is added to the tar (same as if `npm pack` had been run on the package), then all the dependencies are bundled with it, in a `node_modules` folder in the tarball. The packages are mostly bundled as is, following pnpm organization of the node_modules, with the symbolic links added as is. The internal dependencies inside the same monorepo are added inside the `node_modules` folder, using the same isolation technics as other modules and selecting only the files that are supposed to be packaged. Finally, links to the main importer direct dependencies are added in the main `node_modules` folder so that they can be accessed.

This seems to work well at least in simple cases. I'm sure many special setups (like messing with the hoisting) are not going to work well.



