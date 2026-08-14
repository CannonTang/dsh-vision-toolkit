/**
 * Pasted-image auto bridge: wraps each live session's append so a user message
 * carrying image blocks gets a synchronous text-only placeholder event, then
 * analyzes every image through the shared analyzer and replaces the placeholder
 * with the real descriptions while the original event stays in the durable log.
 * A `tool/result` whose message carries image blocks (the host `read_image`
 * tool, admitted by the modality patch, returns such blocks) gets the same
 * synchronous treatment: one text-only replacement event lands before the loop
 * derives model history, keeping the invariant that the model never sees image
 * blocks.
 *
 * The host appends `user/message` and derives the first LLM request in one
 * synchronous block (and the DeepSeek adapter rejects image blocks outright),
 * so the text-only replacement must land synchronously, before the first await.
 * A `session/event` listener cannot do that: the host session forbids append
 * reentry while an append is being published. Instead the bridge wraps
 * `session.append` on every live session (runtime patch, same pattern as the
 * modality patch): when the appended message carries image blocks, the wrapper
 * appends a placeholder `{op:'replace', start, end}` event targeting the
 * original message right after the host append returns, then fires the
 * analysis; the final replacement targets the placeholder's seq. A
 * `tool/result` carrying image blocks is shadowed the same way, with one
 * replacement event targeting the original seq.
 * @module dsh-vision-toolkit/auto-bridge
 */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { Session } from '@deepseek-ai/dsh-session';
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
    /** Cordis context used to enumerate live sessions and subscribe to their lifecycle. */
    ctx: Pick<Context, 'on'> & {
        sessions?: {
            list?: () => Session[];
        };
    };
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
     * Start bridging: wrap every live session's append (and keep wrapping
     * sessions created from now on) so image-bearing user messages land a
     * synchronous text-only placeholder before the agent loop projects model
     * history, then analyze asynchronously and swap the placeholder for the
     * real descriptions. The returned disposer unsubscribes and restores every
     * wrapped append; an in-flight analysis still finishes after disposal
     * (best effort, never left as an unhandled rejection).
     */
    start(): () => void;
}
//# sourceMappingURL=auto-bridge.d.ts.map