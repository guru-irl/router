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
  if (server) {
    await new Promise((resolve) => server!.close(resolve))
    server = undefined
  }
})

const flush = () => new Promise((resolve) => setImmediate(resolve))

// Like an Rsbuild dev environment: `getStats()` and `loadBundle()` wait for a
// build that runs from `watchRun` to `done`.
function createEnvironment(name: string, events: Array<string>) {
  let build = Promise.resolve()
  let finishBuild = () => {}
  return {
    watchRun() {
      build = new Promise<void>((resolve) => {
        finishBuild = () => {
          events.push(`${name} built`)
          resolve()
        }
      })
    },
    done: () => finishBuild(),
    getStats: () => build,
    loadBundle: async () => {
      await build
      return {
        default: {
          fetch: () => {
            events.push('rendered')
            return new Response('rendered')
          },
        },
      }
    },
  }
}

async function startDevServer(opts: { waitForClientBuild: boolean }) {
  const events: Array<string> = []
  const client = createEnvironment('client', events)
  const ssr = createEnvironment('ssr', events)

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
      environments: { client, ssr },
    },
  } as any)
  ;(afterBuiltIns as () => void)()
  // The second middleware is the SSR catch-all that runs after Rsbuild's
  // built-in middlewares.
  const handleSSR = middlewares[1]!

  let receiveRequest!: () => void
  const received = new Promise<void>((resolve) => {
    receiveRequest = resolve
  })
  server = createServer((req, res) => {
    receiveRequest()
    void handleSSR(req, res, (error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, resolve))
  const { port } = server.address() as AddressInfo

  return {
    events,
    client,
    ssr,
    // Resolves once the middleware has started handling the request.
    request: async () => {
      const response = fetch(`http://localhost:${port}/`).then((res) =>
        res.text(),
      )
      await received
      await flush()
      return { response }
    },
  }
}

describe('createServerSetup', () => {
  test('renders a dev request after the client build in progress', async () => {
    const dev = await startDevServer({ waitForClientBuild: true })
    dev.client.watchRun()

    const { response } = await dev.request()
    dev.client.done()

    expect(await response).toBe('rendered')
    expect(dev.events).toEqual(['client built', 'rendered'])
  })

  test('renders a dev request after a client build that starts while the server builds', async () => {
    const dev = await startDevServer({ waitForClientBuild: true })
    dev.ssr.watchRun()

    const { response } = await dev.request()
    dev.client.watchRun()
    dev.ssr.done()
    await flush()
    dev.client.done()

    expect(await response).toBe('rendered')
    expect(dev.events).toEqual(['ssr built', 'client built', 'rendered'])
  })

  test('does not wait for the client build when the builds are ordered', async () => {
    const dev = await startDevServer({ waitForClientBuild: false })
    dev.client.watchRun()

    const { response } = await dev.request()

    expect(await response).toBe('rendered')
    expect(dev.events).toEqual(['rendered'])
  })
})
