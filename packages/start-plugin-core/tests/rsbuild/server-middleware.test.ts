import { createServer } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { createServerSetup } from '../../src/rsbuild/server-middleware'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

type Middleware = (
  req: unknown,
  res: unknown,
  next: (error?: unknown) => void,
) => unknown

let server: Server | undefined

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve))
  server = undefined
})

async function startDevServer(opts: { waitForClientBuild: boolean }) {
  const events: Array<string> = []
  let clientStatsRequested!: () => void
  const requested = new Promise<void>((resolve) => {
    clientStatsRequested = resolve
  })
  let finishClientBuild!: () => void
  const clientBuild = new Promise<void>((resolve) => {
    finishClientBuild = () => {
      events.push('client built')
      resolve()
    }
  })

  const middlewares: Array<Middleware> = []
  const setup = createServerSetup({
    serverFnBasePath: '/_serverFn/',
    serverOutputDirectory: '/app/dist/server',
    publicBase: '/',
    waitForClientBuild: opts.waitForClientBuild,
  })
  const afterBuiltIns = setup({
    action: 'dev',
    server: {
      middlewares: {
        use: (middleware: Middleware) => middlewares.push(middleware),
      },
      environments: {
        client: {
          getStats: () => {
            events.push('client stats requested')
            clientStatsRequested()
            return clientBuild
          },
        },
        ssr: {
          loadBundle: async () => {
            events.push('server bundle loaded')
            return { default: { fetch: () => new Response('rendered') } }
          },
        },
      },
    },
  } as any)
  ;(afterBuiltIns as () => void)()
  const handleSSR = middlewares[1]!

  server = createServer((req, res) => {
    void handleSSR(req, res, (error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://localhost:${port}/`,
    events,
    requested,
    finishClientBuild,
  }
}

describe('createServerSetup', () => {
  test('renders a dev request after the client build in progress', async () => {
    const dev = await startDevServer({ waitForClientBuild: true })

    const response = fetch(dev.url)
    await Promise.race([dev.requested, response])
    dev.finishClientBuild()

    expect(await (await response).text()).toBe('rendered')
    expect(dev.events).toEqual([
      'client stats requested',
      'client built',
      'server bundle loaded',
    ])
  })

  test('does not wait for the client build when the builds are ordered', async () => {
    const dev = await startDevServer({ waitForClientBuild: false })

    const response = await fetch(dev.url)

    expect(await response.text()).toBe('rendered')
    expect(dev.events).toEqual(['server bundle loaded'])
  })
})
