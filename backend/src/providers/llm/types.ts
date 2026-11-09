/**
 * The contract every language-model provider sits behind.
 *
 * Business logic depends on this and nothing else: no module outside
 * `providers/llm` knows whether the answer came from OpenAI, Gemini, a local
 * model or the deterministic stand-in used in tests.
 */

export type LlmProviderKind = 'real' | 'mock';

export interface LlmModelConfig {
  /** Provider-specific model identifier, e.g. `gpt-4o-mini`. */
  readonly model: string;
  /** 0 for deterministic extraction work; higher only for free-form prose. */
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** Hard ceiling on one call, independent of any provider default. */
  readonly timeoutMs: number;
}

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/**
 * A tool the model may propose calling.
 *
 * "Propose" is the operative word: a tool call is a suggestion that the
 * backend validates and authorises. Nothing here reaches an executor on the
 * model's say-so.
 */
export interface LlmToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema describing the arguments. */
  readonly parameters: Record<string, unknown>;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Null when the provider does not report a price we can rely on. */
  readonly estimatedCostUsd: number | null;
}

export interface LlmCompletion {
  readonly text: string;
  readonly usage: LlmUsage;
  readonly model: string;
  readonly finishReason: 'stop' | 'length' | 'tool_call' | 'filtered' | 'other';
  /** Present when the model chose to call a tool rather than answer. */
  readonly toolCall?: { readonly name: string; readonly arguments: unknown };
}

export interface LlmCompletionRequest {
  readonly messages: readonly LlmMessage[];
  readonly config: LlmModelConfig;
  /** Ask the provider for strict JSON. Providers that cannot are wrapped. */
  readonly jsonMode?: boolean;
  readonly tools?: readonly LlmToolDefinition[];
  /** Aborts the call when the caller gives up first. */
  readonly signal?: AbortSignal;
}

export interface LlmProviderHealth {
  readonly id: string;
  readonly configured: boolean;
  readonly reachable: boolean | null;
  readonly checkedAt: string;
  readonly detail: string;
}

export interface LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: LlmProviderKind;
  /** False when no credential is present. The registry will not select it. */
  readonly configured: boolean;
  /** Defaults this provider is happy with; callers may override. */
  readonly defaultConfig: LlmModelConfig;

  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;

  /**
   * Optional. Embeddings are not used yet; a provider that cannot do them
   * simply omits this rather than throwing somewhere unexpected.
   */
  embed?(input: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;

  /** Cheap liveness probe. Must not throw. */
  health(): Promise<LlmProviderHealth>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
