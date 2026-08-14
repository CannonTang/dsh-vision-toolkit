import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageAutoBridge } from '../lib/auto-bridge.js';

// 假事件总线:捕获监听器并可手动触发(模拟宿主 ctx.on / store dispatch)
function fakeEvents() {
  const listeners = [];
  return {
    on: (name, fn) => { listeners.push({ name, fn }); return () => { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1); }; },
    fire: (name, ...args) => { for (const l of listeners.filter((l) => l.name === name)) l.fn(...args); },
  };
}
// 假 session:记录 append 调用;header.cwd 即会话工作目录(真实 Session.header.cwd)。
// append 返回被记录的事件本身,与宿主 Session.append 契约一致(返回带 seq/data 的
// 已记录事件快照)。tool/result 替换额外实现宿主 assertToolResultRewrite 的简化等价
// 校验:除 tool-result 块 content 外其余数据(含 message.id)必须与原事件一致,否则同步抛错。
function fakeSession(cwd) {
  const events = [];
  return {
    events,
    header: { cwd },
    append(type, data, intent) {
      if (type === 'tool/result' && intent?.surfaceOp?.op === 'replace') {
        const original = events[intent.surfaceOp.start];
        const origResult = original?.data?.message?.content?.[0];
        const replResult = data?.message?.content?.[0];
        const restEqual = original?.data?.turn === data.turn
          && original?.data?.step === data.step
          && original?.data?.message?.id === data.message?.id
          && original?.data?.message?.role === data.message?.role
          && JSON.stringify(original?.data?.message?.source) === JSON.stringify(data.message?.source)
          && origResult?.toolCallId === replResult?.toolCallId
          && (origResult?.isError ?? null) === (replResult?.isError ?? null);
        if (!restEqual) throw new Error('tool/result surface replacement may change only content');
      }
      const event = { type, data, intent, seq: events.length };
      events.push(event);
      return event;
    },
  };
}

// 与真实 UserMessage 一致的 image 块:attachment 为 ImageAttachmentRef
// { attachmentId, mediaType, bytes, width, height, name? }
const makeImageEvent = (seq) => ({
  seq,
  type: 'user/message',
  data: {
    id: `m${seq}`, role: 'user', source: { kind: 'user' },
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'img-1.png' } },
    ],
  },
});

// 模拟宿主的同步 append→(事件监听器)→返回 流程中"append 用户消息"一步
const hostAppend = (session, event) => session.append(event.type, event.data, { surfaceOp: 'append' });

const expectedArtifactRoot = (cwd) => join(cwd, '.dsh-vision-toolkit', 'artifacts', 'bridge');
const expectedSavedPath = (cwd, seq) => join(expectedArtifactRoot(cwd), 'img-1-0.png');

// 递归工具:内容树任意层级是否存在 image 块;拼接全部 text 文本
const hasImageBlocks = (blocks) => blocks.some((b) => b.type === 'image' || (b.type === 'tool-result' && hasImageBlocks(b.content)));
const collectText = (blocks) => blocks.map((b) => (b.type === 'text' ? b.text : b.type === 'tool-result' ? collectText(b.content) : '')).join('');

// 与真实宿主 read_image 结果一致的 tool/result 事件:相邻 text 块携带 <path> 信封,其后是 image 块
const makeToolResultEvent = (seq, callId = 'call_read_image', id = `tr${seq}`) => ({
  seq,
  type: 'tool/result',
  data: {
    turn: 1,
    step: 2,
    message: {
      id,
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        isError: false,
        content: [
          { type: 'text', text: '<path>/tmp/shot.png</path>\n<type>image</type>\n<content>\nimage/png image, 1200x800 px, 54321 bytes\n</content>' },
          { type: 'image', attachment: { attachmentId: 'img-9', mediaType: 'image/png', bytes: 54321, width: 1200, height: 800, name: 'shot.png' } },
        ],
      }],
    },
  },
});

