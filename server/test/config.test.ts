import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from '../src/config.js';

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/claru_dev',
  SESSION_SECRET: 'x'.repeat(40),
  WORK_DIR: '/tmp/cvu/work',
  TUS_DIR: '/tmp/cvu/tus',
  CLARU_BASE_URL: 'http://127.0.0.1:4010/api/v1',
  CLARU_API_KEY: 'mock-claru-key',
  GRAPH_BASE_URL: 'http://127.0.0.1:4020/v1.0',
};

describe('configuration', () => {
  it('accepts a complete development config', () => {
    expect(loadConfig(valid).PORT).toBe(8080);
  });

  it('rejects a short session secret', () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('refuses real Claru outside production unless explicitly allowed', () => {
    const real = { ...valid, CLARU_BASE_URL: 'https://app.claru.ai/api/v1' };
    expect(() => loadConfig(real)).toThrow(/ALLOW_REAL_CLARU/);
    expect(loadConfig({ ...real, ALLOW_REAL_CLARU: 'yes' }).CLARU_BASE_URL).toContain('app.claru.ai');
  });

  it('uses Claru\'s clip rules by default and refuses rules that cannot be split evenly', () => {
    const c = loadConfig(valid);
    expect([c.CLIP_MIN_SECONDS, c.CLIP_MAX_SECONDS, c.CAPTURE_ASPECT]).toEqual([300, 1800, '4_3']);
    expect(() => loadConfig({ ...valid, CLIP_MIN_SECONDS: '1000', CLIP_MAX_SECONDS: '1800' })).toThrow(/CLIP_MAX_SECONDS/);
  });

  it('never exposes secrets when logged', () => {
    const text = JSON.stringify(describeConfig(loadConfig(valid)));
    expect(text).not.toContain('secret@');
    expect(text).not.toContain('mock-claru-key');
    expect(text).not.toContain('x'.repeat(40));
  });
});
