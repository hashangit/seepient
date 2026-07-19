import { describe, it, expect } from 'vitest';
import { buildContextBreakdown } from '../context-breakdown.js';
import { countTokens } from '../tokenizer.js';
import type { Message } from '../types.js';
import type { ToolDefinition } from '../../tools/interface.js';

const sys = (content: string): Message => ({ id: 's1', role: 'system', content, timestamp: 0 });
const user = (content: string): Message => ({ id: 'u1', role: 'user', content, timestamp: 0 });
const asst = (content: string): Message => ({ id: 'a1', role: 'assistant', content, timestamp: 0 });
const toolResult = (content: string): Message => ({ id: 't1', role: 'tool', content, timestamp: 0, toolCallId: 'tc1' });

const tool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'echo',
    description: 'echo back the input',
    parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  },
};

describe('buildContextBreakdown', () => {
  it('produces 5 parts: System Prompt, Tools, Skills, Messages, Tool Results', () => {
    const b = buildContextBreakdown({
      messages: [sys('base prompt'), user('hi')],
      toolDefs: [tool],
      skillCatalog: '',
      model: 'test',
    });
    expect(b.parts).toHaveLength(5);
    expect(b.parts.map((p) => p.label)).toEqual(['System Prompt', 'Tools', 'Skills', 'Messages', 'Tool Results']);
  });

  it('total equals sum of all parts', () => {
    const b = buildContextBreakdown({
      messages: [sys('base prompt'), user('hello'), asst('world')],
      toolDefs: [tool],
      skillCatalog: 'AVAILABLE SKILLS\n- foo: bar',
      model: 'test',
    });
    const sum = b.parts.reduce((s, p) => s + p.tokens, 0);
    expect(b.total).toBe(sum);
    expect(b.total).toBeGreaterThan(0);
  });

  it('skills part is 0 when no catalog', () => {
    const b = buildContextBreakdown({
      messages: [sys('base'), user('hi')],
      toolDefs: [],
      skillCatalog: '',
      model: 'test',
    });
    const skills = b.parts.find((p) => p.label === 'Skills')!;
    expect(skills.tokens).toBe(0);
    expect(skills.detail).toBe('none loaded');
  });

  it('messages part is 0 when only a system message exists', () => {
    const b = buildContextBreakdown({
      messages: [sys('base')],
      toolDefs: [],
      skillCatalog: '',
      model: 'test',
    });
    const messages = b.parts.find((p) => p.label === 'Messages')!;
    expect(messages.tokens).toBe(0);
    expect(messages.detail).toBe('0 messages');
  });

  it('separates tool results from chat messages', () => {
    const b = buildContextBreakdown({
      messages: [sys('base'), user('read foo.txt'), asst('let me check'), toolResult('file contents here')],
      toolDefs: [],
      skillCatalog: '',
      model: 'test',
    });
    const messages = b.parts.find((p) => p.label === 'Messages')!;
    const toolResults = b.parts.find((p) => p.label === 'Tool Results')!;
    // Messages = user + assistant, NOT the tool result
    expect(messages.detail).toBe('2 messages');
    expect(messages.tokens).toBe(countTokens('read foo.txt') + countTokens('let me check'));
    // Tool Results separated
    expect(toolResults.detail).toBe('1 result');
    expect(toolResults.tokens).toBe(countTokens('file contents here'));
  });

  it('subtracts the catalog from the system prompt part', () => {
    const base = 'BASE PROMPT';
    const catalog = 'AVAILABLE SKILLS\n- foo: does a thing';
    const fullSystem = base + '\n\n' + catalog;
    const b = buildContextBreakdown({
      messages: [sys(fullSystem), user('hi')],
      toolDefs: [],
      skillCatalog: catalog,
      model: 'test',
    });
    const sysPart = b.parts.find((p) => p.label === 'System Prompt')!;
    const skillsPart = b.parts.find((p) => p.label === 'Skills')!;
    expect(sysPart.tokens).toBeLessThan(countTokens(fullSystem));
    expect(skillsPart.tokens).toBe(countTokens(catalog));
  });

  it('includes providerType when provided', () => {
    const b = buildContextBreakdown({
      messages: [sys('base')],
      toolDefs: [],
      skillCatalog: '',
      model: 'claude-test',
      providerType: 'anthropic',
    });
    expect(b.providerType).toBe('anthropic');
  });

  it('includes contextWindow when provided', () => {
    const b = buildContextBreakdown({
      messages: [sys('base')],
      toolDefs: [],
      skillCatalog: '',
      model: 'test',
      contextWindow: 200000,
    });
    expect(b.contextWindow).toBe(200000);
  });
});
