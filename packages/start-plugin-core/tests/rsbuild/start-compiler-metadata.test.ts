import { describe, expect, it, vi } from 'vitest'
import { registerStartCompilerTransforms } from '../../src/rsbuild/start-compiler-host'
import tanStackStartCompilerMetadataLoader from '../../src/rsbuild/start-compiler-metadata-loader'
import { SERVER_FN_BUILD_INFO_FIELD } from '../../src/rsbuild/start-compiler-metadata'
import type { RsbuildPluginAPI } from '@rsbuild/core'
import type {
  ServerFnBuildInfo,
  ServerFnMetadataLoaderOptions,
} from '../../src/rsbuild/start-compiler-metadata'

type Tap = (...args: Array<any>) => unknown

function createHook() {
  const taps: Array<Tap> = []
  return {
    taps,
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

function createModule(
  resource: string,
  buildInfo: Record<string, unknown> = {},
) {
  let buildInfoReads = 0
  return {
    resource,
    get buildInfo() {
      buildInfoReads++
      return buildInfo
    },
    get buildInfoReads() {
      return buildInfoReads
    },
    rawBuildInfo: buildInfo,
  }
}

type FakeModule = ReturnType<typeof createModule>

function serverFnPayload(id: string): ServerFnBuildInfo {
  return {
    version: 1,
    serverFnsById: {
      [id]: {
        functionName: `${id}_fn`,
        functionId: id,
        extractedFilename: `/app/src/${id}.ts`,
        filename: `/app/src/${id}.ts`,
      },
    },
  }
}

function setup() {
  const modifyRspackConfigCallbacks: Array<Tap> = []
  const api = {
    context: { action: 'build' },
    modifyRspackConfig: (callback: Tap) => {
      modifyRspackConfigCallbacks.push(callback)
    },
    transform: vi.fn(),
  } as unknown as RsbuildPluginAPI

  registerStartCompilerTransforms(api, {
    framework: 'react',
    root: '/app',
    environments: [{ name: 'client', type: 'client' }],
    providerEnvName: 'ssr',
  })

  const loaderHook = createHook()
  const getCompilationHooks = vi.fn(() => ({ loader: loaderHook }))
  const config = {
    module: { rules: [] as Array<any> },
    plugins: [] as Array<any>,
  }
  const utils = {
    environment: { name: 'client' },
    rspack: { NormalModule: { getCompilationHooks } },
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

  const loaderOptions = config.module.rules[0].use[0]
    .options as ServerFnMetadataLoaderOptions

  // One Rspack compilation: the compile hook clears pending metadata, the
  // compilation hook installs per-compilation hooks.
  const startCompilation = () => {
    const compilation = { compiler }
    compiler.hooks.compile.call()
    compiler.hooks.compilation.call(compilation)
    return compilation
  }

  const runMetadataLoader = (module: FakeModule) => {
    const loaderContext: Record<string, unknown> = {
      resource: module.resource,
      _module: module,
      getOptions: () => loaderOptions,
      callback: vi.fn(),
    }
    loaderHook.call(loaderContext, module)
    tanStackStartCompilerMetadataLoader.call(
      loaderContext as never,
      'export {}',
      undefined,
    )
    expect(loaderContext.callback).toHaveBeenCalledWith(
      null,
      'export {}',
      undefined,
    )
  }

  const finishMake = (modules: Array<FakeModule>) => {
    compiler.hooks.finishMake.call({ compiler, modules })
  }

  return {
    loaderOptions,
    getCompilationHooks,
    startCompilation,
    runMetadataLoader,
    finishMake,
  }
}

describe('rsbuild server function metadata loader', () => {
  it('does not touch modules without server function metadata', () => {
    const { startCompilation, runMetadataLoader } = setup()
    startCompilation()

    const module = createModule('/app/node_modules/lib/index.js')
    runMetadataLoader(module)

    expect(module.buildInfoReads).toBe(0)
    expect(module.rawBuildInfo).toEqual({})
  })

  it('writes discovered server function metadata to buildInfo', () => {
    const { startCompilation, runMetadataLoader, loaderOptions } = setup()
    startCompilation()

    const module = createModule('/app/src/a.ts')
    loaderOptions.metadataById.set(module.resource, serverFnPayload('a'))
    runMetadataLoader(module)

    expect(module.rawBuildInfo[SERVER_FN_BUILD_INFO_FIELD]).toEqual(
      serverFnPayload('a'),
    )
  })

  it('clears metadata left by an earlier build in the same process', () => {
    const { startCompilation, runMetadataLoader, loaderOptions } = setup()
    const module = createModule('/app/src/a.ts')

    startCompilation()
    loaderOptions.metadataById.set(module.resource, serverFnPayload('a'))
    runMetadataLoader(module)

    // The file is edited and no longer defines server functions.
    startCompilation()
    runMetadataLoader(module)

    expect(module.rawBuildInfo[SERVER_FN_BUILD_INFO_FIELD]).toEqual({
      version: 1,
      serverFnsById: {},
    })
  })

  it('clears metadata restored from the cache once the module is rebuilt', () => {
    const { startCompilation, runMetadataLoader, finishMake } = setup()
    const restored = createModule('/app/src/a.ts', {
      [SERVER_FN_BUILD_INFO_FIELD]: serverFnPayload('a'),
    })

    // A warm start restores the module without running loaders.
    startCompilation()
    finishMake([restored])

    // The file is edited and no longer defines server functions.
    startCompilation()
    runMetadataLoader(restored)

    expect(restored.rawBuildInfo[SERVER_FN_BUILD_INFO_FIELD]).toEqual({
      version: 1,
      serverFnsById: {},
    })
  })
})
