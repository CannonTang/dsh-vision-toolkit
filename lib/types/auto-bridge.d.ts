/**
 * Pasted-image auto bridge: listens for user messages carrying image blocks,
 * analyzes each image through the shared analyzer, and appends a text-only
 * replacement surface event so the text-only model sees descriptions while
 * the original event stays in the durable log.
 * @module dsh-vision-toolkit/auto-bridge
 */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { Context } from 'cordis';
import type { VisionToolkitRuntime } from './runtime.ts';
/** Minimal logging seam the bridge requires; the host logger satisfies it. */
export interface BridgeLogger {
    info?(message?: unknown, ...args: unknown[]): void;
    warn(message?: unknown, ...args: unknown[]): void;
    error?(message?: unknown, ...args: unknown[]): void;
}
/** Dependencies injected by the plugin wiring. */
export interface ImageAutoBridgeDeps {
    /** Cordis context used to subscribe to the session event feed. */
    ctx: Pick<Context, 'on'>;
    /** Provides the vision runtime each per-session analyzer runs against. */
    runtimeSource: () => VisionToolkitRuntime;
    /** Durable attachment store; image bytes are read back through this seam. */
    attachments: AttachmentStore;
    /** Maximum images analyzed per message; later images degrade to a note. */
    maxImages: number;
    /** Host or test logger. */
    logger: BridgeLogger;
}
export declare class ImageAutoBridge {
    #private;
    constructor(deps: ImageAutoBridgeDeps);
    /**
     * Subscribe to the session event feed. The returned disposer unsubscribes
     * and makes any in-flight handle orphan-safe (its append is best effort).
     */
    start(): () => void;
}
//# sourceMappingURL=auto-bridge.d.ts.map