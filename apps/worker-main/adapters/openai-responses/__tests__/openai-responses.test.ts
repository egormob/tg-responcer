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

describe('createOpenAIResponsesAdapter', () => {
  const apiKey = 'test-key';
  const assistantId = 'asst_123';

  const createAdapter = (fetchMock: ReturnType<typeof createFetchMock>): AiPort =>
    createOpenAIResponsesAdapter({
      apiKey,
      assistantId,
      fetchApi: fetchMock,
      requestTimeoutMs: 5_000,
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
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    });

    const payload = JSON.parse((init?.body as string) ?? '{}');
    expect(payload).toMatchObject({
      assistant_id: assistantId,
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
    ).rejects.toThrow(/empty output/i);
  });
});
