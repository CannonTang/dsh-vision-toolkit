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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageId } from '@deepseek-ai/dsh-llm';
import { ImageAnalyzer } from "./auto-bridge-analyze.js";
const BRIDGE_PREFIX = '[图片自动分析]';
/**
 * Appended to the placeholder text: this text-only model cannot receive image
 * blocks, so the model must reach the saved images through the vision tool.
 */
const READ_IMAGE_GUIDANCE = '不要调用 read_image(当前模型无法接收图片内容);请直接调用 vision_glance 查看该路径。';
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
            if (type === 'tool/result') {
                // Same synchronous-shadow mechanism as user messages: a tool result
                // carrying image blocks (host read_image, admitted by the modality
                // patch) would fail the next LLM request on the text-only adapter, so
                // a text-only replacement must land before the loop derives history.
                const toolResultEvent = event;
                if (this.#containsImage(toolResultEvent.data.message.content)) {
                    try {
                        original.call(session, 'tool/result', this.#toolResultReplacement(toolResultEvent), {
                            surfaceOp: { op: 'replace', start: toolResultEvent.seq, end: toolResultEvent.seq },
                            sourceEventSeqs: [toolResultEvent.seq],
                        });
                    }
                    catch (error) {
                        // Session not writable: keep the original append semantics and let
                        // the round fail on the adapter rather than break the tool call.
                        this.#logger.warn('auto-bridge: tool result shadow append failed: %s', error instanceof Error ? error.message : String(error));
                    }
                }
                return event;
            }
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
            ? `${BRIDGE_PREFIX} 分析中…${READ_IMAGE_GUIDANCE}`
            : `${BRIDGE_PREFIX} 分析中…图片已保存:${pathText.join(', ')},可直接用 vision_glance 查看该路径获取内容。${READ_IMAGE_GUIDANCE}`;
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
     * The text-only replacement shadowing one image-bearing tool result: the
     * original data with only the tool-result block's content rewritten (every
     * image block becomes a text note). The host's `assertToolResultRewrite`
     * requires everything but that content to stay deep-equal to the original —
     * id, source, turn, step, toolCallId, isError, and any error/meta fields —
     * so they are preserved verbatim. The original event stays in the durable
     * log; only the derived model history sees the replacement.
     */
    #toolResultReplacement(event) {
        const message = event.data.message;
        // ToolResultMessage content is exactly one tool-result block; rebuild it as
        // a one-element tuple so the replacement keeps the message shape.
        const [toolResultBlock] = message.content;
        return {
            ...event.data,
            message: {
                ...message,
                content: [this.#replacedToolResultBlock(toolResultBlock)],
            },
        };
    }
    /** Whether any image block exists anywhere in the content tree (nested tool-result content included). */
    #containsImage(blocks) {
        for (const block of blocks) {
            if (block.type === 'image')
                return true;
            if (block.type === 'tool-result' && this.#containsImage(block.content))
                return true;
        }
        return false;
    }
    /** One tool-result block deep-copied with every image block inside replaced by text. */
    #replacedToolResultBlock(block) {
        const content = block.content.map((inner, index) => this.#replacedBlock(inner, block.content, index));
        if (block.isError === undefined)
            return { type: 'tool-result', toolCallId: block.toolCallId, content };
        return { type: 'tool-result', toolCallId: block.toolCallId, isError: block.isError, content };
    }
    /** One content block deep-copied; image blocks become the model-facing text note. */
    #replacedBlock(block, siblings, index) {
        if (block.type === 'image')
            return { type: 'text', text: this.#imageReplacementText(block, siblings, index) };
        if (block.type === 'tool-result')
            return this.#replacedToolResultBlock(block);
        return { ...block };
    }
    /**
     * The text note standing in for one image block: media type and intrinsic
     * dimensions come from the attachment reference; the saved path comes from
     * the adjacent text blocks (the host `read_image` envelope renders
     * `<path>…</path>` beside its image block), falling back to the attachment
     * name, then omitted entirely so the note never throws.
     */
    #imageReplacementText(block, siblings, index) {
        const { mediaType, bytes, width, height } = block.attachment;
        const path = this.#adjacentPath(siblings, index, block.attachment.name);
        const saved = path === undefined ? '' : `,已保存于 ${path}`;
        const glance = path === undefined
            ? '请调用 vision_glance 查看该图片内容'
            : '请调用 vision_glance 传入该路径查看图片内容';
        return `该图片无法直接进入模型上下文:${mediaType} ${width}x${height} px, ${bytes} bytes${saved}。${glance}。`;
    }
    /** The path beside the image block: an adjacent text block's `<path>` envelope, else the attachment name. */
    #adjacentPath(siblings, index, fallbackName) {
        const before = index > 0 ? siblings[index - 1] : undefined;
        const after = index + 1 < siblings.length ? siblings[index + 1] : undefined;
        const beforePath = before !== undefined && before.type === 'text' ? this.#pathFromText(before.text) : undefined;
        const afterPath = after !== undefined && after.type === 'text' ? this.#pathFromText(after.text) : undefined;
        return beforePath ?? afterPath ?? fallbackName;
    }
    /** Extract the path rendered inside a `<path>…</path>` envelope, when present. */
    #pathFromText(text) {
        const match = /<path>([\s\S]*?)<\/path>/.exec(text);
        return match?.[1];
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