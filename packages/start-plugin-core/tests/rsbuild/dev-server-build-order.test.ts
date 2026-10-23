import { describe, expect, test, vi } from 'vitest'
import { orderDevServerBuilds } from '../../src/rsbuild/dev-server-build-order'
import { RSBUILD_ENVIRONMENT_NAMES } from '../../src/rsbuild/planning'
import { tapServerFnResolverRebuild } from '../../src/rsbuild/server-fn-resolver-rebuild'
import { registerVirtualModules } from '../../src/rsbuild/virtual-modules'
import type { ServerFn } from '../../src/start-compiler/types'

type TapOptions = string | { name: string; stage?: number }
type Tap = { stage: number; fn: (...args: Array<any>) => unknown }

// Runs taps in stage order and awaits each one, like Rspack's hooks.
function createHook() {
  const taps: Array<Tap> = []
  const add = (options: TapOptions, fn: Tap['fn']) => {
    const stage = typeof options === 'string' ? 0 : (options.stage ?? 0)
    taps.push({ stage, fn })
    taps.sort((a, b) => a.stage - b.stage)
  }
  return {
    tap: add,
    tapPromise: add,
    async call(...args: Array<unknown>) {
      for (const tap of [...taps]) {
        await tap.fn(...args)
      }
    },
  }
}

function createCompiler() {
  return {
    hooks: {
      watchRun: createHook(),
      finishMake: createHook(),
      invalid: createHook(),
      done: createHook(),
      afterDone: createHook(),
      failed: createHook(),
      watchClose: createHook(),
    },
    watching: { running: false, invalidate: vi.fn() },
  }
}

type FakeCompiler = ReturnType<typeof createCompiler>

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function isSettled(promise: Promise<unknown>) {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true),
  )
  await flush()
  return settled
}

function setup(opts: { isServerResolverStale?: () => boolean } = {}) {
  const client = createCompiler()
  const server = createCompiler()
  orderDevServerBuilds(client as any, server as any, {
    isServerResolverStale: opts.isServerResolverStale ?? (() => false),
  })
  return { client, server }
}

async function finishFirstClientBuild(client: FakeCompiler) {
  await client.hooks.watchRun.call(client)
  await client.hooks.finishMake.call({ compiler: client })
  await client.hooks.done.call({})
  await client.hooks.afterDone.call({})
}

