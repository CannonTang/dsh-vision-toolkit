/**
 * Attachment-byte image analysis for the auto bridge: temp-file staging around
 * the existing runtime glance path so pasted images reuse the exact same
 * vision-provider call as the manual tools.
 * @module dsh-vision-toolkit/auto-bridge-analyze
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisionToolkitRuntime } from './runtime.ts'

const EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])

/** Result of one attachment analysis: the glance answer, or a degradation reason. */
export type AnalyzeOutcome = { ok: true; answer: string } | { ok: false; reason: string }

/**
 * Shared attachment-byte image analyzer: stages incoming bytes in a temp
 * directory, then calls the runtime glance path with the staged file so the
 * auto bridge and the manual tools hit the exact same vision-provider call.
 */
export class ImageAnalyzer {
  #runtimeSource: () => VisionToolkitRuntime
  #language: 'zh' | 'en'

  constructor(runtimeSource: () => VisionToolkitRuntime, options: { language?: 'zh' | 'en' } = {}) {
    this.#runtimeSource = runtimeSource
    this.#language = options.language ?? 'zh'
  }

  /** Vision output language this analyzer was configured with. */
  get language(): 'zh' | 'en' {
    return this.#language
  }

  /**
   * Analyze attachment bytes as one image. Writes `bytes` to a fresh temp
   * file, reuses runtime glance with no query (plain description mode), and
   * removes the temp directory before returning.
   *
   * The `name` attachment hint is accepted for forward compatibility but not
   * passed to glance yet.
   */
  async analyze(
    bytes: Uint8Array,
    mediaType: string,
    name: string | undefined,
    signal?: AbortSignal,
  ): Promise<AnalyzeOutcome> {
    void name
    const dir = await mkdtemp(join(tmpdir(), 'dvt-bridge-'))
    const file = join(dir, `image${EXTENSIONS.get(mediaType) ?? '.png'}`)
    try {
      await writeFile(file, bytes)
      const runtime = this.#runtimeSource()
      const result = await runtime.glance({ images: [file] }, {
        signal: signal ?? new AbortController().signal,
        workspace: dir,
      })
      return { ok: true, answer: String(result.answer ?? '') }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
