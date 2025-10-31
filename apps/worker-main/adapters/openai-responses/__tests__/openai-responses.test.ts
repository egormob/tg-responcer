import { describe, expect, it, vi } from 'vitest';

import type { AiPort } from '../../../ports';
import { createOpenAIResponsesAdapter } from '..';

const createFetchMock = () => vi.fn<Parameters<typeof fetch>, Promise<Response>>();

const createResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'x-request-id': 'req_123' },
    ...init,
  });

const createAssistantResponse = (model = 'gpt-4o-mini') =>
  new Response(JSON.stringify({ id: 'asst_123', model }), { status: 200 });

describe('createOpenAIResponsesAdapter', () => {
  const apiKey = 'test-key';
  const assistantId = 'asst_123';

  it('throws helpful error when assistant id is empty', () => {
    expect(() =>
      createOpenAIResponsesAdapter({
        apiKey,
        assistantId: '   ',
      }),
    ).toThrow('OPENAI_ASSISTANT_ID is required');
  });

  it('throws helpful error when assistant id does not start with asst_', () => {
    expect(() =>
      createOpenAIResponsesAdapter({
        apiKey,
        assistantId: 'gpt-4o-mini',
      }),
    ).toThrow('OPENAI_ASSISTANT_ID must start with "asst_" and refer to an OpenAI Responses assistant');
  });

  const createAdapter = (
    fetchMock: ReturnType<typeof createFetchMock>,
    options: Partial<{ timeout: number; maxRetries: number }> = {},
  ): AiPort =>
    createOpenAIResponsesAdapter({
      apiKey,
      assistantId,
      fetchApi: fetchMock,
      requestTimeoutMs: options.timeout ?? 5_000,
      maxRetries: options.maxRetries,
    });

  it('sends request with context and returns text', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(createAssistantResponse());
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
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.openai.com/v1/assistants/asst_123');
    expect(init?.method ?? 'GET').toBe('GET');

    const [postUrl, postInit] = fetchMock.mock.calls[1] ?? [];
    expect(postUrl).toBe('https://api.openai.com/v1/responses');
    expect(postInit?.method).toBe('POST');
    expect(postInit?.headers).toMatchObject({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    });

    const payload = JSON.parse((postInit?.body as string) ?? '{}');
    expect(payload).toMatchObject({
      assistant_id: assistantId,
      model: 'gpt-4o-mini',
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

    const userMessage = payload.input?.[2]?.content?.[0]?.text ?? '';
    expect(userMessage).toBe('How are you?');
    expect([...userMessage].map((char) => char.charCodeAt(0))).not.toContain(7);

    expect(payload.input).toHaveLength(3);
    const userEntries = payload.input.filter((item: { role: string }) => item.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.content?.[0]?.text).toBe('How are you?');
  });

  it('fetches assistant model once and reuses it for subsequent replies', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(createAssistantResponse('gpt-4o-mini')); // initial GET
    fetchMock
      .mockResolvedValueOnce(
        createResponse({
          id: 'resp_first',
          status: 'completed',
          output_text: 'First reply',
        }),
      )
      .mockResolvedValueOnce(
        createResponse({
          id: 'resp_second',
          status: 'completed',
          output_text: 'Second reply',
        }),
      );

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({ userId: 'u1', text: 'Ping', context: [] }),
    ).resolves.toMatchObject({ text: 'First reply' });

    await expect(
      adapter.reply({ userId: 'u1', text: 'Another', context: [] }),
    ).resolves.toMatchObject({ text: 'Second reply' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/assistants/asst_123');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://api.openai.com/v1/responses');
  });

  it('throws descriptive error when assistant model is missing', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'asst_123' }), { status: 200 }));

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({ userId: 'u', text: 'Ping', context: [] }),
    ).rejects.toThrow('OpenAI assistant model is missing');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('wraps assistant fetch failures with context', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 }),
    );

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({ userId: 'u', text: 'Ping', context: [] }),
    ).rejects.toThrow(/Failed to fetch OpenAI assistant configuration/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('extracts text when content uses nested value payload', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(createAssistantResponse());
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
      },
    });
  });

  it('prefers output_text when provided as a string', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(createAssistantResponse());
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
      },
    });
  });

  it('supports output_text provided as array of strings', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(createAssistantResponse());
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
      },
    });
  });

  it('combines plain and nested text fragments in order', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(createAssistantResponse());
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
    fetchMock.mockResolvedValueOnce(createAssistantResponse());
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries on network error', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(createAssistantResponse());
    fetchMock.mockRejectedValue(new TypeError('network down'));

    const adapter = createAdapter(fetchMock);

    await expect(
      adapter.reply({ userId: 'u', text: 'Ping', context: [] }),
    ).rejects.toThrow(/openai responses/i);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('throws when response output is empty', async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValueOnce(createAssistantResponse());
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
    fetchMock.mockResolvedValueOnce(createAssistantResponse());
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
        .mockImplementation((url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return Promise.resolve(createAssistantResponse());
          }

          const currentAttempt = attempt;
          attempt += 1;

          return new Promise<Response>((resolve, reject) => {
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
          });
        });

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
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
