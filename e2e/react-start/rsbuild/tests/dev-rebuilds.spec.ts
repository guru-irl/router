import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { test } from '@tanstack/router-e2e-utils'
import { expect } from '@playwright/test'
import {
  DevServer,
  captureErrorOverlaySnapshot,
  errorOverlaySelector,
  errorOverlayTimeout,
  fixtureRoot,
} from './dev-server'
import type { Page } from '@playwright/test'

const clientOnlyFile = path.join(fixtureRoot, 'src/dev-rebuilds/client-only.ts')
const sharedFile = path.join(fixtureRoot, 'src/dev-rebuilds/shared.ts')
const addedServerFnFile = path.join(
  fixtureRoot,
  'src/dev-rebuilds/added-server-fn.ts',
)
const syntaxErrorPatch = '\nexport const broken = ;\n'
const rebuildTimeout = 30_000

const addedServerFnSource = `import { createServerFn } from '@tanstack/react-start'

export const addedServerFn = createServerFn().handler(() => 'added-server-fn')
`

const clientOnlyCallingServerFn = `import { addedServerFn } from './added-server-fn'

export async function invoke(): Promise<{ result: string; url: string }> {
  return { result: await addedServerFn(), url: addedServerFn.url }
}
`

test.use({
  whitelistErrors: [
    'Build failed',
    'Module build failed',
    'SyntaxError',
    'Syntax Error',
    'Expression expected',
    'Failed to load resource',
  ],
})

// Each test edits files and waits for several rebuilds.
test.describe.configure({ timeout: 120_000 })

const originalSources = new Map<string, string>()

test.beforeAll(async () => {
  for (const file of [clientOnlyFile, sharedFile]) {
    originalSources.set(file, await fs.promises.readFile(file, 'utf-8'))
  }
})

test.afterEach(async () => {
  for (const [file, source] of originalSources) {
    await fs.promises.writeFile(file, source)
  }
  await fs.promises.rm(addedServerFnFile, { force: true })
})

async function expectInvokeResult(page: Page, url: string, result: string) {
  await expect(async () => {
    await page.goto(url)
    await page.getByTestId('invoke').click()
    await expect(page.getByTestId('result')).toHaveText(result, {
      timeout: 2_000,
    })
  }).toPass({ timeout: rebuildTimeout })
}

// Same-origin, like the client's own server function requests.
async function fetchFromPage(page: Page, url: string) {
  return await page.evaluate(async (serverFnUrl) => {
    const response = await fetch(serverFnUrl, {
      headers: { 'x-tsr-serverFn': 'true' },
    })
    return { status: response.status, body: await response.text() }
  }, url)
}

async function expectOverlayRuntimes(
  page: Page,
  runtimes: Array<'client' | 'server'>,
) {
  await expect(page.locator(errorOverlaySelector)).toBeAttached({
    timeout: errorOverlayTimeout,
  })
  await expect
    .poll(
      async () =>
        (await captureErrorOverlaySnapshot(page))
          .map((issue) => issue.runtime)
          .sort(),
      { timeout: errorOverlayTimeout },
    )
    .toEqual(runtimes)
}

test('calls a server function added during dev and stops serving it after it is deleted', async ({
  page,
}) => {
  await using devServer = await DevServer.start(0)
  const pageUrl = `${devServer.url}/dev-rebuilds`
  await expectInvokeResult(page, pageUrl, 'no-server-fn')

  // Only the client build reaches this server function.
  await fs.promises.writeFile(addedServerFnFile, addedServerFnSource)
  await fs.promises.writeFile(clientOnlyFile, clientOnlyCallingServerFn)
  await expectInvokeResult(page, pageUrl, 'added-server-fn')

  const serverFnUrl = (await page.getByTestId('url').textContent())!
  const added = await fetchFromPage(page, serverFnUrl)
  expect(added.status).toBe(200)
  expect(added.body).toContain('added-server-fn')

  await fs.promises.writeFile(
    clientOnlyFile,
    originalSources.get(clientOnlyFile)!,
  )
  await fs.promises.rm(addedServerFnFile)
  await expectInvokeResult(page, pageUrl, 'no-server-fn')

  await expect
    .poll(
      async () => {
        const response = await fetchFromPage(page, serverFnUrl)
        return response.status !== 200 &&
          !response.body.includes('added-server-fn')
          ? 'removed'
          : 'still served'
      },
      { timeout: rebuildTimeout },
    )
    .toBe('removed')
  await expect(page.locator(errorOverlaySelector)).toHaveCount(0)
})

test('reports a compile error in a client-only module and recovers', async ({
  page,
}) => {
  await using devServer = await DevServer.start(0)
  const pageUrl = `${devServer.url}/dev-rebuilds`
  await expectInvokeResult(page, pageUrl, 'no-server-fn')

  await fs.promises.writeFile(
    clientOnlyFile,
    `${originalSources.get(clientOnlyFile)}${syntaxErrorPatch}`,
  )
  await expectOverlayRuntimes(page, ['client'])

  const response = await page.request.get(pageUrl, { timeout: 10_000 })
  expect(response.status()).toBe(200)

  await fs.promises.writeFile(
    clientOnlyFile,
    originalSources.get(clientOnlyFile)!,
  )
  await expectInvokeResult(page, pageUrl, 'no-server-fn')
  await expect(page.locator(errorOverlaySelector)).toHaveCount(0)
})

test('reports a compile error in a module both builds use and recovers', async ({
  page,
}) => {
  await using devServer = await DevServer.start(0)
  const pageUrl = `${devServer.url}/dev-rebuilds`
  await expectInvokeResult(page, pageUrl, 'no-server-fn')

  await fs.promises.writeFile(
    sharedFile,
    `${originalSources.get(sharedFile)}${syntaxErrorPatch}`,
  )
  await expectOverlayRuntimes(page, ['client', 'server'])

  // The request completes even though both builds failed.
  await page.request.get(pageUrl, { timeout: 10_000 })

  await fs.promises.writeFile(sharedFile, originalSources.get(sharedFile)!)
  await expect(async () => {
    await page.goto(pageUrl)
    await expect(page.getByTestId('shared-marker')).toHaveText(
      'shared-baseline',
      { timeout: 2_000 },
    )
  }).toPass({ timeout: rebuildTimeout })
  await expect(page.locator(errorOverlaySelector)).toHaveCount(0)
})

test('exits on SIGTERM during the first build', async () => {
  const devProcess = spawn(
    path.join(fixtureRoot, 'node_modules/.bin/rsbuild'),
    ['dev', '--port', '0'],
    {
      cwd: fixtureRoot,
      env: { ...process.env, VITE_NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const exited = new Promise<number | null>((resolve) => {
    devProcess.once('exit', (code) => resolve(code))
  })

  try {
    let output = ''
    await new Promise<void>((resolve, reject) => {
      const onData = (data: Buffer) => {
        output += stripVTControlCharacters(data.toString())
        if (output.includes('build started')) {
          resolve()
        }
      }
      devProcess.stdout.on('data', onData)
      devProcess.stderr.on('data', onData)
      exited.then(() => reject(new Error(`Dev server exited:\n${output}`)))
    })
    // The client's first build is still running, so the server build has
    // not started.
    expect(output).not.toContain('built in')

    devProcess.kill('SIGTERM')
    const result = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 15_000),
      ),
    ])
    expect(result).not.toBe('timeout')
  } finally {
    if (devProcess.exitCode === null && devProcess.signalCode === null) {
      devProcess.kill('SIGKILL')
    }
  }
})
