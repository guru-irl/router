import { describe, expect, test, vi } from 'vitest'
import { RSBUILD_ENVIRONMENT_NAMES } from '../../src/rsbuild/planning'
import { tanStackStartRsbuild } from '../../src/rsbuild/plugin'
import { enableSwcReactServerComponents } from '../../src/rsbuild/swc-rsc'

// Returns the dependencies the plugin sets on the MultiCompiler.
function getServerDependencies(opts: {
  action: 'dev' | 'build'
  providerEnvironmentName?: string
  concurrentDevRebuilds?: boolean
}) {
  const providerEnvironmentName =
    opts.providerEnvironmentName ?? RSBUILD_ENVIRONMENT_NAMES.server
  const plugin = tanStackStartRsbuild(
    {
      framework: 'react',
      defaultEntryPaths: {
        client: '/entry/client.tsx',
        server: '/entry/server.ts',
        start: '/entry/start.ts',
      },
      providerEnvironmentName,
      ssrIsProvider:
        providerEnvironmentName === RSBUILD_ENVIRONMENT_NAMES.server,
    },
    { rsbuild: { concurrentDevRebuilds: opts.concurrentDevRebuilds } },
  )

  const afterCreateCompiler: Array<(params: { compiler: unknown }) => void> = []
  const api: Record<PropertyKey, unknown> = {
    context: { action: opts.action, rootPath: '/app' },
    onAfterCreateCompiler: (fn: (params: { compiler: unknown }) => void) => {
      afterCreateCompiler.push(fn)
    },
  }
  plugin.setup(
    new Proxy(api, {
      get: (target, key) => (key in target ? target[key] : () => {}),
    }) as any,
  )

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
