import fs from 'node:fs'
import path from 'node:path'
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
import type { ErrorOverlayIssue } from './dev-server'

const syntaxErrorRoutePatch = '\nexport const broken = ;\n'

function formatErrorOverlaySnapshot(
  snapshot: Array<ErrorOverlayIssue>,
): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

function dedentSnapshot(snapshot: string): string {
  const lines = snapshot
    .replace(/^\n/, '')
    .replace(/\n\s*$/, '')
    .split('\n')
  const indent = Math.min(
    ...lines
      .filter((line) => line.trim() !== '')
      .map((line) => line.match(/^ */)?.[0].length ?? 0),
  )

  return `${lines.map((line) => line.slice(indent)).join('\n')}\n`
}

async function toDisplayRedbox(
  page: Page,
  expectedSnapshot: string,
): Promise<void> {
  await expect(page.locator(errorOverlaySelector)).toBeAttached({
    timeout: errorOverlayTimeout,
  })

  const normalizedExpectedSnapshot = dedentSnapshot(expectedSnapshot)

  await expect
    .poll(
      async () => {
        return formatErrorOverlaySnapshot(
          await captureErrorOverlaySnapshot(page),
        )
      },
      { timeout: errorOverlayTimeout },
    )
    .toBe(normalizedExpectedSnapshot)
}

test.use({
  whitelistErrors: [
    'Build failed',
    'Module build failed',
    'SyntaxError',
    'Syntax Error',
    'Expression expected',
  ],
})

test('shows a module syntax error through the error overlay', async ({
  page,
}) => {
  const homeRouteFile = path.resolve(fixtureRoot, 'src/routes/index.tsx')
  const originalSource = await fs.promises.readFile(homeRouteFile, 'utf-8')
  const port = 0
  await using devServer = await DevServer.start(port)

  try {
    await page.goto(devServer.url, { waitUntil: 'domcontentloaded' })

    await fs.promises.writeFile(
      homeRouteFile,
      `${originalSource}${syntaxErrorRoutePatch}`,
    )

    await toDisplayRedbox(
      page,
      `
      [
        {
          "title": "Build failed",
          "description": "SyntaxError: Unexpected token (16:22)",
          "runtime": "client",
          "sourceFrame": "File: ./src/routes/index.tsx:1:1\\nx Module build failed (from <rsbuild-transform-loader>):\\n->   x SyntaxError: Unexpected token (16:22)",
          "importTrace": [
            "../../../packages/react-start/dist/plugin/default-entry/client.tsx",
            "../../../packages/react-start/dist/esm/client.js",
            "... (5 hidden)",
            "./src/routeTree.gen.ts",
            "./src/routes/index.tsx x"
          ]
        },
        {
          "title": "Build failed",
          "description": "SyntaxError: Unexpected token (16:22)",
          "runtime": "server",
          "sourceFrame": "File: ./src/routes/index.tsx:1:1\\nx Module build failed (from <rsbuild-transform-loader>):\\n->   x SyntaxError: Unexpected token (16:22)",
          "importTrace": [
            "../../../packages/react-start/dist/plugin/default-entry/server.ts",
            "../../../packages/react-start/dist/esm/server.js",
            "... (4 hidden)",
            "./src/routeTree.gen.ts",
            "./src/routes/index.tsx x"
          ]
        }
      ]
    `,
    )
  } finally {
    await fs.promises.writeFile(homeRouteFile, originalSource)
  }
})
