import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageAnalyzer } from '../lib/auto-bridge-analyze.js';

function fakeRuntime(glance) {
  return () => ({ glance });
}

describe('ImageAnalyzer', () => {
  it('writes bytes to a temp file and returns the glance answer', async () => {
    const analyzer = new ImageAnalyzer(fakeRuntime(async (request) => {
      expect(request.images).toHaveLength(1);
      expect(request.query).toBeUndefined();
      return { images: [{ path: request.images[0], width: 1, height: 1 }], mode: 'describe', answer: '一张截图', truncated: false };
    }));
    const outcome = await analyzer.analyze(new Uint8Array([1, 2, 3]), 'image/png', 'a.png');
    expect(outcome).toEqual({ ok: true, answer: '一张截图' });
  });
  it('degrades to ok:false with reason when glance throws', async () => {
    const analyzer = new ImageAnalyzer(fakeRuntime(async () => { throw new Error('rate limited'); }));
    const outcome = await analyzer.analyze(new Uint8Array([1]), 'image/png', undefined);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('rate limited');
  });
  it('cleans up its temp directory', async () => {
    const seen = [];
    const analyzer = new ImageAnalyzer(fakeRuntime(async (request) => {
      seen.push(request.images[0]);
      return { images: [], mode: 'describe', answer: 'ok', truncated: false };
    }));
    await analyzer.analyze(new Uint8Array([1]), 'image/png', 'a.png');
    // 临时文件已随目录删除
    const { access } = await import('node:fs/promises');
    await expect(access(seen[0])).rejects.toThrow();
  });
});
