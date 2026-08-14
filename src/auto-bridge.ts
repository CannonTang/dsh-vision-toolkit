/**
 * Pasted-image auto bridge: listens for user messages carrying image blocks,
 * analyzes each image through the shared analyzer, and appends a text-only
 * replacement surface event so the text-only model sees descriptions while
 * the original event stays in the durable log.
 * @module dsh-vision-toolkit/auto-bridge
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttachmentStore, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { MessageId, type ImageBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from 'cordis'
import { ImageAnalyzer } from './auto-bridge-analyze.ts'
import type { VisionToolkitRuntime } from './runtime.ts'

const BRIDGE_PREFIX = '[图片自动分析]'
/** Subdirectory of the plugin-managed artifact tree that owns bridge saves. */
const BRIDGE_ARTIFACT_DIR = 'bridge'
const EXTENSION_BY_MEDIA_TYPE = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])

/** Minimal logging seam the bridge requires; the host logger satisfies it. */
export interface BridgeLogger {
  info?(message?: unknown, ...args: unknown[]): void
  warn(message?: unknown, ...args: unknown[]): void
  error?(message?: unknown, ...args: unknown[]): void
}

/** Dependencies injected by the plugin wiring. */
export interface ImageAutoBridgeDeps {
  /** Cordis context used to subscribe to the session event feed. */
  ctx: Pick<Context, 'on'>
  /** Provides the vision runtime each per-session analyzer runs against. */
  runtimeSource: () => VisionToolkitRuntime
  /** Durable attachment store; image bytes are read back through this seam. */
  attachments: AttachmentStore
  /** Maximum images analyzed per message; later images degrade to a note. */
  maxImages: number
  /** Host or test logger. */
  logger: BridgeLogger
}

export class ImageAutoBridge {
  #ctx: Pick<Context, 'on'>
  #runtimeSource: () => VisionToolkitRuntime
  #attachments: AttachmentStore
  #maxImages: number
  #logger: BridgeLogger

  constructor(deps: ImageAutoBridgeDeps) {
    this.#ctx = deps.ctx
    this.#runtimeSource = deps.runtimeSource
    this.#attachments = deps.attachments
    this.#maxImages = deps.maxImages
    this.#logger = deps.logger
  }

  /**
   * Subscribe to the session event feed. The returned disposer unsubscribes
   * and makes any in-flight handle orphan-safe (its append is best effort).
   */
  start(): () => void {
    return this.#ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const imageBlocks = event.data.content.filter((block) => block.type === 'image')
      if (imageBlocks.length === 0) return
      void this.#handle(session, event, imageBlocks)
    })
  }

  /**
   * Read each image block from the attachment store, persist it inside the
   * session's managed artifact tree, analyze it through a fresh analyzer bound
   * to that session's workspace, and append one text-only replacement surface
   * event so the text-only model sees descriptions while the original event
   * stays in the durable log.
   */
  async #handle(session: Session, event: SessionEvent<'user/message'>, imageBlocks: ImageBlock[]): Promise<void> {
    const notes: string[] = []
    const limited = imageBlocks.length > this.#maxImages
    // The session workspace is only known per message, so the analyzer is
    // built here: relative allowedDirs entries then resolve against the real
    // session workspace exactly like the manual tools (ImageAnalyzer#workspace).
    const options = session.header.cwd === undefined ? {} : { workspace: session.header.cwd }
    const analyzer = new ImageAnalyzer(this.#runtimeSource, options)
    let index = 0
    for (const block of imageBlocks.slice(0, this.#maxImages)) {
      try {
        const stored = await this.#attachments.readImage(block.attachment)
        const savedPath = await this.#writeManagedImage(session, stored, index)
        const outcome = await analyzer.analyze(stored.data, stored.ref.mediaType, stored.ref.name)
        notes.push(outcome.ok
          ? `${BRIDGE_PREFIX} ${outcome.answer}\n图片已保存:${savedPath},可用视觉工具深入分析`
          : `${BRIDGE_PREFIX}失败(${outcome.reason})\n图片已保存:${savedPath}`)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        notes.push(`${BRIDGE_PREFIX}读取失败(${reason})`)
      }
      index += 1
    }
    if (limited) notes.push(`${BRIDGE_PREFIX}本条消息共 ${imageBlocks.length} 张图片,仅分析前 ${this.#maxImages} 张`)
    const replacement: UserMessage = {
      id: MessageId(`${event.data.id}-bridge`),
      role: 'user',
      source: event.data.source,
      content: [
        ...event.data.content.filter((block) => block.type !== 'image'),
        ...notes.map((text) => ({ type: 'text' as const, text })),
      ],
    }
    try {
      session.append('user/message', replacement, {
        surfaceOp: { op: 'replace', start: event.seq, end: event.seq },
        sourceEventSeqs: [event.seq],
      })
    } catch (error) {
      this.#logger.warn('auto-bridge: replacement append failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  /** Persist one image inside the session's managed artifact tree. */
  async #writeManagedImage(session: Session, stored: StoredImageAttachment, index: number): Promise<string> {
    const root = this.#artifactRootFor(session)
    await mkdir(root, { recursive: true })
    const file = join(root, this.#artifactFilenameFor(stored.ref, index))
    await writeFile(file, stored.data)
    return file
  }

  /**
   * The plugin-managed artifact tree for one session's bridge saves:
   * `<workspace>/.dsh-vision-toolkit/artifacts/bridge` — the same default
   * output layout the manual tools use and the artifact access route serves.
   */
  #artifactRootFor(session: Session): string {
    const cwd = session.header.cwd
    if (cwd === undefined) throw new Error('session has no working directory for bridge artifacts')
    return join(cwd, '.dsh-vision-toolkit', 'artifacts', BRIDGE_ARTIFACT_DIR)
  }

  /** One stable, extension-typed filename per image; the index keeps blocks distinct. */
  #artifactFilenameFor(ref: ImageAttachmentRef, index: number): string {
    const safe = ref.attachmentId.replace(/[^A-Za-z0-9._-]/g, '_')
    const stem = safe.length === 0 ? 'image' : safe
    return `${stem}-${index}${EXTENSION_BY_MEDIA_TYPE.get(ref.mediaType) ?? '.bin'}`
  }
}