describe('orderDevServerBuilds', () => {
  test('starts the first server build after the first client build', async () => {
    const { client, server } = setup()

    const serverRun = server.hooks.watchRun.call(server)
    await client.hooks.watchRun.call(client)
    await client.hooks.finishMake.call({ compiler: client })
    expect(await isSettled(serverRun)).toBe(false)

    await client.hooks.done.call({})
    await client.hooks.afterDone.call({})
    expect(await isSettled(serverRun)).toBe(true)
  })

  test.each(['failed', 'watchClose'] as const)(
    'starts the first server build when the client hook %s runs',
    async (hook) => {
      const { client, server } = setup()

      const serverRun = server.hooks.watchRun.call(server)
      await client.hooks.watchRun.call(client)
      expect(await isSettled(serverRun)).toBe(false)

      await client.hooks[hook].call()
      expect(await isSettled(serverRun)).toBe(true)
    },
  )

  test('starts later server builds while the client is building', async () => {
    const { client, server } = setup()
    await finishFirstClientBuild(client)
    await server.hooks.watchRun.call(server)

    await client.hooks.watchRun.call(client)
    expect(await isSettled(server.hooks.watchRun.call(server))).toBe(true)
  })

  test('merges server functions on the server after the client compilation in progress', async () => {
    const { client, server } = setup()
    await finishFirstClientBuild(client)
    const merges: Array<string> = []
    client.hooks.finishMake.tap({ name: 'merge', stage: -20 }, () => {
      merges.push('client')
    })
    server.hooks.finishMake.tap({ name: 'merge', stage: -20 }, () => {
      merges.push('server')
    })

    await client.hooks.watchRun.call(client)
    const serverFinishMake = server.hooks.finishMake.call({ compiler: server })
    expect(await isSettled(serverFinishMake)).toBe(false)
    expect(merges).toEqual([])

    await client.hooks.finishMake.call({ compiler: client })
    await serverFinishMake
    expect(merges).toEqual(['client', 'server'])
  })

  test('does not hold the server when the client is not building', async () => {
    const { client, server } = setup()
    await finishFirstClientBuild(client)

    expect(
      await isSettled(server.hooks.finishMake.call({ compiler: server })),
    ).toBe(true)
  })

  test('ignores child compilations', async () => {
    const { client, server } = setup()
    await finishFirstClientBuild(client)
    await client.hooks.watchRun.call(client)

    expect(
      await isSettled(server.hooks.finishMake.call({ compiler: {} })),
    ).toBe(true)

    const serverFinishMake = server.hooks.finishMake.call({ compiler: server })
    await client.hooks.finishMake.call({ compiler: {} })
    expect(await isSettled(serverFinishMake)).toBe(false)

    await client.hooks.finishMake.call({ compiler: client })
    expect(await isSettled(serverFinishMake)).toBe(true)
  })

  test.each(['invalid', 'done', 'failed', 'watchClose'] as const)(
    'releases the server when the client hook %s runs',
    async (hook) => {
      const { client, server } = setup()
      await finishFirstClientBuild(client)
      await client.hooks.watchRun.call(client)

      const serverFinishMake = server.hooks.finishMake.call({
        compiler: server,
      })
      expect(await isSettled(serverFinishMake)).toBe(false)

      await client.hooks[hook].call()
      expect(await isSettled(serverFinishMake)).toBe(true)
    },
  )

  test('rebuilds an idle server once the client has merged a resolver change', async () => {
    let stale = false
    const { client, server } = setup({ isServerResolverStale: () => stale })
    await finishFirstClientBuild(client)

    await client.hooks.watchRun.call(client)
    stale = true
    await client.hooks.finishMake.call({ compiler: client })
    expect(server.watching.invalidate).toHaveBeenCalledTimes(1)
  })

  test('rebuilds an idle server when the resolver changes as the client finishes', async () => {
    let stale = false
    const { client, server } = setup({ isServerResolverStale: () => stale })
    await finishFirstClientBuild(client)

    await client.hooks.watchRun.call(client)
    await client.hooks.finishMake.call({ compiler: client })
    stale = true
    await client.hooks.done.call({})
    await client.hooks.afterDone.call({})
    expect(server.watching.invalidate).toHaveBeenCalledTimes(1)
  })

  test('leaves a resolver change to a server build in progress', async () => {
    const { client, server } = setup({ isServerResolverStale: () => true })
    server.watching.running = true
    await finishFirstClientBuild(client)

    await client.hooks.watchRun.call(client)
    await client.hooks.finishMake.call({ compiler: client })
    await client.hooks.done.call({})
    await client.hooks.afterDone.call({})
    expect(server.watching.invalidate).not.toHaveBeenCalled()
  })

  test('rebuilds the server after a build that missed a resolver change', async () => {
    let stale = false
    const { client, server } = setup({ isServerResolverStale: () => stale })
    await finishFirstClientBuild(client)

    await server.hooks.afterDone.call({})
    expect(server.watching.invalidate).not.toHaveBeenCalled()

    stale = true
    await server.hooks.afterDone.call({})
    expect(server.watching.invalidate).toHaveBeenCalledTimes(1)
  })

  describe('with the server function resolver', () => {
    function setupWithResolver() {
      const serverFnsById: Record<string, ServerFn> = {}
      const virtualModules = registerVirtualModules(
        {
          context: { action: 'dev' },
          modifyRspackConfig: () => {},
        } as any,
        {
          root: '/app',
          getConfig: () => {
            throw new Error('getConfig is not used by these tests')
          },
          serverFnsById,
          providerEnvName: RSBUILD_ENVIRONMENT_NAMES.server,
          ssrIsProvider: true,
          serializationAdapters: undefined,
          getDevClientEntryUrl: () => '/client.js',
          rscEnabled: false,
          scriptFormat: 'module',
        },
      )
      const client = createCompiler()
      const server = createCompiler()

      // Each compiler merges the server functions it found at stage -20, and
      // the registry holds the union, as in start-compiler-host.ts.
      const foundByCompiler = new Map<FakeCompiler, Record<string, ServerFn>>()
      const merged = new Map<FakeCompiler, Record<string, ServerFn>>()
      for (const compiler of [client, server]) {
        compiler.hooks.finishMake.tap({ name: 'merge', stage: -20 }, () => {
          merged.set(compiler, foundByCompiler.get(compiler) ?? {})
          for (const id of Object.keys(serverFnsById)) {
            delete serverFnsById[id]
          }
          for (const serverFns of merged.values()) {
            Object.assign(serverFnsById, serverFns)
          }
          virtualModules.updateServerFnResolver()
        })
      }

      const rebuiltWith: Array<Array<string>> = []
      const resolverRebuild = tapServerFnResolverRebuild(server as any, {
        name: 'test',
        updateResolver: () => virtualModules.updateServerFnResolver(),
        getResolverWriteCount: () =>
          virtualModules.getServerFnResolverWriteCount(
            RSBUILD_ENVIRONMENT_NAMES.server,
          ),
        rebuildResolver: async () => {
          rebuiltWith.push(Object.keys(serverFnsById))
        },
      })
      orderDevServerBuilds(client as any, server as any, {
        isServerResolverStale: resolverRebuild.isStale,
      })

      const findOnClient = (id: string) => {
        foundByCompiler.set(client, {
          [id]: {
            functionName: id,
            functionId: id,
            extractedFilename: `/app/src/${id}.ts?tss-serverfn-split`,
            filename: `/app/src/${id}.ts`,
          },
        })
      }

      return { client, server, rebuiltWith, findOnClient }
    }

    // Like Rspack's Watching: running from watchRun until done.
    async function serverBuild(
      server: FakeCompiler,
      finishMake: () => Promise<void>,
    ) {
      server.watching.running = true
      await server.hooks.watchRun.call(server)
      await finishMake()
      server.watching.running = false
      await server.hooks.done.call({})
      await server.hooks.afterDone.call({})
    }

    async function firstBuild({
      client,
      server,
    }: {
      client: FakeCompiler
      server: FakeCompiler
    }) {
      await Promise.all([
        serverBuild(server, () =>
          server.hooks.finishMake.call({ compiler: server }),
        ),
        finishFirstClientBuild(client),
      ])
    }

    test('rebuilds the server resolver with a server function the client found in the same rebuild', async () => {
      const context = setupWithResolver()
      const { client, server, rebuiltWith, findOnClient } = context
      await firstBuild(context)
      expect(rebuiltWith).toEqual([[]])

      // An edit that both compilers rebuild, where only the client finds a
      // new server function.
      findOnClient('added')
      await client.hooks.watchRun.call(client)
      const serverRebuild = serverBuild(server, async () => {
        const serverFinishMake = server.hooks.finishMake.call({
          compiler: server,
        })
        // The server gets as far as it can before the client merges.
        await flush()
        await client.hooks.finishMake.call({ compiler: client })
        await serverFinishMake
      })
      await serverRebuild
      await client.hooks.done.call({})
      await client.hooks.afterDone.call({})

      expect(rebuiltWith).toEqual([[], ['added']])
      expect(server.watching.invalidate).not.toHaveBeenCalled()
    })

    test('rebuilds an idle server when only the client finds a new server function', async () => {
      const context = setupWithResolver()
      const { client, server, rebuiltWith, findOnClient } = context
      await firstBuild(context)

      findOnClient('added')
      await client.hooks.watchRun.call(client)
      await client.hooks.finishMake.call({ compiler: client })
      expect(server.watching.invalidate).toHaveBeenCalledTimes(1)

      await serverBuild(server, () =>
        server.hooks.finishMake.call({ compiler: server }),
      )
      await client.hooks.done.call({})
      await client.hooks.afterDone.call({})
      expect(rebuiltWith).toEqual([[], ['added']])
      expect(server.watching.invalidate).toHaveBeenCalledTimes(1)
    })
  })
})
