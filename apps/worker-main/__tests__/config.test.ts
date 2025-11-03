import { describe, expect, it } from 'vitest';
import { __internal } from '../index';

const { parsePromptVariables } = __internal;

describe('parsePromptVariables', () => {
  it('returns plain object values as-is', () => {
    const variables = { tone: 'friendly' };

    const result = parsePromptVariables(variables);

    expect(result).toBe(variables);
  });

  it('parses JSON strings into objects', () => {
    const result = parsePromptVariables('{"tone":"formal"}');

    expect(result).toStrictEqual({ tone: 'formal' });
  });
});
