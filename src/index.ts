/**
 * @dsh-external/dsh-vision-toolkit — DSH Vision Toolkit profile bundle.
 *
 * Plugin lifecycle follows the documented readiness chain: verify the pinned
 * upstream checkout, publish the vision-tools Skill and its one-shot bootstrap,
 * then mount the execution tools only in Agents that load that Skill. Any
 * failure leaves no model capability behind, and disposal unregisters every
 * global and Agent-scoped contribution the plugin mounted.
 * @module @dsh-external/dsh-vision-toolkit
 */

import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { ArtifactAccessController, prepareArtifactAccessKey } from './artifact-access.ts'
import { ImageAutoBridge } from './auto-bridge.ts'
import { installImageModalityPatch } from './auto-bridge-modality.ts'
import {
  Config,
  VISION_TOOLKIT_SETTINGS_NAMESPACE,
  resolveConfig,
  type VisionToolkitConfig,
} from './config.ts'
import { VisionToolExposure } from './exposure.ts'
import { VisionToolkitRuntimeManager } from './runtime-manager.ts'
import { VISION_TOOLS_SKILL } from './skill.ts'
import { createVisionTools } from './tools.ts'
import { PLUGIN_VERSION } from './version.ts'
import { installVisionToolkitWeb, VisionToolkitWebBackend } from './web.ts'

export const name = '@dsh-external/dsh-vision-toolkit'

export { Config }

export const inject = ['tools', 'credentials', 'skills', 'subprocess', 'settings', 'agents', 'llm', 'attachments', 'sessions']

/** Plugin entry: validate configuration synchronously, then mount asynchronously. */
export async function apply(ctx: Context, config: VisionToolkitConfig = {}): Promise<() => void> {
  // Registration itself rejects an invalid stored section before any runtime
  // or Tool becomes visible. The custom Web editor preflights runtime changes
  // before persistence; hand-edited settings still fail loud here or retain
  // the last serving generation when changed live.
  const settings = ctx.settings.register(VISION_TOOLKIT_SETTINGS_NAMESPACE, Config, {
    base: config,
    applies: 'live',
    validate: (value) => { resolveConfig(value) },
  })
  const manager = new VisionToolkitRuntimeManager(ctx)
  const artifacts = new ArtifactAccessController(await prepareArtifactAccessKey())
  const lifecycle = new AbortController()
  const disposers: Array<() => void> = []
  let operationalDisposers: { activationTool: () => void; exposure: () => void; skill: () => void } | undefined

  const ensureOperational = (): void => {
    if (!manager.ready || operationalDisposers !== undefined) return
    const exposure = new VisionToolExposure(ctx, () => createVisionTools(
      () => manager.current(),
      value => artifacts.presentationMeta(value),
      lifecycle.signal,
    ))
    let activationTool: (() => void) | undefined
    let exposureDisposer: (() => void) | undefined
    let skill: (() => void) | undefined
    try {
      activationTool = ctx.tools.register(exposure.activationTool)
      skill = ctx.skills.register(VISION_TOOLS_SKILL)
      exposureDisposer = exposure.install()
      operationalDisposers = { activationTool, exposure: exposureDisposer, skill }
      const info = manager.current().upstreamVersion
      ctx.logger.info(
        'dsh-vision-toolkit %s ready (upstream %s @ %s, checkout %s)',
        PLUGIN_VERSION,
        info.version,
        info.commit,
        info.path,
      )
    } catch (error) {
      exposureDisposer?.()
      if (skill !== undefined) skill()
      activationTool?.()
      throw error
    }
  }

  try {
    await manager.initialize(settings.get())
    ensureOperational()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.error(
      'dsh-vision-toolkit %s: runtime not ready; the vision-tools skill, activation bootstrap, and Agent-scoped visual tools are NOT registered. Settings remain available for repair. %s',
      PLUGIN_VERSION,
      message,
    )
  }

  const backend = new VisionToolkitWebBackend(ctx, manager, artifacts, ensureOperational)
  installVisionToolkitWeb(ctx, backend, artifacts)
  // Auto bridge lifecycle: while autoBridge.enabled is true the modality
  // patch and the session listener are live; a Settings flip or plugin
  // disposal removes both, and re-enabling reinstalls them fresh. ctx.llm is
  // resolvable here (the llm service precedes this plugin in the readiness
  // chain), so the instance-level patch applies.
  let stopBridge: (() => void) | undefined
  let restoreModality: (() => void) | undefined
  const applyBridgeState = (): void => {
    const enabled = settings.get().autoBridge?.enabled ?? true
    if (enabled && stopBridge === undefined) {
      try {
        restoreModality = installImageModalityPatch(ctx.llm)
        const bridge = new ImageAutoBridge({
          ctx,
          runtimeSource: () => manager.current(),
          attachments: ctx.attachments,
          maxImages: settings.get().autoBridge?.maxImagesPerMessage ?? 4,
          logger: ctx.logger('vision-toolkit/auto-bridge'),
        })
        stopBridge = bridge.start()
      } catch (error) {
        // A refused patch or bridge start never takes the plugin down.
        stopBridge?.()
        stopBridge = undefined
        restoreModality?.()
        restoreModality = undefined
        ctx.logger.warn('dsh-vision-toolkit: auto-bridge failed to start: %s', error instanceof Error ? error.message : String(error))
      }
    } else if (!enabled && stopBridge !== undefined) {
      stopBridge()
      stopBridge = undefined
      restoreModality?.()
      restoreModality = undefined
    }
  }
  applyBridgeState()
  disposers.push(settings.watch(async (next) => {
    try {
      await manager.reconfigure(next)
      ensureOperational()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.error('dsh-vision-toolkit: keeping the previous runtime after a refused Settings generation. %s', message)
    }
    applyBridgeState()
  }))

  return () => {
    lifecycle.abort()
    if (operationalDisposers !== undefined) {
      operationalDisposers.exposure()
      operationalDisposers.activationTool()
      operationalDisposers.skill()
      operationalDisposers = undefined
    }
    for (const dispose of disposers.reverse()) dispose()
    if (stopBridge !== undefined) {
      stopBridge()
      stopBridge = undefined
    }
    restoreModality?.()
    restoreModality = undefined
  }
}
