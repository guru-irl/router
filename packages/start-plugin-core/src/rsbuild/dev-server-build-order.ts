import type { Rspack } from '@rsbuild/core'

const PLUGIN_NAME = 'TanStackStartDevServerBuildOrder'

// Before stage -20, where each compiler merges the server functions it found.
const SERVER_WAIT_STAGE = -30

// After the client's other finishMake taps, including its stage -20 merge.
const CLIENT_MERGED_STAGE = Number.MAX_SAFE_INTEGER

export interface DevServerBuildOrderOptions {
  /**
   * Whether the server function resolver was written after the server
   * compiler last rebuilt it.
   */
  isServerResolverStale: () => boolean
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function createDeferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * Orders the client and server compilers in development without making every
 * server rebuild wait for the client.
 *
 * - The first server build starts after the first client build.
 * - Later builds run at the same time. Before the server merges server
 *   functions, it waits until a pending or running client compilation has
 *   merged its own, so the server function resolver includes them.
 * - When the resolver changes and no server build will pick it up, the server
 *   rebuilds.
 * - The server stops waiting when the client compilation finishes or fails,
 *   or when its watcher closes.
 */
export function orderDevServerBuilds(
  client: Rspack.Compiler,
  server: Rspack.Compiler,
  options: DevServerBuildOrderOptions,
): void {
  const firstClientBuild = createDeferred()
  client.hooks.afterDone.tap(PLUGIN_NAME, firstClientBuild.resolve)
  client.hooks.failed.tap(PLUGIN_NAME, firstClientBuild.resolve)
  client.hooks.watchClose.tap(PLUGIN_NAME, firstClientBuild.resolve)
  server.hooks.watchRun.tapPromise(PLUGIN_NAME, () => firstClientBuild.promise)

  // A server build in progress picks up the change at its resolver rebuild,
  // or checks again when it is done.
  const rebuildIdleServerIfStale = () => {
    const watching = server.watching
    if (watching && !watching.running && options.isServerResolverStale()) {
      watching.invalidate()
    }
  }

  let clientCompilation: Deferred | undefined
  const armClientCompilation = () => {
    clientCompilation ??= createDeferred()
  }
  const releaseClientCompilation = () => {
    clientCompilation?.resolve()
    clientCompilation = undefined
  }

  // `invalid` runs on the first file change, before either compiler starts.
  client.hooks.invalid.tap(PLUGIN_NAME, armClientCompilation)
  client.hooks.watchRun.tap(PLUGIN_NAME, armClientCompilation)
  client.hooks.finishMake.tap(
    { name: PLUGIN_NAME, stage: CLIENT_MERGED_STAGE },
    (compilation) => {
      // Child compilers copy finishMake taps from their parent.
      if (compilation.compiler === client) {
        releaseClientCompilation()
        rebuildIdleServerIfStale()
      }
    },
  )
  client.hooks.done.tap(PLUGIN_NAME, releaseClientCompilation)
  client.hooks.failed.tap(PLUGIN_NAME, releaseClientCompilation)
  client.hooks.watchClose.tap(PLUGIN_NAME, releaseClientCompilation)
  // The client also refreshes the resolver after it compiles.
  client.hooks.afterDone.tap(PLUGIN_NAME, rebuildIdleServerIfStale)

  server.hooks.finishMake.tapPromise(
    { name: PLUGIN_NAME, stage: SERVER_WAIT_STAGE },
    async (compilation) => {
      if (compilation.compiler !== server) {
        return
      }
      await clientCompilation?.promise
    },
  )
  // The resolver can change after the server rebuilt it in this build.
  server.hooks.afterDone.tap(PLUGIN_NAME, rebuildIdleServerIfStale)
}
