import { createServer, type Server } from 'node:http'
import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { ArtifactAccessController } from '../src/artifact-access.ts'
import type { VisionToolkitRuntime } from '../src/runtime.ts'
import { VisionToolkitWebBackend, type WebRuntimeManager } from '../src/web.ts'

const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function stubManager(): WebRuntimeManager {
  const runtime = { health: async () => { throw new Error('unused') } } as unknown as VisionToolkitRuntime
  return {
    ready: true,
    current: () => runtime,
    prepareCandidate: async () => { throw new Error('unused') },
    activateCandidate: () => {},
    recordFailure: () => {},
    status: () => ({ ready: true, generation: 1 }),
  }
}

async function setup(failure?: 'set' | 'unset') {
  const ctx = new Context()
  contexts.push(ctx)
  const setCalls: Array<{ ref: string; value: string }> = []
  const unsetCalls: string[] = []
  const credentials = {
    resolve: vi.fn(async () => ({ value: 'never-exposed-secret', source: 'file' })),
    describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true })),
    set: vi.fn(async (ref: string, value: string) => {
      if (failure === 'set') throw new Error('credential store is read-only')
      setCalls.push({ ref, value })
    }),
    unset: vi.fn(async (ref: string) => {
      if (failure === 'unset') throw new Error('credential store is read-only')
      unsetCalls.push(ref)
    }),
  }
  ctx.provide('credentials', credentials as unknown as CredentialProvider)
  const backend = new VisionToolkitWebBackend(ctx, stubManager(), new ArtifactAccessController(Buffer.alloc(32, 7)), () => {})
  const server = createServer((req, res) => { void backend.handleCredential(req, res) })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}`
  const post = (body: unknown) => fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify(body),
  })
  return { base, post, setCalls, unsetCalls }
}

describe('credential write route', () => {
  it('stores a non-empty value and reports ok without echoing it', async () => {
    const { post, setCalls, unsetCalls } = await setup()
    const secret = 'sk-supersecret-value'
    const response = await post({ ref: 'MY_VISION_KEY', value: secret })
    const body = await response.json() as { ok: boolean }
    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(setCalls).toEqual([{ ref: 'MY_VISION_KEY', value: secret }])
    expect(unsetCalls).toEqual([])
  })

  it('removes the value when the payload value is empty', async () => {
    const { post, setCalls, unsetCalls } = await setup()
    const response = await post({ ref: 'MY_VISION_KEY', value: '' })
    const body = await response.json() as { ok: boolean }
    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(setCalls).toEqual([])
    expect(unsetCalls).toEqual(['MY_VISION_KEY'])
  })

  it('rejects an invalid ref with a redacted message', async () => {
    const { post, setCalls, unsetCalls } = await setup()
    const leakedRef = 'sk-leaked-ref-value'
    const response = await post({ ref: leakedRef, value: 'anything' })
    const body = await response.json() as { ok: false; error: string }
    expect(response.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).not.toContain(leakedRef)
    expect(body.error).not.toContain('anything')
    expect(body.error).toMatch(/credential reference is invalid/)
    expect(JSON.stringify(body)).not.toContain('anything')
    expect(setCalls).toEqual([])
    expect(unsetCalls).toEqual([])
  })

  it('rejects a malformed body with a redacted message', async () => {
    const { post } = await setup()
    const response = await post({ value: 'sk-body-value' })
    const body = await response.json() as { ok: false; error: string }
    expect(response.status).toBe(400)
    expect(body.error).not.toContain('sk-body-value')
    expect(JSON.stringify(body)).not.toContain('sk-body-value')
  })

  it('redacts provider failures so the value never reaches the response', async () => {
    const { post } = await setup('set')
    const secret = 'sk-rejected-value'
    const response = await post({ ref: 'MY_VISION_KEY', value: secret })
    const body = await response.json() as { ok: false; error: string }
    expect(response.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).not.toContain(secret)
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(body.error).toMatch(/could not be saved/)
  })

  it('redacts provider failures for unset as well', async () => {
    const { post } = await setup('unset')
    const response = await post({ ref: 'MY_VISION_KEY', value: '' })
    const body = await response.json() as { ok: false; error: string }
    expect(response.status).toBe(400)
    expect(JSON.stringify(body)).not.toContain('MY_VISION_KEY-value')
    expect(body.error).toMatch(/could not be saved/)
  })

  it('rejects cross-site writes before touching the credential store', async () => {
    const { base, setCalls, unsetCalls } = await setup()
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
      body: JSON.stringify({ ref: 'MY_VISION_KEY', value: 'sk-cross-site' }),
    })
    const body = await response.json() as { ok: false; error: string }
    expect(response.status).toBe(403)
    expect(JSON.stringify(body)).not.toContain('sk-cross-site')
    expect(setCalls).toEqual([])
    expect(unsetCalls).toEqual([])
  })

  it('answers non-POST methods with 405', async () => {
    const { base } = await setup()
    const response = await fetch(base, {
      method: 'GET',
      headers: { Origin: base },
    })
    expect(response.status).toBe(405)
  })
})
