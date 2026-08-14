/**
 * Pasted-image auto bridge: wraps each live session's append so a user message
 * carrying image blocks gets a synchronous text-only placeholder event, then
 * analyzes every image through the shared analyzer and replaces the placeholder
 * with the real descriptions while the original event stays in the durable log.
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
 * analysis; the final replacement targets the placeholder's seq.
 * @module dsh-vision-toolkit/auto-bridge
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageId } from '@deepseek-ai/dsh-llm';
import { ImageAnalyzer } from "./auto-bridge-analyze.js";
const BRIDGE_PREFIX = '[图片自动分析]';
/** Subdirectory of the plugin-managed artifact tree that owns bridge saves. */
const BRIDGE_ARTIFACT_DIR = 'bridge';
const EXTENSION_BY_MEDIA_TYPE = new Map([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/webp', '.webp'],
    ['image/gif', '.gif'],
]);
export class ImageAutoBridge {
    #ctx;
    #runtimeSource;
    #attachments;
    #maxImages;
    #logger;
    /** Sessions whose append is wrapped; iteration lets the disposer restore them exactly. */
    #wrapped = new Set();
    /** The exact original append captured per wrapped session. */
    #originals = new WeakMap();
    constructor(deps) {
        this.#ctx = deps.ctx;
        this.#runtimeSource = deps.runtimeSource;
        this.#attachments = deps.attachments;
        this.#maxImages = deps.maxImages;
        this.#logger = deps.logger;
    }
    /**
     * Start bridging: wrap every live session's append (and keep wrapping
     * sessions created from now on) so image-bearing user messages land a
     * synchronous text-only placeholder before the agent loop projects model
     * history, then analyze asynchronously and swap the placeholder for the
     * real descriptions. The returned disposer unsubscribes and restores every
     * wrapped append; an in-flight analysis still finishes after disposal
     * (best effort, never left as an unhandled rejection).
     */
    start() {
        for (const session of this.#liveSessions())
            this.#wrapSession(session);
        const created = this.#ctx.on('session/created', (session) => {
            this.#wrapSession(session);
        });
        const disposed = this.#ctx.on('session/disposed', (session) => {
            this.#unwrapSession(session);
        });
        return () => {
            created();
            disposed();
            for (const session of [...this.#wrapped])
                this.#unwrapSession(session);
        };
    }
    /** Live sessions known to the store, or [] when the seam is unavailable. */
    #liveSessions() {
        const sessions = this.#ctx.sessions;
        if (typeof sessions?.list !== 'function')
            return [];
        try {
            return sessions.list();
        }
        catch (error) {
            this.#logger.warn('auto-bridge: cannot enumerate live sessions: %s', error instanceof Error ? error.message : String(error));
            return [];
        }
    }
    /**
     * Wrap one session's append so an appended user message with image blocks
     * is synchronously shadowed by a text-only placeholder event, and analysis
     * is fired against that placeholder. Never throws: a session that cannot be
     * wrapped just keeps its original append (events still flow, the race stays
     * for that session but nothing else breaks).
     */
    #wrapSession(session) {
        if (this.#wrapped.has(session))
            return;
        const original = session.append;
        const wrapper = ((type, data, ...opts) => {
            const event = original.call(session, type, data, ...opts);
            if (type !== 'user/message')
                return event;
            const messageEvent = event;
            const imageBlocks = (data.content ?? []).filter((block) => block.type === 'image');
            if (imageBlocks.length === 0)
                return event;
            const paths = this.#precomputePaths(session, imageBlocks);
            let placeholderSeq;
            try {
                placeholderSeq = original.call(session, 'user/message', this.#placeholderMessage(messageEvent, paths), {
                    surfaceOp: { op: 'replace', start: messageEvent.seq, end: messageEvent.seq },
                    sourceEventSeqs: [messageEvent.seq],
                }).seq;
            }
            catch (error) {
                // Session not writable: keep the original append semantics and skip
                // analysis rather than making the message send fail.
                this.#logger.warn('auto-bridge: placeholder append failed: %s', error instanceof Error ? error.message : String(error));
                return event;
            }
            void this.#handleAsync(session, messageEvent, imageBlocks, placeholderSeq, paths).catch((error) => {
                this.#logger.warn('auto-bridge: handling failed: %s', error instanceof Error ? error.message : String(error));
            });
            return event;
        });
        try {
            session.append = wrapper;
            this.#wrapped.add(session);
            this.#originals.set(session, original);
        }
        catch (error) {
            this.#logger.warn('auto-bridge: session append wrap failed: %s', error instanceof Error ? error.message : String(error));
        }
    }
    /** Restore a session's exact original append. */
    #unwrapSession(session) {
        const original = this.#originals.get(session);
        if (original !== undefined)
            session.append = original;
        this.#originals.delete(session);
        this.#wrapped.delete(session);
    }
    /**
     * The synchronous placeholder: the original message's non-image blocks plus
     * one text note claiming the soon-to-be-written artifact paths, so the model
     * sees a text-only message with usable image references from the very first
     * request.
     */
    #placeholderMessage(event, paths) {
        const pathText = paths.slice(0, this.#maxImages).filter((path) => path !== undefined);
        const text = pathText.length === 0
            ? `${BRIDGE_PREFIX} 分析中…`
            : `${BRIDGE_PREFIX} 分析中…图片已保存:${pathText.join(', ')},可直接用 vision_glance 查看该路径获取内容`;
        return {
            id: MessageId(`${event.data.id}-bridge-pending`),
            role: 'user',
            source: event.data.source,
            content: [
                ...event.data.content.filter((block) => block.type !== 'image'),
                { type: 'text', text },
            ],
        };
    }
    /**
     * Read each image block from the attachment store, persist it inside the
     * session's managed artifact tree, analyze it through a fresh analyzer bound
     * to that session's workspace, and append one text-only replacement event
     * targeting the placeholder seq so the text-only model sees descriptions
     * while the original event stays in the durable log.
     */
    async #handleAsync(session, event, imageBlocks, placeholderSeq, paths) {
        const notes = [];
        const limited = imageBlocks.length > this.#maxImages;
        // The session workspace is only known per message, so the analyzer is
        // built here: relative allowedDirs entries then resolve against the real
        // session workspace exactly like the manual tools (ImageAnalyzer#workspace).
        const options = session.header.cwd === undefined ? {} : { workspace: session.header.cwd };
        const analyzer = new ImageAnalyzer(this.#runtimeSource, options);
        let index = 0;
        for (const block of imageBlocks.slice(0, this.#maxImages)) {
            try {
                const stored = await this.#attachments.readImage(block.attachment);
                const savedPath = await this.#writeManagedImage(session, stored, index);
                const outcome = await analyzer.analyze(stored.data, stored.ref.mediaType, stored.ref.name);
                notes.push(outcome.ok
                    ? `${BRIDGE_PREFIX} ${outcome.answer}\n图片已保存:${savedPath},可用视觉工具深入分析`
                    : `${BRIDGE_PREFIX}失败(${outcome.reason})\n图片已保存:${savedPath}`);
            }
            catch (error) {
                // The path was already claimed by the placeholder; keep pointing at it
                // so the model's image reference stays stable whether the write landed.
                const reason = error instanceof Error ? error.message : String(error);
                const path = paths[index];
                notes.push(path === undefined
                    ? `${BRIDGE_PREFIX}处理失败(${reason})`
                    : `${BRIDGE_PREFIX}处理失败(${reason})\n图片已保存:${path}`);
            }
            index += 1;
        }
        if (limited)
            notes.push(`${BRIDGE_PREFIX}本条消息共 ${imageBlocks.length} 张图片,仅分析前 ${this.#maxImages} 张`);
        const replacement = {
            id: MessageId(`${event.data.id}-bridge`),
            role: 'user',
            source: event.data.source,
            content: [
                ...event.data.content.filter((block) => block.type !== 'image'),
                ...notes.map((text) => ({ type: 'text', text })),
            ],
        };
        try {
            session.append('user/message', replacement, {
                surfaceOp: { op: 'replace', start: placeholderSeq, end: placeholderSeq },
                sourceEventSeqs: [placeholderSeq],
            });
        }
        catch (error) {
            this.#logger.warn('auto-bridge: replacement append failed: %s', error instanceof Error ? error.message : String(error));
        }
    }
    /** Persist one image inside the session's managed artifact tree. */
    async #writeManagedImage(session, stored, index) {
        const root = this.#artifactRootFor(session);
        await mkdir(root, { recursive: true });
        const file = join(root, this.#artifactFilenameFor(stored.ref, index));
        await writeFile(file, stored.data);
        return file;
    }
    /**
     * The plugin-managed artifact tree for one session's bridge saves:
     * `<workspace>/.dsh-vision-toolkit/artifacts/bridge` — the same default
     * output layout the manual tools use and the artifact access route serves.
     */
    #artifactRootFor(session) {
        const cwd = session.header.cwd;
        if (cwd === undefined)
            throw new Error('session has no working directory for bridge artifacts');
        return join(cwd, '.dsh-vision-toolkit', 'artifacts', BRIDGE_ARTIFACT_DIR);
    }
    /** One stable, extension-typed filename per image; the index keeps blocks distinct. */
    #artifactFilenameFor(ref, index) {
        const safe = ref.attachmentId.replace(/[^A-Za-z0-9._-]/g, '_');
        const stem = safe.length === 0 ? 'image' : safe;
        return `${stem}-${index}${EXTENSION_BY_MEDIA_TYPE.get(ref.mediaType) ?? '.bin'}`;
    }
    /**
     * The paths the async analysis will write, precomputed deterministically so
     * the synchronous placeholder can claim them before any await. An entry is
     * `undefined` when the path cannot be derived (e.g. no session cwd).
     */
    #precomputePaths(session, imageBlocks) {
        const paths = [];
        for (let index = 0; index < imageBlocks.length; index += 1) {
            try {
                paths.push(join(this.#artifactRootFor(session), this.#artifactFilenameFor(imageBlocks[index].attachment, index)));
            }
            catch {
                paths.push(undefined);
            }
        }
        return paths;
    }
}
//# sourceMappingURL=auto-bridge.js.map