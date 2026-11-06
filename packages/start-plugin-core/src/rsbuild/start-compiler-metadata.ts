import type { ServerFn } from '../start-compiler/types'

export const SERVER_FN_BUILD_INFO_FIELD = 'tanstack.start.serverFns'
export const SERVER_FN_BUILD_INFO_CONTEXT_KEY =
  'tanstack.start.setServerFnBuildInfo'

export type ServerFnBuildInfo = {
  version: 1
  serverFnsById: Record<string, ServerFn>
}

export type SetServerFnBuildInfo = (metadata: ServerFnBuildInfo | null) => void

export type ServerFnBuildInfoLoaderContext = {
  [SERVER_FN_BUILD_INFO_CONTEXT_KEY]?: SetServerFnBuildInfo
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

export function hasServerFns(
  serverFnsById: ServerFnBuildInfo['serverFnsById'],
): boolean {
  return Object.keys(serverFnsById).length > 0
}
