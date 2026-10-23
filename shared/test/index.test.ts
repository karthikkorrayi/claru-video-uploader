import { describe, expect, it } from 'vitest';
import { CLARU_STATES, CONSENT_KEYS, ROLES } from '../src/index.js';

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
