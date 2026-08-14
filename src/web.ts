/**
 * Optional Web-profile routes: signed Artifact delivery plus a same-origin
 * Settings/health endpoint. The browser never receives credential values and
 * connection tests run only after an explicit POST action.
 * @module dsh-vision-toolkit/web
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ArtifactAccessController, ARTIFACT_ROUTE_PREFIX } from './artifact-access.ts'
import {
  resolveConfig,
  VISION_TOOLKIT_SETTINGS_NAMESPACE,
  type ResolvedVisionToolkitConfig,
  type VisionToolkitConfig,
} from './config.ts'
import type { VisionToolkitHealthResult } from './runtime.ts'
import {
  VisionToolkitRuntimeManager,
  type PreparedRuntimeGeneration,
  type RuntimeManagerStatus,
} from './runtime-manager.ts'
import { PLUGIN_VERSION, UPSTREAM_COMMIT, UPSTREAM_REPOSITORY, UPSTREAM_VERSION } from './version.ts'

/** Exact route used by the browser Settings page. */
export const SETTINGS_ROUTE = '/_dsh/vision-toolkit/settings'

/** Same-origin credential write route: store or remove one reference's value. */
export const CREDENTIAL_ROUTE = '/_dsh/vision-toolkit/credential'

/** Public Settings snapshot; credential values are deliberately impossible here. */
export interface VisionToolkitSettingsSnapshot {
  schemaVersion: 1
  writable: boolean
  settings: {
    /** Stored configuration with `provider.apiKey` removed. */
    value: VisionToolkitConfig
    user?: unknown
    base?: unknown
    revision: number
    applies: 'live'
  }
  credential: {
    ref: string
    configured: boolean
    source?: string
    writable: boolean
  }
  /** Whether a direct `provider.apiKey` is stored (never the value itself). */
  apiKeyConfigured: boolean
  runtime: RuntimeManagerStatus
  release: {
    pluginVersion: string
    upstreamRepository: string
    upstreamVersion: string
    upstreamCommit: string
  }
  artifactRouteAvailable: boolean
}

interface CredentialWriteRequest {
  ref: string
  value: string
}

interface SaveRequest {
  action: 'save'
  expectedRevision: number
  value: VisionToolkitConfig
}

interface HealthRequest {
  action: 'health'
  testConnection: boolean
}

type SettingsRequest = SaveRequest | HealthRequest

interface JsonError {
  ok: false
  error: { code: string; message: string }
}

interface JsonSuccess<T> {
  ok: true
  value: T
}

type JsonResponse<T> = JsonSuccess<T> | JsonError

/** Minimal runtime-manager face used by the Web route and its tests. */
export interface WebRuntimeManager {
  readonly ready: boolean
  current(): ReturnType<VisionToolkitRuntimeManager['current']>
  prepareCandidate(raw: VisionToolkitConfig): Promise<PreparedRuntimeGeneration>
  activateCandidate(candidate: PreparedRuntimeGeneration): void
  recordFailure(error: unknown): void
  status(): RuntimeManagerStatus
}

/** Callback invoked when a Settings save makes the first runtime available. */
export type RuntimeActivated = () => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function descriptorOf(ctx: Context): SettingsDescriptor {
  const descriptor = ctx.settings.describe().find(row => row.ns === VISION_TOOLKIT_SETTINGS_NAMESPACE)
  if (descriptor === undefined) throw new Error('vision-toolkit Settings namespace is not registered')
  return descriptor
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  res.writeHead(status)
  res.end(bytes)
}

function responseJson<T>(res: ServerResponse, status: number, body: JsonResponse<T>): void {
  writeJson(res, status, body)
}

/** Credential write responses never carry the submitted value. */
type CredentialWriteResponse = { ok: true } | { ok: false; error: string }

function credentialWriteJson(res: ServerResponse, status: number, body: CredentialWriteResponse): void {
  writeJson(res, status, body)
}

function requestError(res: ServerResponse, status: number, code: string, message: string): void {
  responseJson(res, status, { ok: false, error: { code, message } })
}

