import { codeForStatus, LlmError } from './errors';
import { withTimeout } from './reliability';
import { estimateUsage, mapFinish } from './openai.provider';
import type {
  LlmCompletion,
  LlmCompletionRequest,
  LlmModelConfig,
  LlmProvider,
  LlmProviderHealth,
} from './types';

interface GeminiPart { text?: string; functionCall?: { name?: string; args?: unknown } }
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Google Gemini, over plain `fetch`.
 *
 * Gemini's shape differs from OpenAI's in two ways this adapter absorbs:
 * the system instruction is a separate field rather than a message, and
 * roles are `user` / `model` rather than `user` / `assistant`. Both are
 * handled here so no caller has to know.
 */
export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini';
  readonly label = 'Google Gemini';
  readonly kind = 'real' as const;
  readonly defaultConfig: LlmModelConfig;

  constructor(
    private readonly apiKey: string | undefined,
    model: string,
    timeoutMs: number,
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  ) {
    this.defaultConfig = { model, temperature: 0, maxOutputTokens: 1024, timeoutMs };
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    if (!this.apiKey) {
      throw new LlmError('auth', this.id, 'GEMINI_API_KEY is not configured.');
    }

    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const turns = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const body: Record<string, unknown> = {
      contents: turns,
      generationConfig: {
        temperature: request.config.temperature,
        maxOutputTokens: request.config.maxOutputTokens,
        ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
      ...(system.length ? { systemInstruction: { parts: system.map((text) => ({ text })) } } : {}),
      ...(request.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                })),
              },
            ],
          }
        : {}),
    };

    const payload = await withTimeout(
      this.id,
      request.config.timeoutMs,
      async (signal) => {
        const url = `${this.baseUrl}/models/${encodeURIComponent(request.config.model)}:generateContent`;
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            // Header rather than a query parameter: a key in a URL ends up
            // in access logs and proxy traces.
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey! },
            body: JSON.stringify(body),
            signal,
          });
        } catch (cause) {
          throw new LlmError('unavailable', this.id, 'Could not reach Gemini.', { cause });
        }

        if (!response.ok) {
          const retryAfter = Number(response.headers.get('retry-after'));
          throw new LlmError(
            codeForStatus(response.status),
            this.id,
            `Gemini returned ${response.status}.`,
            {
              status: response.status,
              retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
            },
          );
        }

        return (await response.json()) as GeminiResponse;
      },
      request.signal,
    );

    const candidate = payload.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const call = parts.find((p) => p.functionCall)?.functionCall;

    return {
      text: parts.map((p) => p.text ?? '').join(''),
      model: request.config.model,
      finishReason: mapFinish(candidate?.finishReason),
      usage: estimateUsage(
        request.config.model,
        payload.usageMetadata?.promptTokenCount ?? 0,
        payload.usageMetadata?.candidatesTokenCount ?? 0,
      ),
      ...(call?.name ? { toolCall: { name: call.name, arguments: call.args ?? null } } : {}),
    };
  }

  async health(): Promise<LlmProviderHealth> {
    const base = { id: this.id, configured: this.configured, checkedAt: new Date().toISOString() };
    if (!this.configured) {
      return { ...base, reachable: null, detail: 'No API key configured.' };
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { 'x-goog-api-key': this.apiKey! },
        signal: AbortSignal.timeout(5_000),
      });
      return { ...base, reachable: response.ok, detail: `HTTP ${response.status}` };
    } catch {
      return { ...base, reachable: false, detail: 'Unreachable.' };
    }
  }
}
