import { createFileRoute } from '@tanstack/react-router'
import { createClientOnlyFn } from '@tanstack/react-start'
import { useState } from 'react'
import { sharedMarker } from '../dev-rebuilds/shared'

// Only the client build includes this module, so only the client compiler
// finds the server functions it imports.
const loadClientOnlyModule = createClientOnlyFn(
  () => import('../dev-rebuilds/client-only'),
)

export const Route = createFileRoute('/dev-rebuilds')({
  component: DevRebuilds,
})

function DevRebuilds() {
  const [result, setResult] = useState('idle')
  const [url, setUrl] = useState('')

  return (
    <main>
      <p data-testid="shared-marker">{sharedMarker}</p>
      <button
        data-testid="invoke"
        onClick={async () => {
          try {
            const { invoke } = await loadClientOnlyModule()
            const next = await invoke()
            setResult(next.result)
            setUrl(next.url)
          } catch (error) {
            setResult(`error: ${String(error)}`)
          }
        }}
      >
        Invoke
      </button>
      <p data-testid="result">{result}</p>
      <p data-testid="url">{url}</p>
    </main>
  )
}
