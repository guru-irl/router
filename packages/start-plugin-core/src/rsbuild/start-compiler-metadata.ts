import type { ServerFn } from '../start-compiler/types'

export const SERVER_FN_BUILD_INFO_FIELD = 'tanstack.start.serverFns'

export type ServerFnBuildInfo = {
  version: 1
  serverFnsById: Record<string, ServerFn>
}

export type ServerFnMetadataLoaderOptions = {
  metadataById: Map<string, ServerFnBuildInfo>
  /**
   * Resources whose module carries server function metadata in `buildInfo`,
   * written by the loader or restored from the cache. Other modules have
   * nothing to write or clear, so the loader leaves them untouched.
   */
  resourcesWithMetadata: Set<string>
}

const EMPTY_SERVER_FN_BUILD_INFO: ServerFnBuildInfo = {
  version: 1,
  serverFnsById: {},
}

export function hasServerFns(
  serverFnsById: ServerFnBuildInfo['serverFnsById'],
): boolean {
  return Object.keys(serverFnsById).length > 0
}

/**
 * Writes discovered metadata to a module's `buildInfo`, or replaces metadata
 * left by an earlier build with an empty payload.
 */
export function writeServerFnBuildInfo(
  buildInfo: Record<string, unknown>,
  metadata: ServerFnBuildInfo | null,
): void {
  if (metadata) {
    buildInfo[SERVER_FN_BUILD_INFO_FIELD] = metadata
  } else if (buildInfo[SERVER_FN_BUILD_INFO_FIELD]) {
    buildInfo[SERVER_FN_BUILD_INFO_FIELD] = EMPTY_SERVER_FN_BUILD_INFO
  }
}
