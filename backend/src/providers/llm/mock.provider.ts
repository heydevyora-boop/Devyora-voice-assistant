import { LlmError } from './errors';
import { withTimeout } from './reliability';
import type {
  LlmCompletion,
  LlmCompletionRequest,
  LlmModelConfig,
  LlmProvider,
  LlmProviderHealth,
} from './types';

export interface MockScript {
  /** Matched against the transcript, case-insensitively. */
  readonly match: RegExp;
  /** Raw text the "model" returns. Invalid JSON is allowed, on purpose. */
  readonly output: string;
}

/**
 * A deterministic stand-in for a language model.
 *
 * It exists for two reasons. Tests need an LLM whose output is fixed, so a
 * failure means the pipeline is wrong rather than the weather at a vendor.
 * And no provider credential exists yet, so without this the assistant would
 * have nothing to talk to at all.
 *
 * It reports `kind: 'mock'`, and the orchestrator passes that through to the
 * response, so an answer produced here is never presented as the work of a
 * real model.
 *
 * Its matching is crude by design. This is not a fallback interpreter and
 * must not grow into one: anything it fails to match returns a null command,
 * which the pipeline reports as unsupported.
 */
export class MockLlmProvider implements LlmProvider {
  readonly id = 'mock';
  readonly label = 'Deterministic test model';
  readonly kind = 'mock' as const;
  readonly configured = true;
  readonly defaultConfig: LlmModelConfig = {
    model: 'mock-1',
    temperature: 0,
    maxOutputTokens: 1024,
    timeoutMs: 5_000,
  };

  /** Calls recorded for assertions. */
  readonly calls: LlmCompletionRequest[] = [];

  private scripts: MockScript[] = [];
  private failure: LlmError | null = null;
  private delayMs = 0;

  /** Queue an exact response for transcripts matching a pattern. */
  script(match: RegExp, output: string | object): this {
    this.scripts.push({
      match,
      output: typeof output === 'string' ? output : JSON.stringify(output),
    });
    return this;
  }

  /** Make the next calls fail, to exercise error handling. */
  failWith(error: LlmError | null): this {
    this.failure = error;
    return this;
  }

  /** Stall, to exercise the timeout. */
  stallFor(ms: number): this {
    this.delayMs = ms;
    return this;
  }

  reset(): this {
    this.scripts = [];
    this.failure = null;
    this.delayMs = 0;
    this.calls.length = 0;
    return this;
  }

  /**
   * Enforcing the configured deadline is part of the provider contract, so
   * the stand-in does it too. A mock that ignored `timeoutMs` would let a
   * timeout bug ship: the suite would wait patiently where production
   * would not.
   */
  complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    this.calls.push(request);

    if (this.failure) return Promise.reject(this.failure);

    return withTimeout(
      this.id,
      request.config.timeoutMs ?? this.defaultConfig.timeoutMs,
      (signal) => this.respond(request, signal),
      request.signal,
    );
  }

  private async respond(
    request: LlmCompletionRequest,
    signal: AbortSignal,
  ): Promise<LlmCompletion> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new LlmError('timeout', this.id, 'Aborted while stalling.'));
          },
          { once: true },
        );
      });
    }

    const transcript = request.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const matched = this.scripts.find((s) => s.match.test(transcript));

    const text =
      matched?.output ??
      JSON.stringify({
        command: null,
        confidence: 0,
        clarification: null,
        reply: 'No scripted response matched this input.',
        detectedLanguage: null,
      });

    return {
      text,
      model: request.config.model,
      finishReason: 'stop',
      usage: { inputTokens: transcript.length >> 2, outputTokens: text.length >> 2, estimatedCostUsd: 0 },
    };
  }

  health(): Promise<LlmProviderHealth> {
    return Promise.resolve({
      id: this.id,
      configured: true,
      reachable: true,
      checkedAt: new Date().toISOString(),
      detail: 'Deterministic stand-in. No network, no real model.',
    });
  }
}
