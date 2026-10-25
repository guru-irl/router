import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RSBUILD_ENVIRONMENT_NAMES } from '../../src/rsbuild/planning'
import { tanStackStartRsbuild } from '../../src/rsbuild/plugin'
import { enableSwcReactServerComponents } from '../../src/rsbuild/swc-rsc'
import type { AddressInfo } from 'node:net'
import type { RsbuildConfig } from '@rsbuild/core'

function createPlugin(opts: {
  providerEnvironmentName: string
  concurrentDevRebuilds?: boolean
}) {
  return tanStackStartRsbuild(
    {
      framework: 'react',
      defaultEntryPaths: {
        client: '/entry/client.tsx',
        server: '/entry/server.ts',
        start: '/entry/start.ts',
      },
      providerEnvironmentName: opts.providerEnvironmentName,
      ssrIsProvider:
        opts.providerEnvironmentName === RSBUILD_ENVIRONMENT_NAMES.server,
    },
    { rsbuild: { concurrentDevRebuilds: opts.concurrentDevRebuilds } },
  )
}

// Calls `plugin.setup` with the given api members. Other members are no-ops.
function setupPlugin(
  plugin: ReturnType<typeof tanStackStartRsbuild>,
  api: Record<PropertyKey, unknown>,
) {
  plugin.setup(
    new Proxy(api, {
      get: (target, key) => (key in target ? target[key] : () => {}),
    }) as any,
  )
}

// Returns the dependencies the plugin sets on the MultiCompiler.
function getServerDependencies(opts: {
  action: 'dev' | 'build'
  providerEnvironmentName?: string
  concurrentDevRebuilds?: boolean
}) {
  const providerEnvironmentName =
    opts.providerEnvironmentName ?? RSBUILD_ENVIRONMENT_NAMES.server
  const plugin = createPlugin({
    providerEnvironmentName,
    concurrentDevRebuilds: opts.concurrentDevRebuilds,
  })

  const afterCreateCompiler: Array<(params: { compiler: unknown }) => void> = []
  setupPlugin(plugin, {
    context: { action: opts.action, rootPath: '/app' },
    onAfterCreateCompiler: (fn: (params: { compiler: unknown }) => void) => {
      afterCreateCompiler.push(fn)
    },
  })

  const hooks = new Proxy({}, { get: () => ({ tap() {}, tapPromise() {} }) })
  const compilers = [
    ...new Set([
      RSBUILD_ENVIRONMENT_NAMES.client,
      RSBUILD_ENVIRONMENT_NAMES.server,
      providerEnvironmentName,
    ]),
  ].map((name) => ({ name, hooks }))
  const setDependencies = vi.fn()
  for (const fn of afterCreateCompiler) {
    fn({ compiler: { compilers, setDependencies } })
  }
  return setDependencies.mock.calls.map(([compiler, dependencies]) => [
    compiler.name,
    dependencies,
  ])
}

describe('tanStackStartRsbuild build order', () => {
  test('rebuilds the server alongside the client in dev', () => {
    expect(getServerDependencies({ action: 'dev' })).toEqual([])
  })

  test.each([
    ['a build', { action: 'build' }],
    [
      'dev with concurrentDevRebuilds: false',
      { action: 'dev', concurrentDevRebuilds: false },
    ],
  ] as const)('builds the server after the client in %s', (_, opts) => {
    expect(getServerDependencies(opts)).toEqual([['ssr', ['client']]])
  })

  test('builds the server after the client and a separate server function provider in dev', () => {
    expect(
      getServerDependencies({
        action: 'dev',
        providerEnvironmentName: 'provider',
      }),
    ).toEqual([
      ['ssr', ['client', 'provider']],
      ['provider', ['client']],
    ])
  })
})

const roots: Array<string> = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// Sends a request through the dev SSR middleware from the plugin's Rsbuild
// config and returns how many times it read the client build stats.
async function countClientStatsReads(opts: {
  concurrentDevRebuilds?: boolean
}) {
  const root = mkdtempSync(join(tmpdir(), 'tanstack-start-rsbuild-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'router.ts'), 'export {}\n')

  const mergeConfig = (config: RsbuildConfig, overrides: RsbuildConfig) => ({
    ...config,
    ...overrides,
  })
  let modifyRsbuildConfig!: (
    config: RsbuildConfig,
    utils: { mergeRsbuildConfig: typeof mergeConfig },
  ) => RsbuildConfig
  setupPlugin(
    createPlugin({
      providerEnvironmentName: RSBUILD_ENVIRONMENT_NAMES.server,
      concurrentDevRebuilds: opts.concurrentDevRebuilds,
    }),
    {
      context: { action: 'dev', rootPath: root },
      modifyRsbuildConfig: (fn: typeof modifyRsbuildConfig) => {
        modifyRsbuildConfig = fn
      },
    },
  )
  const config = modifyRsbuildConfig(
    { root },
    { mergeRsbuildConfig: mergeConfig },
  )

  const getClientStats = vi.fn(async () => ({}))
  const middlewares: Array<
    (req: unknown, res: unknown, next: () => void) => unknown
  > = []
  const setup = config.server?.setup as (context: unknown) => () => void
  setup({
    action: 'dev',
    server: {
      middlewares: {
        use: (middleware: (typeof middlewares)[number]) =>
          middlewares.push(middleware),
      },
      environments: {
        client: { getStats: getClientStats },
        ssr: {
          getStats: async () => ({}),
          loadBundle: async () => ({
            default: { fetch: () => new Response('rendered') },
          }),
        },
      },
    },
  })()

  const server = createServer((req, res) => {
    void middlewares[1]!(req, res, () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://localhost:${port}/`)
    expect(await response.text()).toBe('rendered')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  return getClientStats.mock.calls.length
}

describe('tanStackStartRsbuild dev requests', () => {
  test('wait for the client build by default', async () => {
    expect(await countClientStatsReads({})).toBe(1)
  })

  test('do not wait for the client build with concurrentDevRebuilds: false', async () => {
    expect(await countClientStatsReads({ concurrentDevRebuilds: false })).toBe(
      0,
    )
  })
})

describe('enableSwcReactServerComponents', () => {
  test('clones rspack rules without structuredClone so function fields survive', () => {
    const optionFn = () => 'kept'
    const ruleFn = () => true
    const config = {
      module: {
        rules: [
          {
            test: /\.[jt]sx?$/,
            issuer: ruleFn,
            use: [
              {
                loader: 'builtin:swc-loader',
                options: {
                  optionFn,
                },
              },
            ],
          },
        ],
      },
      resolve: {},
    } as any

    expect(() => {
      enableSwcReactServerComponents(config, 'rsc-subtree')
    }).not.toThrow()

    const oneOf = config.module.rules[0].oneOf
    expect(oneOf).toHaveLength(4)
    expect(oneOf[0].issuer).toBe(ruleFn)
    expect(oneOf[0].use[0].options.optionFn).toBe(optionFn)
    expect(
      oneOf[0].use[0].options.rspackExperiments.reactServerComponents,
    ).toEqual({})
    expect(oneOf[3].use[0].options.rspackExperiments).toBeUndefined()
  })
})
