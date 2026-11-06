import {
  SERVER_FN_BUILD_INFO_CONTEXT_KEY,
  hasServerFns,
} from './start-compiler-metadata'
import type { Rspack } from '@rsbuild/core'
import type {
  ServerFnBuildInfoLoaderContext,
  ServerFnMetadataLoaderOptions,
} from './start-compiler-metadata'

const tanStackStartCompilerMetadataLoader: Rspack.LoaderDefinition<
  ServerFnMetadataLoaderOptions,
  ServerFnBuildInfoLoaderContext
> = function (source, map): void {
  const { metadataById, resourcesWithMetadata } = this.getOptions()
  const id = this.resource
  const metadata = metadataById.get(id)

  // A module needs a write only when it has new metadata or still carries
  // metadata from an earlier build that may now be stale.
  if (metadata || resourcesWithMetadata.has(id)) {
    const setBuildInfo = this[SERVER_FN_BUILD_INFO_CONTEXT_KEY]
    setBuildInfo?.(metadata ?? null)
  }

  if (metadata && hasServerFns(metadata.serverFnsById)) {
    resourcesWithMetadata.add(id)
  } else {
    resourcesWithMetadata.delete(id)
  }

  this.callback(null, source, map)
}

export default tanStackStartCompilerMetadataLoader
