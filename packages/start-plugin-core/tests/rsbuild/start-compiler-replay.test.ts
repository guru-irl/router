import { describe, expect, it, vi } from 'vitest'
import { registerStartCompilerTransforms } from '../../src/rsbuild/start-compiler-host'
import { SERVER_FN_BUILD_INFO_FIELD } from '../../src/rsbuild/start-compiler-metadata'
import type { RsbuildPluginAPI } from '@rsbuild/core'

type Tap = (...args: Array<any>) => unknown

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

function serverFnModule(id: string) {
  return {
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

function setup() {
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

  const finishMake = (
    modules: Array<{ buildInfo: Record<string, unknown> }>,
  ) => {
    compiler.hooks.finishMake.call({ compiler, modules })
  }

  return { serverFnsById, finishMake }
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
})
