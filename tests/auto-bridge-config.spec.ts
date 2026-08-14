import { describe, expect, it } from 'vitest';
import { Config, resolveConfig } from '../lib/config.js';

describe('autoBridge config', () => {
  it('defaults to enabled with maxImagesPerMessage 4', () => {
    const resolved = resolveConfig({});
    expect(resolved.autoBridge).toEqual({ enabled: true, maxImagesPerMessage: 4 });
  });
  it('accepts explicit values', () => {
    const resolved = resolveConfig({ autoBridge: { enabled: false, maxImagesPerMessage: 2 } });
    expect(resolved.autoBridge).toEqual({ enabled: false, maxImagesPerMessage: 2 });
  });
  it('rejects out-of-range maxImagesPerMessage', () => {
    expect(() => resolveConfig({ autoBridge: { maxImagesPerMessage: 0 } })).toThrow();
    expect(() => resolveConfig({ autoBridge: { maxImagesPerMessage: 9 } })).toThrow();
  });
  it('schema default is applied by Config.parse', () => {
    const parsed = Config({});
    expect(parsed.autoBridge).toEqual({ enabled: true, maxImagesPerMessage: 4 });
  });
});
