import { describe, expect, it } from 'vitest';
import { installImageModalityPatch } from '../lib/auto-bridge-modality.js';

const makeLlm = () => ({
  resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'] }),
});

describe('installImageModalityPatch', () => {
  it('adds image modality to text-only models', async () => {
    const llm = makeLlm();
    const restore = installImageModalityPatch(llm);
    const info = await llm.resolveModelInfo('deepseek', 'chat');
    expect(info.inputModalities).toContain('image');
    expect(info.inputModalities).toContain('text');
    restore();
  });
  it('restore returns the original method', async () => {
    const llm = makeLlm();
    const original = llm.resolveModelInfo;
    const restore = installImageModalityPatch(llm);
    restore();
    expect(llm.resolveModelInfo).toBe(original);
    const info = await llm.resolveModelInfo('deepseek', 'chat');
    expect(info.inputModalities).toEqual(['text']);
  });
  it('leaves already-vision models untouched', async () => {
    const llm = { resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text', 'image'] }) };
    const restore = installImageModalityPatch(llm);
    const info = await llm.resolveModelInfo('x', 'y');
    expect(info.inputModalities).toEqual(['text', 'image']);
    restore();
  });
  it('falls back to patching the prototype when instance assignment is rejected', async () => {
    // 简报要求两种补丁路径都覆盖:instance 赋值不可行(frozen)时走原型链
    const proto = {
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'] }),
    };
    const llm = Object.freeze(Object.create(proto));
    const original = llm.resolveModelInfo;
    const restore = installImageModalityPatch(llm);
    const info = await llm.resolveModelInfo('deepseek', 'chat');
    expect(info.inputModalities).toEqual(['text', 'image']);
    restore();
    expect(llm.resolveModelInfo).toBe(original);
    const after = await llm.resolveModelInfo('deepseek', 'chat');
    expect(after.inputModalities).toEqual(['text']);
  });
});
