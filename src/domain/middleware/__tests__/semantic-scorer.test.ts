import { describe, it, expect } from 'vitest';
import { scoreRelevance } from '../semantic-scorer.js';

describe('scoreRelevance', () => {
  it('returns 0 for no word matches', () => {
    expect(scoreRelevance('hello world', 'database query sql')).toBe(0);
  });

  it('returns positive score for matching words', () => {
    const score = scoreRelevance('query the database', 'postgres_prod__query database tool');
    expect(score).toBeGreaterThan(0);
  });

  it('filters single-character words', () => {
    expect(scoreRelevance('a b c', 'abc')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(scoreRelevance('DATABASE', 'database')).toBe(1);
  });

  it('scores multiple matching words', () => {
    const score = scoreRelevance('send email notification', 'email notification sender tool');
    expect(score).toBeGreaterThanOrEqual(2);
  });
});
