import { describe, expect, it } from 'vitest'
import { createRouterPluginContext } from '../src/core/router-plugin-context'
import { TanStackRouterCodeSplitterRspack } from '../src/rspack'

interface RuleData {
  resource: string
  resourceQuery: string
}

interface Rule {
  use: (data: RuleData) => Array<unknown>
}

// Applies the code splitter to a minimal Rspack compiler and returns the
// loaders its module rules give to a module.
function createLoadersFor() {
  const rules: Array<Rule> = []
  const compiler = {
    options: { context: '/app', mode: 'development', module: { rules } },
    rspack: {
      version: '2.0.0',
      experiments: { VirtualModulesPlugin: class {} },
    },
  }
  TanStackRouterCodeSplitterRspack(
    { target: 'react', autoCodeSplitting: true },
    createRouterPluginContext(),
  ).apply(compiler as never)

  return (resource: string, resourceQuery = '') =>
    rules.flatMap((rule) => rule.use({ resource, resourceQuery }))
}

describe('code splitter Rspack rules', () => {
  it('adds no loader to modules in node_modules', () => {
    const loadersFor = createLoadersFor()

    expect(loadersFor('/app/src/routes/posts.tsx')).toHaveLength(1)
    expect(
      loadersFor('/app/src/routes/posts.tsx', '?tsr-split=component'),
    ).toHaveLength(1)
    expect(loadersFor('/app/node_modules/some-lib/index.js')).toEqual([])
    expect(loadersFor('/app/node_modules/some-lib/route.tsx')).toEqual([])
  })
})