function sameOriginPost(req: IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none'
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`)
    chunks.push(part)
  }
  if (chunks.length === 0) throw new TypeError('request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function parseCredentialWrite(value: unknown): CredentialWriteRequest {
  if (!isRecord(value) || typeof value.ref !== 'string' || value.ref.trim().length === 0) {
    throw new TypeError('request ref is required')
  }
  if (value.value !== undefined && typeof value.value !== 'string') {
    throw new TypeError('request value must be a string')
  }
  return { ref: value.ref, value: typeof value.value === 'string' ? value.value : '' }
}

function parseRequest(value: unknown): SettingsRequest {
  if (!isRecord(value) || typeof value.action !== 'string') throw new TypeError('request action is required')
  if (value.action === 'health') {
    if (typeof value.testConnection !== 'boolean') throw new TypeError('health.testConnection must be boolean')
    return { action: 'health', testConnection: value.testConnection }
  }
  if (value.action === 'save') {
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
      throw new TypeError('save.expectedRevision must be a non-negative integer')
    }
    if (!isRecord(value.value)) throw new TypeError('save.value must be an object')
    return {
      action: 'save',
      expectedRevision: value.expectedRevision as number,
      value: value.value as VisionToolkitConfig,
    }
  }
  throw new TypeError(`unsupported action: ${value.action}`)
}

function publicMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Strip `provider.apiKey` (and its stored value) from any snapshot payload.
 * Applied to the resolved value and the detached user/base layers: the key
 * must never reach the browser, only its configured-ness.
 */
function redactProviderApiKey(value: unknown): unknown {
  if (!isRecord(value)) return value
  const provider = value.provider
  if (!isRecord(provider) || typeof provider.apiKey !== 'string') return value
  const redactedProvider = { ...provider }
  delete redactedProvider.apiKey
  return { ...value, provider: redactedProvider }
}

/** The runtime status carries the active resolved config — redact its key too. */
function redactRuntimeStatus(status: RuntimeManagerStatus): RuntimeManagerStatus {
  if (status.activeConfig === undefined) return status
  return { ...status, activeConfig: redactProviderApiKey(status.activeConfig) as ResolvedVisionToolkitConfig }
}

/** Same-origin Settings and health handler. */
export class VisionToolkitWebBackend {
  constructor(
    private readonly ctx: Context,
    private readonly manager: WebRuntimeManager,
    private readonly artifacts: ArtifactAccessController,
    private readonly onRuntimeActivated: RuntimeActivated,
  ) {}

  private async credential(config: ResolvedVisionToolkitConfig): Promise<CredentialInfo> {
    return this.ctx.credentials.describe(credentialRef(String(config.provider.credential)))
  }

  /** Build the current settings/runtime/credential snapshot without secrets. */
  async snapshot(): Promise<VisionToolkitSettingsSnapshot> {
    const descriptor = descriptorOf(this.ctx)
    const value = descriptor.value as VisionToolkitConfig
    const resolved = resolveConfig(value)
    const credential = await this.credential(resolved)
    const directApiKey = value.provider?.apiKey
    const apiKeyConfigured = typeof directApiKey === 'string' && directApiKey.trim().length > 0
    return {
      schemaVersion: 1,
      writable: this.ctx.settings.writable,
      settings: {
        value: redactProviderApiKey(value) as VisionToolkitConfig,
        ...(descriptor.user === undefined ? {} : { user: redactProviderApiKey(descriptor.user) }),
        ...(descriptor.base === undefined ? {} : { base: redactProviderApiKey(descriptor.base) }),
        revision: descriptor.revision,
        applies: 'live',
      },
      credential: {
        ref: String(resolved.provider.credential),
        configured: credential.configured,
        ...(credential.source === undefined ? {} : { source: credential.source }),
        writable: credential.writable,
      },
      apiKeyConfigured,
      runtime: redactRuntimeStatus(this.manager.status()),
      release: {
        pluginVersion: PLUGIN_VERSION,
        upstreamRepository: UPSTREAM_REPOSITORY,
        upstreamVersion: UPSTREAM_VERSION,
        upstreamCommit: UPSTREAM_COMMIT,
      },
      artifactRouteAvailable: this.artifacts.routeAvailable,
    }
  }

  /**
   * Carry `provider.apiKey` through a save: a trimmed non-empty value is
   * stored; an absent or empty one leaves the currently stored key in place
   * (the UI never sees the stored value, so an empty input must not erase
   * it). The key itself is never echoed back in responses or errors.
   */
  private carryApiKey(incoming: VisionToolkitConfig): VisionToolkitConfig {
    const incomingKey = incoming.provider?.apiKey?.trim()
    if (incomingKey !== undefined && incomingKey.length > 0) {
      return { ...incoming, provider: { ...incoming.provider, apiKey: incomingKey } }
    }
    const existing = descriptorOf(this.ctx).value as VisionToolkitConfig | undefined
    const existingKey = existing?.provider?.apiKey
    if (existingKey === undefined) return incoming
    return { ...incoming, provider: { ...(incoming.provider ?? {}), apiKey: existingKey } }
  }

  private async save(request: SaveRequest): Promise<VisionToolkitSettingsSnapshot> {
    if (!this.ctx.settings.writable) throw new Error('settings provider is read-only')
    const value = this.carryApiKey(request.value)
    let candidate: PreparedRuntimeGeneration
    try {
      candidate = await this.manager.prepareCandidate(value)
    } catch (error) {
      this.manager.recordFailure(error)
      throw error
    }
    await this.ctx.settings.replace(
      VISION_TOOLKIT_SETTINGS_NAMESPACE,
      value as object,
      request.expectedRevision,
    )
    this.manager.activateCandidate(candidate)
    this.onRuntimeActivated()
    return this.snapshot()
  }

  private async health(request: HealthRequest, req: IncomingMessage): Promise<VisionToolkitHealthResult> {
    if (!this.manager.ready) throw new Error('runtime is not ready; fix Settings and save a valid configuration first')
    const controller = new AbortController()
    const abort = (): void => { controller.abort() }
    req.once('aborted', abort)
    req.socket.once('close', abort)
    try {
      return await this.manager.current().health(request.testConnection, {
        signal: controller.signal,
        workspace: process.cwd(),
        sessionId: 'vision-toolkit-settings',
      })
    } finally {
      req.off('aborted', abort)
      req.socket.off('close', abort)
    }
  }

  /**
   * Store (`value` non-empty) or remove (empty) one credential value. The
   * submitted value never leaves the credential store into logs, errors, or
   * responses: every failure returns a fixed redacted message.
   */
  async handleCredential(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      credentialWriteJson(res, 405, { ok: false, error: 'Use POST' })
      return
    }
    if (!sameOriginPost(req)) {
      credentialWriteJson(res, 403, { ok: false, error: 'The request must originate from this DSH Web application' })
      return
    }
    let request: CredentialWriteRequest
    try {
      request = parseCredentialWrite(await readJson(req))
    } catch (error) {
      credentialWriteJson(
        res,
        error instanceof RangeError ? 413 : 400,
        { ok: false, error: 'request body must be a JSON object with a credential reference and an optional value' },
      )
      return
    }
    let ref: CredentialRef
    try {
      ref = credentialRef(request.ref.trim())
    } catch {
      // The submitted ref may itself be a pasted secret; never echo it.
      credentialWriteJson(res, 400, {
        ok: false,
        error: 'the credential reference is invalid; use an environment-style name such as VISION_API_KEY',
      })
      return
    }
    try {
      if (request.value.length === 0) {
        await this.ctx.credentials.unset(ref)
      } else {
        await this.ctx.credentials.set(ref, request.value)
      }
      credentialWriteJson(res, 200, { ok: true })
    } catch {
      // Never surface the provider error or the value in logs or responses.
      this.ctx.logger.warn('dsh-vision-toolkit credential write failed for ref "%s"', String(ref))
      credentialWriteJson(res, 400, {
        ok: false,
        error: 'the credential could not be saved; the credential store may be read-only or unavailable',
      })
      return
    }
  }

  /** Handle the exact Settings route. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      try {
        responseJson(res, 200, { ok: true, value: await this.snapshot() })
      } catch (error) {
        this.ctx.logger.warn('dsh-vision-toolkit Settings snapshot failed: %s', publicMessage(error))
        requestError(res, 503, 'settings-unavailable', 'Vision Toolkit Settings are unavailable')
      }
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      requestError(res, 405, 'method-not-allowed', 'Use GET or POST')
      return
    }
    if (!sameOriginPost(req)) {
      requestError(res, 403, 'origin-rejected', 'The request must originate from this DSH Web application')
      return
    }
    let parsed: SettingsRequest
    try {
      parsed = parseRequest(await readJson(req))
    } catch (error) {
      requestError(res, error instanceof RangeError ? 413 : 400, 'invalid-request', publicMessage(error))
      return
    }
    try {
      if (parsed.action === 'health') {
        responseJson(res, 200, { ok: true, value: await this.health(parsed, req) })
      } else {
        responseJson(res, 200, { ok: true, value: await this.save(parsed) })
      }
    } catch (error) {
      const conflict = error instanceof SettingsConflictError
      const code = conflict ? 'settings-conflict' : parsed.action === 'health' ? 'health-failed' : 'settings-rejected'
      const status = conflict ? 409 : parsed.action === 'health' ? 503 : 400
      this.ctx.logger.warn('dsh-vision-toolkit Web action=%s failed: %s', parsed.action, publicMessage(error))
      requestError(res, status, code, publicMessage(error))
    }
  }
}

/**
 * Attach optional Web routes whenever an webServer service is present.
 * @param ctx - plugin context owning route effects.
 * @param backend - Settings handler.
 * @param artifacts - signed Artifact handler.
 */
export function installVisionToolkitWeb(
  ctx: Context,
  backend: VisionToolkitWebBackend,
  artifacts: ArtifactAccessController,
): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const detach = artifacts.attachRoute()
      const disposeArtifact = webCtx.webServer.register({
        kind: 'prefix',
        path: ARTIFACT_ROUTE_PREFIX,
        handler: (req, res) => artifacts.handle(req, res),
      })
      const disposeSettings = webCtx.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: (req, res) => backend.handle(req, res),
      })
      const disposeCredential = webCtx.webServer.register({
        kind: 'exact',
        path: CREDENTIAL_ROUTE,
        handler: (req, res) => backend.handleCredential(req, res),
      })
      return () => {
        disposeCredential()
        disposeSettings()
        disposeArtifact()
        detach()
      }
    }, 'dsh-vision-toolkit: Web routes')
  })
}
