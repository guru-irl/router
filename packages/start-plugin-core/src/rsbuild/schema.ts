import { z } from 'zod'
import {
  parseStartConfig as parseCoreStartConfig,
  tanstackStartOptionsObjectSchema,
} from '../schema'
import type { CompileStartFrameworkOptions } from '../types'
import type { InlineCssInputOptions } from '../schema'

export const rsbuildClientOutputSchema = z.enum(['module', 'iife'])

export const tanstackStartRsbuildOptionsSchema =
  tanstackStartOptionsObjectSchema
    .extend({
      rsbuild: z
        .object({
          installDevServerMiddleware: z.boolean().optional(),
          concurrentDevRebuilds: z.boolean().optional(),
          client: z
            .object({
              output: rsbuildClientOutputSchema.optional().default('module'),
            })
            .optional()
            .prefault({}),
        })
        .optional(),
    })
    .optional()
    .prefault({})

export function parseStartConfig(
  opts: z.input<typeof tanstackStartRsbuildOptionsSchema>,
  corePluginOpts: { framework: CompileStartFrameworkOptions },
  root: string,
) {
  tanstackStartRsbuildOptionsSchema.parse(opts)
  const { rsbuild: _rsbuild, ...coreOptions } = opts ?? {}

  return parseCoreStartConfig(coreOptions, corePluginOpts, root)
}

export type TanStackStartRsbuildInputConfig = z.input<
  typeof tanstackStartRsbuildOptionsSchema
> & {
  rsbuild?: {
    installDevServerMiddleware?: boolean
    /**
     * In development, rebuild the server environment at the same time as the
     * client environment instead of after it. The first build still runs the
     * server after the client.
     *
     * The client build updates the manifest that server rendering reads, and
     * the server build can finish first. So the built-in dev middleware waits
     * for the server build and then for the client build before it renders.
     * With `installDevServerMiddleware: false`, a custom dev server should do
     * the same before each request: await `environments.ssr.getStats()`, then
     * `environments.client.getStats()`, then call
     * `environments.ssr.loadBundle()`. If the client build fails with a fatal
     * error rather than a module error, Rspack stops watching the client, so
     * requests wait until you restart the dev server.
     *
     * @default true
     */
    concurrentDevRebuilds?: boolean
    client?: {
      output?: z.input<typeof rsbuildClientOutputSchema>
    }
  }
  server?: {
    build?: {
      inlineCss?: InlineCssInputOptions
    }
  }
}
