import { codeForStatus, LlmError } from './errors';
import { withTimeout } from './reliability';
import type {
  LlmCompletion,
  LlmCompletionRequest,
  LlmModelConfig,
  LlmProvider,
  LlmProviderHealth,
} from './types';

interface OpenAiChoice {
  message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
  finish_reason?: string;
}
interface OpenAiResponse {
  model?: string;
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Per-million-token prices, used only for an estimate.
 *
 * Deliberately a small table rather than a lookup against anything live:
 * vendor pricing changes without notice, so an unknown model yields `null`
 * instead of a figure that might be wrong. A wrong number in a cost report
 * is worse than no number.
 */
const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
};

/**
 * OpenAI chat completions, over plain `fetch`.
 *
 * No vendor SDK: the surface used here is one HTTP endpoint, and a
 * dependency would add weight without removing the mapping work that makes
 * up most of this file.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai';
  readonly label = 'OpenAI';
  readonly kind = 'real' as const;
  readonly defaultConfig: LlmModelConfig;

  constructor(
    private readonly apiKey: string | undefined,
    model: string,
    timeoutMs: number,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {
    this.defaultConfig = { model, temperature: 0, maxOutputTokens: 1024, timeoutMs };
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    if (!this.apiKey) {
      throw new LlmError('auth', this.id, 'OPENAI_API_KEY is not configured.');
    }

    const body: Record<string, unknown> = {
      model: request.config.model,
      temperature: request.config.temperature,
      max_tokens: request.config.maxOutputTokens,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (request.jsonMode) body.response_format = { type: 'json_object' };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const payload = await withTimeout(
      this.id,
      request.config.timeoutMs,
      async (signal) => {
        let response: Response;
        try {
          response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
          });
        } catch (cause) {
          throw new LlmError('unavailable', this.id, 'Could not reach OpenAI.', { cause });
        }

        if (!response.ok) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const detail = await safeText(response);
          throw new LlmError(
            codeForStatus(response.status),
            this.id,
            `OpenAI returned ${response.status}.`,
            {
              status: response.status,
              retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
              // The body can echo prompt content, so it is attached as a
              // cause for the log rather than placed in the message.
              cause: detail,
            },
          );
        }

        return (await response.json()) as OpenAiResponse;
      },
      request.signal,
    );

    const choice = payload.choices?.[0];
    const call = choice?.message?.tool_calls?.[0]?.function;

    return {
      text: choice?.message?.content ?? '',
      model: payload.model ?? request.config.model,
      finishReason: mapFinish(choice?.finish_reason),
      usage: estimateUsage(
        payload.model ?? request.config.model,
        payload.usage?.prompt_tokens ?? 0,
        payload.usage?.completion_tokens ?? 0,
      ),
      ...(call?.name
        ? { toolCall: { name: call.name, arguments: parseJsonOrNull(call.arguments) } }
        : {}),
    };
  }

  async health(): Promise<LlmProviderHealth> {
    const base = { id: this.id, configured: this.configured, checkedAt: new Date().toISOString() };
    if (!this.configured) {
      return { ...base, reachable: null, detail: 'No API key configured.' };
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      return { ...base, reachable: response.ok, detail: `HTTP ${response.status}` };
    } catch {
      return { ...base, reachable: false, detail: 'Unreachable.' };
    }
  }
}

export function estimateUsage(model: string, inputTokens: number, outputTokens: number) {
  const price = PRICE_PER_MILLION[model];
  return {
    inputTokens,
    outputTokens,
    // Null, not zero: "unknown" and "free" are different things.
    estimatedCostUsd: price
      ? (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output
      : null,
  };
}

export function mapFinish(reason: string | undefined): LlmCompletion['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
    case 'MAX_TOKENS':
      return 'length';
    case 'tool_calls':
      return 'tool_call';
    case 'content_filter':
    case 'SAFETY':
      return 'filtered';
    default:
      return 'other';
  }
}

export function parseJsonOrNull(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
