import { describe, expect, it } from 'vitest';
import {
  CLARU_STATES,
  CONSENT_KEYS,
  FINGERPRINT_PATTERN,
  FINGERPRINT_SAMPLE_BYTES,
  fingerprintFromSamples,
  fingerprintRanges,
  ROLES,
} from '../src/index.js';

describe('shared constants', () => {
  it('has exactly the four Claru consent statements', () => {
    expect(CONSENT_KEYS).toHaveLength(4);
    expect(new Set(CONSENT_KEYS).size).toBe(4);
  });
  it('knows both roles', () => {
    expect(ROLES).toEqual(['admin', 'consultant']);
  });
  it('lists the seven Claru states', () => {
    expect(CLARU_STATES).toContain('refused');
    expect(CLARU_STATES).toContain('rejected');
    expect(CLARU_STATES).toHaveLength(7);
  });
});

describe('file fingerprint', () => {
  it('samples the first and last 4 MiB', () => {
    expect(fingerprintRanges(100)).toEqual({ head: [0, 100], tail: [0, 100] });
    const big = 4_000_000_000;
    expect(fingerprintRanges(big)).toEqual({ head: [0, FINGERPRINT_SAMPLE_BYTES], tail: [big - FINGERPRINT_SAMPLE_BYTES, big] });
  });

  it('changes when the size or a sampled byte changes', async () => {
    const head = new Uint8Array([1, 2, 3]);
    const tail = new Uint8Array([4, 5, 6]);
    const a = await fingerprintFromSamples(10, head, tail);
    expect(a).toMatch(FINGERPRINT_PATTERN);
    expect(await fingerprintFromSamples(10, head, tail)).toBe(a);
    expect(await fingerprintFromSamples(11, head, tail)).not.toBe(a);
    expect(await fingerprintFromSamples(10, head, new Uint8Array([4, 5, 7]))).not.toBe(a);
  });
});
