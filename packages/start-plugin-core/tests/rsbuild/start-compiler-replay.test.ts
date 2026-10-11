import { describe, expect, it, vi } from 'vitest'
import { registerStartCompilerTransforms } from '../../src/rsbuild/start-compiler-host'
import { SERVER_FN_BUILD_INFO_FIELD } from '../../src/rsbuild/start-compiler-metadata'
import type { RsbuildPluginAPI } from '@rsbuild/core'

type Tap = (...args: Array<any>) => unknown

interface FakeModule {
  identifier?: () => string
  buildInfo: Record<string, unknown>
}

function createHook() {
  const taps: Array<Tap> = []
  return {
    tap: (_options: unknown, fn: Tap) => {
      taps.push(fn)
    },
    call: (...args: Array<unknown>) => {
      for (const fn of taps) {
        fn(...args)
      }
    },
  }
}

function serverFnModule(id: string): FakeModule {
  return {
    identifier: () => `/app/src/${id}.ts`,
    buildInfo: {
      [SERVER_FN_BUILD_INFO_FIELD]: {
        version: 1,
        serverFnsById: {
          [id]: {
            functionName: `${id}_fn`,
            functionId: id,
            extractedFilename: `/app/src/${id}.ts`,
            filename: `/app/src/${id}.ts`,
          },
        },
      },
    },
  }
}

function plainModule(identifier: string): FakeModule {
  return { identifier: () => identifier, buildInfo: {} }
}

function setup() {
  const onServerFnsByIdChange = vi.fn()
  const modifyRspackConfigCallbacks: Array<Tap> = []
  const api = {
    context: { action: 'build' },
    modifyRspackConfig: (callback: Tap) => {
      modifyRspackConfigCallbacks.push(callback)
    },
    transform: vi.fn(),
  } as unknown as RsbuildPluginAPI

  const { serverFnsById } = registerStartCompilerTransforms(api, {
    framework: 'react',
    root: '/app',
    environments: [{ name: 'client', type: 'client' }],
    providerEnvName: 'ssr',
    onServerFnsByIdChange,
  })

  const config = {
    module: { rules: [] as Array<any> },
    plugins: [] as Array<any>,
  }
  const utils = {
    environment: { name: 'client' },
    rspack: {
      NormalModule: { getCompilationHooks: () => ({ loader: createHook() }) },
    },
  }
  for (const callback of modifyRspackConfigCallbacks) {
    callback(config, utils)
  }

  const compiler = {
    inputFileSystem: undefined,
    hooks: {
      compilation: createHook(),
      compile: createHook(),
      finishMake: createHook(),
      watchRun: createHook(),
    },
  }
  for (const plugin of config.plugins) {
    plugin.apply(compiler)
  }

  // Released Rspack versions return a new Set from compilation.modules.
  const finishMake = (modules: Array<FakeModule>) => {
    compiler.hooks.finishMake.call({ compiler, modules: new Set(modules) })
  }

  // Newer Rspack versions return a lazy view that is not a Set, and list the
  // modules added or rebuilt in the compilation in builtModules.
  const finishLazyMake = (
    modules: Array<FakeModule>,
    builtModules: Array<FakeModule>,
  ) => {
    const moduleSet = new Set(modules)
    // Like Rspack, has() looks modules up by identifier, so a module object
    // from an earlier compilation still counts after the module is rebuilt.
    const identifiers = new Set(modules.map((module) => module.identifier?.()))
    let iterations = 0
    const lazyModules = {
      has: (module: FakeModule) => identifiers.has(module.identifier?.()),
      [Symbol.iterator]: () => {
        iterations++
        return moduleSet.values()
      },
    }
    compiler.hooks.finishMake.call({
      compiler,
      modules: lazyModules,
      builtModules: new Set(builtModules),
    })
    return { iterations }
  }

  // Rspack copies finishMake taps into child compilers (for example the one
  // html-rspack-plugin creates for a template), so the same tap also runs for
  // a child compilation that only contains the child's modules.
  const childCompiler = { name: 'child-compiler' }
  const finishChildMake = (modules: Array<FakeModule>) => {
    compiler.hooks.finishMake.call({
      compiler: childCompiler,
      modules: new Set(modules),
    })
  }

  return {
    serverFnsById,
    finishMake,
    finishLazyMake,
    finishChildMake,
    onServerFnsByIdChange,
  }
}

describe('rsbuild server function metadata replay', () => {
  it('replays valid metadata and ignores modules without it', () => {
    const { serverFnsById, finishMake } = setup()

    finishMake([
      serverFnModule('a'),
      { buildInfo: {} },
      {
        buildInfo: {
          [SERVER_FN_BUILD_INFO_FIELD]: { version: 2, serverFnsById: {} },
        },
      },
      { buildInfo: { [SERVER_FN_BUILD_INFO_FIELD]: null } },
    ])

    expect(Object.keys(serverFnsById)).toEqual(['a'])
    expect(serverFnsById.a).toMatchObject({ functionId: 'a' })
  })

  it('drops server functions whose module left the module graph', () => {
    const { serverFnsById, finishMake } = setup()

    finishMake([serverFnModule('a'), serverFnModule('b')])
    expect(Object.keys(serverFnsById).sort()).toEqual(['a', 'b'])

    finishMake([serverFnModule('b')])
    expect(Object.keys(serverFnsById)).toEqual(['b'])
  })

  it('ignores child compilations, which only see their own modules', () => {
    const {
      serverFnsById,
      finishMake,
      finishChildMake,
      onServerFnsByIdChange,
    } = setup()

    finishMake([serverFnModule('a')])
    const changesAfterParent = onServerFnsByIdChange.mock.calls.length

    finishChildMake([{ buildInfo: {} }])

    expect(Object.keys(serverFnsById)).toEqual(['a'])
    expect(onServerFnsByIdChange).toHaveBeenCalledTimes(changesAfterParent)
  })

  describe('when compilation.modules is lazy', () => {
    it('scans every module only on the first compilation', () => {
      const { serverFnsById, finishLazyMake } = setup()
      const a = serverFnModule('a')
      const plain = plainModule('/app/src/plain.ts')

      expect(finishLazyMake([a, plain], [a, plain]).iterations).toBe(1)
      expect(finishLazyMake([a, plain], []).iterations).toBe(0)
      expect(Object.keys(serverFnsById)).toEqual(['a'])
    })

    it('reads metadata from modules added or rebuilt in the compilation', () => {
      const { serverFnsById, finishLazyMake } = setup()
      const a = serverFnModule('a')
      const b = serverFnModule('b')

      finishLazyMake([a], [a])
      finishLazyMake([a, b], [b])
      expect(Object.keys(serverFnsById).sort()).toEqual(['a', 'b'])

      const rebuiltA = plainModule(a.identifier!())
      finishLazyMake([rebuiltA, b], [rebuiltA])
      expect(Object.keys(serverFnsById)).toEqual(['b'])
    })

    it('drops server functions whose module left the module graph', () => {
      const { serverFnsById, finishLazyMake } = setup()
      const a = serverFnModule('a')
      const b = serverFnModule('b')

      finishLazyMake([a, b], [a, b])
      finishLazyMake([b], [])
      expect(Object.keys(serverFnsById)).toEqual(['b'])
    })
  })
})
