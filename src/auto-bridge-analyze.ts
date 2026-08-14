/**
 * Attachment-byte image analysis for the auto bridge: temp-file staging around
 * the existing runtime glance path so pasted images reuse the exact same
 * vision-provider call as the manual tools.
 * @module dsh-vision-toolkit/auto-bridge-analyze
 */
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
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
  #workspace: string | undefined

  constructor(
    runtimeSource: () => VisionToolkitRuntime,
    options: { language?: 'zh' | 'en'; workspace?: string } = {},
  ) {
    this.#runtimeSource = runtimeSource
    this.#language = options.language ?? 'zh'
    this.#workspace = options.workspace
  }

  /** Vision output language this analyzer was configured with. */
  get language(): 'zh' | 'en' {
    return this.#language
  }

  /** Real session workspace temp files are staged in; glance runs against it. */
  get workspace(): string | undefined {
    return this.#workspace
  }

  /**
   * Analyze attachment bytes as one image. Writes `bytes` to a fresh temp
   * file, reuses runtime glance with no query (plain description mode), and
   * removes the temp directory before returning.
   *
   * With a configured workspace the file is staged inside
   * `<workspace>/.dvt-bridge-tmp/` and glance gets that real workspace, so
   * relative allowedDirs entries resolve against it exactly like the manual
   * tools. Without one the system temp dir is used and doubles as workspace.
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
    const base = this.#workspace !== undefined ? join(this.#workspace, '.dvt-bridge-tmp') : tmpdir()
    if (this.#workspace !== undefined) await mkdir(base, { recursive: true })
    const dir = await mkdtemp(join(base, 'dvt-bridge-'))
    const file = join(dir, `image${EXTENSIONS.get(mediaType) ?? '.png'}`)
    try {
      await writeFile(file, bytes)
      const runtime = this.#runtimeSource()
      const result = await runtime.glance({ images: [file] }, {
        signal: signal ?? new AbortController().signal,
        workspace: this.#workspace ?? dir,
      })
      return { ok: true, answer: String(result.answer ?? '') }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      if (this.#workspace !== undefined) {
        // Remove the staging root too once it is empty (never recursively, so
        // a concurrent analyze's in-flight temp dir is not touched).
        await rmdir(base).catch(() => {})
      }
    }
  }
}
