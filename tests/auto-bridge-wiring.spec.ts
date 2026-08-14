import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

// 接线测试驱动真实的 apply() 生命周期;上游运行时准备(runtime-install /
// runtime-manager 套件各自覆盖)在这里被桩掉,保证确定性且不碰用户状态。
vi.mock('../lib/runtime-manager.js', () => ({
  VisionToolkitRuntimeManager: class {
    ready = false;
    current() { throw new Error('dsh-vision-toolkit runtime is not ready'); }
    async initialize() {}
    async reconfigure() { return false; }
    status() { return { ready: false, generation: 0 }; }
  },
}));

type Listener = { name: string; fn: (...args: never[]) => void };

interface FakeHarness {
  ctx: Record<string, unknown>;
  llm: { resolveModelInfo: ReturnType<typeof vi.fn> };
  listeners: Listener[];
  watchers: Array<(next: unknown, prev: unknown) => void | Promise<void>>;
  calls: Array<{ level: string; scope?: string; args: unknown[] }>;
  setValue: (next: unknown) => Promise<void>;
  fire: (name: string, ...args: unknown[]) => void;
}

// 假 ctx:on 收集器、settings 作用域(get/watch 且 setValue 模拟一次提交)、
// 可调用的 logger(ctx.logger(name) 返回子 logger)、llm、attachments。
function makeFakeCtx(
  initialValue: unknown = { autoBridge: { enabled: true, maxImagesPerMessage: 4 } },
  attachments?: { readImage: (ref: { attachmentId: string }) => Promise<{ ref: unknown; data: Uint8Array }> },
): FakeHarness {
  const listeners: Listener[] = [];
  const watchers: Array<(next: unknown, prev: unknown) => void | Promise<void>> = [];
  const calls: FakeHarness['calls'] = [];
  let value = initialValue;
  const makeLogger = (scope?: string) => ({
    info: (...args: unknown[]) => { calls.push({ level: 'info', scope, args }); },
    warn: (...args: unknown[]) => { calls.push({ level: 'warn', scope, args }); },
    error: (...args: unknown[]) => { calls.push({ level: 'error', scope, args }); },
  });
  const llm = {
    resolveModelInfo: vi.fn(async (provider: string, model: string) => ({ provider, id: model, name: model, inputModalities: ['text'] })),
  };
  const ctx = {
    on: (name: string, fn: (...args: never[]) => void) => {
      const entry = { name, fn };
      listeners.push(entry);
      return () => {
        const i = listeners.indexOf(entry);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    // 会话 store seam:桥接启动时枚举存量会话并包装其 append
    sessions: { list: () => [] as unknown[] },
    settings: {
      register: () => ({
        get: () => value,
        watch: (cb: (next: unknown, prev: unknown) => void | Promise<void>) => {
          watchers.push(cb);
          return () => {
            const i = watchers.indexOf(cb);
            if (i >= 0) watchers.splice(i, 1);
          };
        },
        update: async () => {},
        replace: async () => {},
      }),
    },
    logger: Object.assign((scope?: string) => makeLogger(scope), makeLogger()),
    tools: { register: () => () => {} },
    skills: { register: () => () => {} },
    inject: () => {},
    llm,
    attachments: attachments ?? {
      readImage: async (ref: { attachmentId: string }) => ({ ref, data: new Uint8Array([1, 2, 3]) }),
    },
  };
  return {
    ctx,
    llm,
    listeners,
    watchers,
    calls,
    // 模拟一次已提交的 Settings 变更:更新 get() 值并同步驱动 watch 回调。
    setValue: async (next) => {
      const prev = value;
      value = next;
      await Promise.all(watchers.map((cb) => cb(next, prev)));
    },
    fire: (name, ...args) => {
      for (const l of listeners.filter((l) => l.name === name)) l.fn(...args);
    },
  };
}

const imageEvent = (seq: number, count = 1) => ({
  seq,
  type: 'user/message',
  data: {
    id: `m${seq}`,
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '看这张图' },
      ...Array.from({ length: count }, (_, i) => ({
        type: 'image',
        attachment: { attachmentId: `img-${i}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      })),
    ],
  },
});

function fakeSession(cwd?: string) {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    header: cwd === undefined ? undefined : { cwd },
    append(type: string, data: unknown, intent: unknown) {
      const event = { type, data, intent, seq: events.length };
      events.push(event);
      return event;
    },
  };
}

describe('auto bridge apply wiring', () => {
  it('wraps resolveModelInfo and registers the session lifecycle listeners on apply; dispose restores both', async () => {
    const h = makeFakeCtx();
    const pristine = h.llm.resolveModelInfo;
    const dispose = await apply(h.ctx as never, {});
    try {
      // 1. apply 后 llm.resolveModelInfo 已被包装:仅 text 模型返回含 image
      expect(h.llm.resolveModelInfo).not.toBe(pristine);
      const info = await h.llm.resolveModelInfo('deepseek', 'chat');
      expect(info.inputModalities).toContain('image');
      expect(info.inputModalities).toContain('text');
      // bridge 已在 ctx.on 上注册 session/created + session/disposed 监听
      expect(h.listeners.map((l) => l.name)).toEqual(['session/created', 'session/disposed']);
      expect(h.watchers).toHaveLength(1);
    } finally {
      dispose();
    }
    // 3. dispose 后恢复原方法、监听已注销
    expect(h.llm.resolveModelInfo).toBe(pristine);
    expect(h.listeners).toHaveLength(0);
    expect(h.watchers).toHaveLength(0);
  });

  it('disables the patch and listener when autoBridge.enabled flips to false and reinstalls on true', async () => {
    const h = makeFakeCtx();
    const pristine = h.llm.resolveModelInfo;
    const dispose = await apply(h.ctx as never, {});
    try {
      expect(h.llm.resolveModelInfo).not.toBe(pristine);

      await h.setValue({ autoBridge: { enabled: false, maxImagesPerMessage: 4 } });
      // 2. settings 翻转为 enabled:false 后恢复原方法
      expect(h.llm.resolveModelInfo).toBe(pristine);
      expect(h.listeners).toHaveLength(0);
      const after = await h.llm.resolveModelInfo('deepseek', 'chat');
      expect(after.inputModalities).toEqual(['text']);

      // 翻转回 true 时重新安装补丁并重新注册监听
      await h.setValue({ autoBridge: { enabled: true, maxImagesPerMessage: 4 } });
      expect(h.llm.resolveModelInfo).not.toBe(pristine);
      expect(h.listeners.map((l) => l.name)).toEqual(['session/created', 'session/disposed']);
      const again = await h.llm.resolveModelInfo('deepseek', 'chat');
      expect(again.inputModalities).toContain('image');

      // 再翻转回 false:恢复与注销仍对称
      await h.setValue({ autoBridge: { enabled: false, maxImagesPerMessage: 4 } });
      expect(h.llm.resolveModelInfo).toBe(pristine);
      expect(h.listeners).toHaveLength(0);
    } finally {
      dispose();
    }
    expect(h.llm.resolveModelInfo).toBe(pristine);
    expect(h.listeners).toHaveLength(0);
  });

  it('defaults to enabled when autoBridge is absent from settings', async () => {
    const h = makeFakeCtx({});
    const pristine = h.llm.resolveModelInfo;
    const dispose = await apply(h.ctx as never, {});
    try {
      expect(h.llm.resolveModelInfo).not.toBe(pristine);
      expect(h.listeners).toHaveLength(2);
    } finally {
      dispose();
    }
    expect(h.llm.resolveModelInfo).toBe(pristine);
  });

  it('bridges a pasted image through the wrapped session append, honoring maxImages', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dvt-wiring-session-'));
    try {
      const h = makeFakeCtx({ autoBridge: { enabled: true, maxImagesPerMessage: 2 } });
      const dispose = await apply(h.ctx as never, {});
      try {
        const session = fakeSession(cwd);
        // apply 安装的桥接在 session/created 时包装 session.append;
        // 宿主随后同步 append 带图消息 → 占位同步落地,分析异步替换占位
        h.fire('session/created', session);
        session.append('user/message', imageEvent(3, 3).data, { surfaceOp: 'append' });
        await vi.waitFor(() => expect(session.events).toHaveLength(3));
        // 日志顺序:原消息 → 占位 → 最终;断言最终替换事件(以占位 seq 为目标)
        expect(session.events.map((e) => (e.data as { id: string }).id)).toEqual(['m3', 'm3-bridge-pending', 'm3-bridge']);
        const final = session.events[2]!;
        expect((final.intent as { surfaceOp: unknown }).surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 });
        const text = (final.data as { content: Array<{ text?: string }> }).content.map((b) => b.text ?? '').join('');
        // runtimeSource 桩抛"未就绪"→ 分析降级为失败说明
        expect(text).toContain('[图片自动分析]失败(dsh-vision-toolkit runtime is not ready)');
        expect(text).toContain('本条消息共 3 张图片,仅分析前 2 张');
        const savedPath = join(cwd, '.dsh-vision-toolkit', 'artifacts', 'bridge', 'img-0-0.png');
        expect(text).toContain(`图片已保存:${savedPath}`);
      } finally {
        dispose();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('degrades to a 处理失败 note when attachment reads fail (wording fix)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dvt-wiring-session-'));
    try {
      const h = makeFakeCtx({ autoBridge: { enabled: true, maxImagesPerMessage: 4 } }, {
        readImage: async () => { throw new Error('attachment gone'); },
      });
      const dispose = await apply(h.ctx as never, {});
      try {
        const session = fakeSession(cwd);
        h.fire('session/created', session);
        session.append('user/message', imageEvent(5).data, { surfaceOp: 'append' });
        await vi.waitFor(() => expect(session.events).toHaveLength(3));
        const final = session.events[2]!;
        expect((final.intent as { surfaceOp: unknown }).surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 });
        const text = (final.data as { content: Array<{ text?: string }> }).content.map((b) => b.text ?? '').join('');
        expect(text).toContain('[图片自动分析]处理失败(attachment gone)');
      } finally {
        dispose();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('logs a warning instead of crashing when a session rejects the placeholder append', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dvt-wiring-session-'));
    try {
      const h = makeFakeCtx();
      const dispose = await apply(h.ctx as never, {});
      try {
        // 会话不可写(宿主 reentrancy 守卫语义):替换意图的 append 被拒 → 仅 warn,不分析
        const session = {
          events: [],
          header: { cwd },
          append(type: string, data: unknown, intent?: { surfaceOp?: { op?: string } }) {
            if (intent?.surfaceOp?.op === 'replace') throw new Error('cannot reenter');
            session.events.push({ type, data, intent });
            return { seq: session.events.length - 1 };
          },
        };
        h.fire('session/created', session);
        expect(() => session.append('user/message', imageEvent(1).data, { surfaceOp: 'append' })).not.toThrow();
        expect(session.events).toHaveLength(1);
        await vi.waitFor(() => {
          expect(h.calls.some((c) => c.level === 'warn' && c.scope === 'vision-toolkit/auto-bridge' && String(c.args[0]).includes('placeholder append failed'))).toBe(true);
        });
      } finally {
        dispose();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
