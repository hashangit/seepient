import { describe, it, expect } from 'vitest';
import { countTokens, isCorrected } from '../tokenizer.js';

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('counts a simple phrase plausibly (OpenAI BPE)', () => {
    // "hello world" is a well-known 2-token sequence in GPT BPE
    expect(countTokens('hello world')).toBe(2);
  });

  it('scales with text length', () => {
    const short = countTokens('one word');
    const long = countTokens('this is a much longer sentence with many more words');
    expect(long).toBeGreaterThan(short);
  });

  it('handles code content', () => {
    const code = 'const x = (a, b) => a + b;';
    const tokens = countTokens(code);
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(50);
  });

  it('falls back gracefully on edge cases (does not throw)', () => {
    // Should not throw on any input
    expect(() => countTokens('🎉👶🏽')).not.toThrow();
    expect(() => countTokens('\x00\x01\x02')).not.toThrow();
  });

  it('applies correction factor for anthropic (×1.2)', () => {
    const base = countTokens('hello world this is a test'); // openai (factor 1.0)
    const corrected = countTokens('hello world this is a test', 'anthropic');
    expect(corrected).toBe(Math.ceil(base * 1.2));
    expect(corrected).toBeGreaterThan(base);
  });

  it('applies correction factor for glm (×1.15)', () => {
    const base = countTokens('hello world this is a test');
    const corrected = countTokens('hello world this is a test', 'glm');
    expect(corrected).toBe(Math.ceil(base * 1.15));
  });

  it('no correction for openai (factor 1.0)', () => {
    const base = countTokens('hello world this is a test');
    const openai = countTokens('hello world this is a test', 'openai');
    expect(openai).toBe(base);
  });
});

describe('isCorrected', () => {
  it('returns false for openai (exact BPE)', () => {
    expect(isCorrected('openai')).toBe(false);
  });

  it('returns false for openai-compatible', () => {
    expect(isCorrected('openai-compatible')).toBe(false);
  });

  it('returns true for anthropic (corrected)', () => {
    expect(isCorrected('anthropic')).toBe(true);
  });

  it('returns true for glm (corrected)', () => {
    expect(isCorrected('glm')).toBe(true);
  });

  it('returns true when undefined', () => {
    expect(isCorrected(undefined)).toBe(true);
  });
});
