/**
 * Seepient Gateway — Semantic Scorer
 *
 * Keyword-based relevance scoring for tool injection.
 * Zero dependencies, deterministic, fast.
 */

const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on',
  'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before',
  'after', 'and', 'but', 'or', 'not', 'no', 'so', 'if', 'then', 'than',
  'that', 'this', 'it', 'its', 'me', 'my', 'we', 'our', 'you', 'your',
  'he', 'she', 'they', 'them', 'what', 'which', 'who', 'when', 'where',
  'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just', 'about',
  'also', 'now', 'here', 'there', 'please', 'want', 'need', 'make',
  'send', 'get', 'use', 'help', 'show', 'tell', 'let', 'go', 'come',
  'take', 'give', 'try', 'ask', 'know', 'think', 'see', 'look',
]);

export function scoreRelevance(query: string, text: string): number {
  const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
  const target = text.toLowerCase();
  return words.reduce((score, word) => score + (target.includes(word) ? 1 : 0), 0);
}
