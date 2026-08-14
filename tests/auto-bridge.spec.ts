import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageAutoBridge } from '../lib/auto-bridge.js';

// 假事件总线:捕获监听器并可手动触发
function fakeEvents() {
  const listeners = [];
  return {
    on: (name, fn) => { listeners.push({ name, fn }); return () => { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1); }; },
    fire: (name, ...args) => { for (const l of listeners.filter((l) => l.name === name)) l.fn(...args); },
  };
}
// 假 session:记录 append 调用;header.cwd 即会话工作目录(真实 Session.header.cwd)
function fakeSession(cwd) {
  const events = [];
  return {
    events,
    header: { cwd },
    append(type, data, intent) { events.push({ type, data, intent }); return { seq: events.length - 1 }; },
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

const expectedArtifactRoot = (cwd) => join(cwd, '.dsh-vision-toolkit', 'artifacts', 'bridge');

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
      events.fire('session/event', session, makeImageEvent(3));
      await vi.waitFor(() => expect(session.events).toHaveLength(1));
      stop();

      expect(glanceCalls).toHaveLength(1);
      // 真实 session workspace 传给了 analyzer → glance(Task 3 修复约束)
      expect(glanceCalls[0].options.workspace).toBe(cwd);

      expect(session.events).toHaveLength(1);
      const appended = session.events[0];
      expect(appended.type).toBe('user/message');
      expect(appended.intent.surfaceOp).toEqual({ op: 'replace', start: 3, end: 3 });
      expect(appended.intent.sourceEventSeqs).toEqual([3]);
      expect(appended.data.content.some((b) => b.type === 'image')).toBe(false);
      expect(appended.data.id).toBe('m3-bridge');
      expect(appended.data.source).toEqual({ kind: 'user' });

      const savedPath = join(expectedArtifactRoot(cwd), 'img-1-0.png');
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
      events.fire('session/event', session, makeImageEvent(0));
      await vi.waitFor(() => expect(session.events).toHaveLength(1));
      stop();

      const text = session.events[0].data.content.map((b) => b.text ?? '').join('');
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
    events.fire('session/event', session, { seq: 1, type: 'user/message', data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(calls).toBe(0);
    expect(session.events).toHaveLength(0);
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
      events.fire('session/event', session, {
        seq: 5,
        type: 'user/message',
        data: {
          id: 'm5', role: 'user', source: { kind: 'user' },
          content: [
            { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
            { type: 'image', attachment: { attachmentId: 'img-2', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
            { type: 'image', attachment: { attachmentId: 'img-3', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
          ],
        },
      });
      await vi.waitFor(() => expect(session.events).toHaveLength(1));
      stop();

      expect(glanceCalls).toHaveLength(2);
      const text = session.events[0].data.content.map((b) => b.text ?? '').join('');
      expect(text).toContain('本条消息共 3 张图片,仅分析前 2 张');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
