import { hasServerFns, writeServerFnBuildInfo } from './start-compiler-metadata'
import type { Rspack } from '@rsbuild/core'
import type { ServerFnMetadataLoaderOptions } from './start-compiler-metadata'

const tanStackStartCompilerMetadataLoader: Rspack.LoaderDefinition<ServerFnMetadataLoaderOptions> =
  function (source, map): void {
    const { metadataById, resourcesWithMetadata } = this.getOptions()
    const id = this.resource
    const metadata = metadataById.get(id)

    // A module needs a write only when it has new metadata or still carries
    // metadata from an earlier build that may now be stale. The loader reaches
    // the module through `_module` for those modules only, instead of a
    // NormalModule loader hook, which Rspack would call for every module.
    if (metadata || resourcesWithMetadata.has(id)) {
      writeServerFnBuildInfo(this._module.buildInfo, metadata ?? null)
    }

    if (metadata && hasServerFns(metadata.serverFnsById)) {
      resourcesWithMetadata.add(id)
    } else {
      resourcesWithMetadata.delete(id)
    }

    this.callback(null, source, map)
  }

export default tanStackStartCompilerMetadataLoader