describe('ImageAutoBridge', () => {
  it('appends a text replacement event when a user message carries an image', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dvt-bridge-session-'));
    try {
      const events = fakeEvents();
      const session = fakeSession(cwd);
      const glanceCalls = [];
      const bridge = new ImageAutoBridge({
        ctx: { on: events.on },
        runtimeSource: () => ({ glance: async (request, options) => {
          glanceCalls.push({ request, options });
          return { images: request.images, mode: 'describe', answer: '一张登录页截图', truncated: false };
        } }),
        attachments: { readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3]) }) },
        maxImages: 4,
        logger: { info() {}, warn() {} },
      });
      const stop = bridge.start();
      events.fire('session/created', session);
      hostAppend(session, makeImageEvent(3));
      await vi.waitFor(() => expect(session.events).toHaveLength(3));
      stop();

      expect(glanceCalls).toHaveLength(1);
      // 真实 session workspace 传给了 analyzer → glance(Task 3 修复约束)
      expect(glanceCalls[0].options.workspace).toBe(cwd);

      // 日志顺序:原消息 → 占位 → 最终
      expect(session.events.map((e) => e.data.id)).toEqual(['m3', 'm3-bridge-pending', 'm3-bridge']);
      const appended = session.events[2];
      expect(appended.intent.surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 });
      expect(appended.intent.sourceEventSeqs).toEqual([1]);
      expect(appended.data.content.some((b) => b.type === 'image')).toBe(false);
      expect(appended.data.id).toBe('m3-bridge');
      expect(appended.data.source).toEqual({ kind: 'user' });

      const savedPath = expectedSavedPath(cwd, 3);
      const text = appended.data.content.map((b) => b.text ?? '').join('');
      expect(text).toContain('一张登录页截图');
      expect(text).toContain('看这张图');
      expect(text).toContain(`图片已保存:${savedPath}`);
      // 图片确实被持久化到托管产物树
      const persisted = await readFile(savedPath);
      expect([...persisted]).toEqual([1, 2, 3]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('degrades to a failure note when analysis fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dvt-bridge-session-'));
    try {
      const events = fakeEvents();
      const session = fakeSession(cwd);
      const bridge = new ImageAutoBridge({
        ctx: { on: events.on },
        runtimeSource: () => ({ glance: async () => { throw new Error('rate limited'); } }),
        attachments: { readImage: async (ref) => ({ ref, data: new Uint8Array([1]) }) },
        maxImages: 4,
        logger: { info() {}, warn() {} },
      });
      const stop = bridge.start();
      events.fire('session/created', session);
      hostAppend(session, makeImageEvent(0));
      await vi.waitFor(() => expect(session.events).toHaveLength(3));
      stop();

      const final = session.events[2];
      // 失败路径同样以占位 seq 为目标替换
      expect(final.intent.surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 });
      expect(final.intent.sourceEventSeqs).toEqual([1]);
      const text = final.data.content.map((b) => b.text ?? '').join('');
      expect(text).toContain('[图片自动分析]失败(rate limited)');
      expect(text).toContain('rate limited');
      expect(text).toContain('图片已保存:');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('ignores messages without image blocks', async () => {
    const events = fakeEvents();
    const session = fakeSession(undefined);
    let calls = 0;
    const bridge = new ImageAutoBridge({
      ctx: { on: events.on },
      runtimeSource: () => ({ glance: async () => { calls += 1; return { images: [], mode: 'describe', answer: 'x', truncated: false }; } }),
      attachments: { readImage: async (ref) => ({ ref, data: new Uint8Array([1]) }) },
      maxImages: 4,
      logger: { info() {}, warn() {} },
    });
    const stop = bridge.start();
    events.fire('session/created', session);
    session.append('user/message', { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, { surfaceOp: 'append' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(calls).toBe(0);
    expect(session.events).toHaveLength(1);
  });
  it('analyzes only maxImages images and notes the overflow', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dvt-bridge-session-'));
    try {
      const events = fakeEvents();
      const session = fakeSession(cwd);
      const glanceCalls = [];
      const bridge = new ImageAutoBridge({
        ctx: { on: events.on },
        runtimeSource: () => ({ glance: async (request) => {
          glanceCalls.push(request.images[0]);
          return { images: [], mode: 'describe', answer: 'ok', truncated: false };
        } }),
        attachments: { readImage: async (ref) => ({ ref, data: new Uint8Array([1]) }) },
        maxImages: 2,
        logger: { info() {}, warn() {} },
      });
      const stop = bridge.start();
      events.fire('session/created', session);
      session.append('user/message', {
        id: 'm5', role: 'user', source: { kind: 'user' },
        content: [
          { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
          { type: 'image', attachment: { attachmentId: 'img-2', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
          { type: 'image', attachment: { attachmentId: 'img-3', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
        ],
      }, { surfaceOp: 'append' });
      await vi.waitFor(() => expect(session.events).toHaveLength(3));
      stop();

      expect(glanceCalls).toHaveLength(2);
      const final = session.events[2];
      expect(final.intent.surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 });
      const text = final.data.content.map((b) => b.text ?? '').join('');
      expect(text).toContain('本条消息共 3 张图片,仅分析前 2 张');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('synchronously lands a placeholder replacement before any analysis (first-message race)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dvt-bridge-session-'));
    try {
      const events = fakeEvents();
      const session = fakeSession(cwd);
      let resolveRead;
      const glanceCalls = [];
      const bridge = new ImageAutoBridge({
        ctx: { on: events.on },
        runtimeSource: () => ({ glance: async () => { glanceCalls.push(1); return { images: [], mode: 'describe', answer: 'x', truncated: false }; } }),
        // readImage 挂起:异步链停在第一个 await,占位必须已落地
        attachments: { readImage: (ref) => new Promise((resolve) => { resolveRead = () => resolve({ ref, data: new Uint8Array([1, 2, 3]) }); }) },
        maxImages: 4,
        logger: { info() {}, warn() {} },
      });
      const stop = bridge.start();
      events.fire('session/created', session);
      hostAppend(session, makeImageEvent(3));
      // 不等待任何异步:占位事件必须已在同步段追加
      expect(session.events).toHaveLength(2);
      const placeholder = session.events[1];
      expect(placeholder.data.id).toBe('m3-bridge-pending');
      expect(placeholder.intent.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 });
      expect(placeholder.intent.sourceEventSeqs).toEqual([0]);
      expect(placeholder.data.content.some((b) => b.type === 'image')).toBe(false);
      const text = placeholder.data.content.map((b) => b.text ?? '').join('');
      expect(text).toContain('分析中');
      expect(text).toContain(`图片已保存:${expectedSavedPath(cwd, 3)}`);
      expect(text).toContain('看这张图');
      // 占位文本必须禁调 read_image:本模型上下文无法接收图片块
      expect(text).toContain('不要调用 read_image(当前模型无法接收图片内容);请直接调用 vision_glance 查看该路径。');
      // 异步链尚未推进:readImage 仍 pending,glance 未被调用
      expect(glanceCalls).toHaveLength(0);
      resolveRead();
      await vi.waitFor(() => expect(session.events).toHaveLength(3));
      stop();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('synchronously shadows a tool result whose message carries image blocks', () => {
    const events = fakeEvents();
    const session = fakeSession(undefined);
    const bridge = new ImageAutoBridge({
      ctx: { on: events.on },
      runtimeSource: () => ({ glance: async () => { throw new Error('unused'); } }),
      attachments: { readImage: async (ref) => ({ ref, data: new Uint8Array([1]) }) },
      maxImages: 4,
      logger: { info() {}, warn() {} },
    });
    const stop = bridge.start();
    events.fire('session/created', session);
    session.append('tool/result', makeToolResultEvent(0).data, { surfaceOp: 'append' });
    // 零等待:替换事件必须在同一同步块落地(与用户消息占位同机制)
    expect(session.events).toHaveLength(2);
    const replacement = session.events[1];
    expect(replacement.type).toBe('tool/result');
    expect(replacement.intent.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 });
    expect(replacement.intent.sourceEventSeqs).toEqual([0]);
    const message = replacement.data.message;
    // 宿主 assertToolResultRewrite 不变量:替换事件除 tool-result 块 content 外
    // 必须与原事件深度相等,message.id 原样保留
    expect(message.id).toBe(session.events[0].data.message.id);
    expect(message.role).toBe('user');
    expect(message.source).toEqual({ kind: 'tool', callId: 'call_read_image' });
    expect(message.content).toHaveLength(1);
    expect(message.content[0].type).toBe('tool-result');
    // toolCallId 与 isError 保留
    expect(message.content[0].toolCallId).toBe('call_read_image');
    expect(message.content[0].isError).toBe(false);
    // 模型历史不变量:任何层级不得有 image 块
    expect(hasImageBlocks(message.content)).toBe(false);
    const text = collectText(message.content);
    expect(text).toContain('该图片无法直接进入模型上下文:image/png 1200x800 px, 54321 bytes');
    // path 取自相邻 text 块的 <path> 信封
    expect(text).toContain('已保存于 /tmp/shot.png');
    expect(text).toContain('请调用 vision_glance 传入该路径查看图片内容');
    stop();
  });
  it('does not shadow a tool result without image blocks', () => {
    const events = fakeEvents();
    const session = fakeSession(undefined);
    const bridge = new ImageAutoBridge({
      ctx: { on: events.on },
      runtimeSource: () => ({ glance: async () => { throw new Error('unused'); } }),
      attachments: { readImage: async (ref) => ({ ref, data: new Uint8Array([1]) }) },
      maxImages: 4,
      logger: { info() {}, warn() {} },
    });
    const stop = bridge.start();
    events.fire('session/created', session);
    session.append('tool/result', {
      turn: 1,
      step: 2,
      message: {
        id: 'tr2',
        role: 'user',
        source: { kind: 'tool', callId: 'call_text' },
        content: [{ type: 'tool-result', toolCallId: 'call_text', content: [{ type: 'text', text: '<path>/tmp/a.txt</path>\nok' }] }],
      },
    }, { surfaceOp: 'append' });
    expect(session.events).toHaveLength(1);
    stop();
  });
  it('replaces the placeholder (not the original) with the final text in log order', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dvt-bridge-session-'));
    try {
      const events = fakeEvents();
      const session = fakeSession(cwd);
      const bridge = new ImageAutoBridge({
        ctx: { on: events.on },
        runtimeSource: () => ({ glance: async () => ({ images: [], mode: 'describe', answer: '描述文本', truncated: false }) }),
        attachments: { readImage: async (ref) => ({ ref, data: new Uint8Array([1]) }) },
        maxImages: 4,
        logger: { info() {}, warn() {} },
      });
      const stop = bridge.start();
      events.fire('session/created', session);
      hostAppend(session, makeImageEvent(3));
      await vi.waitFor(() => expect(session.events).toHaveLength(3));
      stop();

      const [original, placeholder, final] = session.events;
      // 原消息保持 append 语义(它仍在日志里)
      expect(original.intent.surfaceOp).toBe('append');
      // 占位替换原消息
      expect(placeholder.intent.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 });
      expect(placeholder.intent.sourceEventSeqs).toEqual([0]);
      // 最终替换占位(链式:原消息 → 占位 → 最终)
      expect(final.intent.surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 });
      expect(final.intent.sourceEventSeqs).toEqual([1]);
      expect(session.events.map((e) => e.data.id)).toEqual(['m3', 'm3-bridge-pending', 'm3-bridge']);
      const text = final.data.content.map((b) => b.text ?? '').join('');
      expect(text).toContain('描述文本');
      expect(text).toContain('看这张图');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('replaces the placeholder too when attachment reads fail', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dvt-bridge-session-'));
    try {
      const events = fakeEvents();
      const session = fakeSession(cwd);
      const bridge = new ImageAutoBridge({
        ctx: { on: events.on },
        runtimeSource: () => ({ glance: async () => ({ images: [], mode: 'describe', answer: 'x', truncated: false }) }),
        attachments: { readImage: async () => { throw new Error('attachment gone'); } },
        maxImages: 4,
        logger: { info() {}, warn() {} },
      });
      const stop = bridge.start();
      events.fire('session/created', session);
      hostAppend(session, makeImageEvent(3));
      await vi.waitFor(() => expect(session.events).toHaveLength(3));
      stop();

      const final = session.events[2];
      // 失败路径同样以占位 seq 为目标
      expect(final.intent.surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 });
      expect(final.intent.sourceEventSeqs).toEqual([1]);
      const text = final.data.content.map((b) => b.text ?? '').join('');
      expect(text).toContain('[图片自动分析]处理失败(attachment gone)');
      // 占位已声明的路径在失败文本中保持一致
      expect(text).toContain(`图片已保存:${expectedSavedPath(cwd, 3)}`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('warns and skips analysis when the placeholder append is rejected', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dvt-bridge-session-'));
    try {
      const events = fakeEvents();
      const warns = [];
      const session = {
        events: [],
        header: { cwd },
        // 模拟会话不可写:替换意图的 append 被拒绝(宿主 reentrancy 守卫语义)
        append(type, data, intent) {
          if (intent?.surfaceOp?.op === 'replace') throw new Error('cannot reenter');
          const event = { type, data, intent, seq: session.events.length };
          session.events.push(event);
          return event;
        },
      };
      let glanceCalls = 0;
      const bridge = new ImageAutoBridge({
        ctx: { on: events.on },
        runtimeSource: () => ({ glance: async () => { glanceCalls += 1; return { images: [], mode: 'describe', answer: 'x', truncated: false }; } }),
        attachments: { readImage: async (ref) => ({ ref, data: new Uint8Array([1]) }) },
        maxImages: 4,
        logger: { info() {}, warn: (...args) => warns.push(args) },
      });
      const stop = bridge.start();
      events.fire('session/created', session);
      // 原消息 append 正常返回;占位失败只 warn,不启动分析
      expect(() => hostAppend(session, makeImageEvent(2))).not.toThrow();
      expect(session.events).toHaveLength(1);
      expect(warns.some((args) => String(args[0]).includes('placeholder append failed'))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(glanceCalls).toBe(0);
      stop();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
