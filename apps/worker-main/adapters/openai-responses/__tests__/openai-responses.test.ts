import { describe, expect, it, vi } from 'vitest';

import type { AiPort, ConversationTurn } from '../../../ports';
import { createOpenAIResponsesAdapter } from '..';

const createFetchMock = () => vi.fn<Parameters<typeof fetch>, Promise<Response>>();

const createResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'x-request-id': 'req_123' },
    ...init,
  });

describe('createOpenAIResponsesAdapter', () => {
  const apiKey = 'test-key';
  const model = 'gpt-4o-mini';

  const createAdapter = (
    fetchMock: ReturnType<typeof createFetchMock>,
    options: Partial<{
      timeout: number;
      maxRetries: number;
      promptId: string;
      promptVariables: Record<string, unknown>;
      runtime: {
        maxConcurrency: number;
        maxQueueSize: number;
        requestTimeoutMs: number;
        retryMax: number;
      };
    }> = {},
  ): AiPort =>
    createOpenAIResponsesAdapter({
      apiKey,
      model,
      fetchApi: fetchMock,
      requestTimeoutMs: options.timeout ?? 5_000,
      maxRetries: options.maxRetries,
      promptId: options.promptId,
      promptVariables: options.promptVariables,
      runtime: {
        maxConcurrency: options.runtime?.maxConcurrency ?? 2,
        maxQueueSize: options.runtime?.maxQueueSize ?? 8,
        requestTimeoutMs: options.runtime?.requestTimeoutMs ?? options.timeout ?? 5_000,
        retryMax: options.runtime?.retryMax ?? options.maxRetries ?? 3,
      },
    });

  it('throws helpful error when model is empty', () => {
    expect(() =>
      createOpenAIResponsesAdapter({
        apiKey,
        model: '   ',
      }),
    ).toThrow('OPENAI_MODEL is required');
  });

  it('throws helpful error when prompt id does not start with pmpt_', () => {
    expect(() =>
      createOpenAIResponsesAdapter({
        apiKey,
        model,
        promptId: 'prompt-123',
      }),
    ).toThrow('OPENAI_PROMPT_ID must start with "pmpt_" and refer to a published OpenAI prompt');
  });

  it('throws helpful error when prompt variables are not a plain object', () => {
    expect(() =>
      createOpenAIResponsesAdapter({
        apiKey,
        model,
        promptVariables: [] as unknown as Record<string, unknown>,
      }),
    ).toThrow('OPENAI_PROMPT_VARIABLES must be a JSON object');
  });

  it('sends request with context and returns text', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      createResponse({
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Hello there!' },
            ],
          },
        ],
      }),
    );

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({
        userId: 'user-1',
        text: 'How are you?\u0007',
        context: [
          { role: 'system', text: 'You are helpful.' },
          { role: 'assistant', text: 'Hi!' },
        ],
      }),
    ).resolves.toEqual({
      text: 'Hello there!',
      metadata: {
        responseId: 'resp_1',
        status: 'completed',
        requestId: 'req_123',
        usedOutputText: false,
        previousResponseId: undefined,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [postUrl, postInit] = fetchMock.mock.calls[0] ?? [];
    expect(postUrl).toBe('https://api.openai.com/v1/responses');
    expect(postInit?.method).toBe('POST');
    expect(postInit?.headers).toMatchObject({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });

    const payload = JSON.parse((postInit?.body as string) ?? '{}');
    expect(payload).toMatchObject({
      model,
      metadata: { userId: 'user-1' },
      input: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'You are helpful.' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hi!' }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'How are you?' }],
        },
      ],
    });

    expect(payload.prompt).toBeUndefined();

    const userMessage = payload.input?.[2]?.content?.[0]?.text ?? '';
    expect(userMessage).toBe('How are you?');
    expect([...userMessage].map((char) => char.charCodeAt(0))).not.toContain(7);
  });

  it('includes prompt block when prompt id and variables are provided', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      createResponse({
        id: 'resp_prompt',
        status: 'completed',
        output_text: 'Prompt reply',
      }),
    );

    const adapter = createAdapter(fetchMock, {
      promptId: 'pmpt_12345',
      promptVariables: { tone: 'friendly' },
    });

    await expect(
      adapter.reply({ userId: 'user', text: 'Ping', context: [] }),
    ).resolves.toMatchObject({ text: 'Prompt reply' });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const payload = JSON.parse((init?.body as string) ?? '{}');
    expect(payload.prompt).toEqual({ id: 'pmpt_12345', variables: { tone: 'friendly' } });
  });

  it('passes previous_response_id when context metadata includes responseId', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      createResponse({
        id: 'resp_followup',
        status: 'completed',
        output_text: 'Follow-up reply',
      }),
    );

    const adapter = createAdapter(fetchMock);

    const previousTurn = {
      role: 'assistant',
      text: 'Earlier reply',
      metadata: { responseId: 'resp_prev' },
    } as unknown as ConversationTurn;

    await expect(
      adapter.reply({
        userId: 'user',
        text: 'Continue',
        context: [previousTurn],
      }),
    ).resolves.toEqual({
      text: 'Follow-up reply',
      metadata: {
        responseId: 'resp_followup',
        status: 'completed',
        requestId: 'req_123',
        usedOutputText: true,
        previousResponseId: 'resp_prev',
      },
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const payload = JSON.parse((init?.body as string) ?? '{}');
    expect(payload.previous_response_id).toBe('resp_prev');
  });

  it('extracts text when content uses nested value payload', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      createResponse({
        id: 'resp_nested',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: { value: 'Nested hello!' } },
            ],
          },
        ],
      }),
    );

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({
        userId: 'user-2',
        text: 'Hi?',
        context: [],
      }),
    ).resolves.toEqual({
      text: 'Nested hello!',
      metadata: {
        responseId: 'resp_nested',
        status: 'completed',
        requestId: 'req_123',
        usedOutputText: false,
        previousResponseId: undefined,
      },
    });
  });

  it('prefers output_text when provided as a string', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      createResponse({
        id: 'resp_output_text',
        status: 'completed',
        output_text: 'Hello via shortcut',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Ignored fallback' },
            ],
          },
        ],
      }),
    );

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({ userId: 'u', text: 'Ping', context: [] }),
    ).resolves.toEqual({
      text: 'Hello via shortcut',
      metadata: {
        responseId: 'resp_output_text',
        status: 'completed',
        requestId: 'req_123',
        usedOutputText: true,
        previousResponseId: undefined,
      },
    });
  });

  it('supports output_text provided as array of strings', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      createResponse({
        id: 'resp_output_text_array',
        status: 'completed',
        output_text: ['First', 'Second'],
      }),
    );

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({ userId: 'u', text: 'Ping', context: [] }),
    ).resolves.toEqual({
      text: 'First\nSecond',
      metadata: {
        responseId: 'resp_output_text_array',
        status: 'completed',
        requestId: 'req_123',
        usedOutputText: true,
        previousResponseId: undefined,
      },
    });
  });

  it('combines plain and nested text fragments in order', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      createResponse({
        id: 'resp_mixed',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'First part' },
              { type: 'output_text', text: { value: 'Second part' } },
              { type: 'output_text', text: '   ' },
            ],
          },
        ],
      }),
    );

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({
        userId: 'user-3',
        text: 'Ping',
        context: [],
      }),
    ).resolves.toMatchObject({
      text: 'First part\nSecond part',
      metadata: expect.objectContaining({ usedOutputText: false }),
    });
  });

  it('retries on retryable errors and succeeds', async () => {
    const fetchMock = createFetchMock();
    fetchMock
      .mockResolvedValueOnce(
        createResponse(
          { error: { message: 'rate limit' } },
          { status: 429, headers: { 'x-request-id': 'req_1' } },
        ),
      )
      .mockResolvedValueOnce(
        createResponse({
          id: 'resp_success',
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
          ],
        }),
      );

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({
        userId: 'u',
        text: 'Ping',
        context: [],
      }),
    ).resolves.toMatchObject({ text: 'Done' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on network error', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockRejectedValue(new TypeError('network down'));

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({ userId: 'u', text: 'Ping', context: [] }),
    ).rejects.toThrow(/openai responses/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws when response output is empty', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      createResponse({ id: 'resp', status: 'completed', output: [] }),
    );

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({ userId: 'u', text: 'Ping', context: [] }),
    ).rejects.toThrow('AI_EMPTY_REPLY');
  });

  it('throws AI_NON_2XX when non-retryable response persists', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'bad request' } }), {
        status: 400,
        headers: { 'x-request-id': 'req_bad' },
      }),
    );

    const adapter = createAdapter(fetchMock, { maxRetries: 1 });

    await expect(
      adapter.reply({ userId: 'u', text: 'Ping', context: [] }),
    ).rejects.toThrow('AI_NON_2XX');
  });

  it('aborts when retries exhaust the global timeout budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    try {
      let attempt = 0;
      const fetchMock = vi
        .fn<Parameters<typeof fetch>, Promise<Response>>()
        .mockImplementation((url, init) =>
          new Promise<Response>((resolve, reject) => {
            const currentAttempt = attempt;
            attempt += 1;

            const timer = setTimeout(() => {
              if (currentAttempt < 2) {
                resolve(
                  createResponse(
                    { error: { message: 'rate limit' } },
                    { status: 429, headers: { 'x-request-id': `req_${currentAttempt}` } },
                  ),
                );
                return;
              }

              resolve(
                createResponse({
                  id: 'resp_success',
                  status: 'completed',
                  output: [
                    { type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
                  ],
                }),
              );
            }, 500);

            init?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              const abortError = new Error('Aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }),
        );

      const adapter = createAdapter(fetchMock, { timeout: 1_200, maxRetries: 3 });

      const replyPromise = adapter.reply({ userId: 'u', text: 'Ping', context: [] });
      replyPromise.catch(() => {
        // prevent unhandled rejection warnings in Node while the expectation attaches
      });
      const expectation = expect(replyPromise).rejects.toThrow(/timed out/i);

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(200);

      await expectation;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
