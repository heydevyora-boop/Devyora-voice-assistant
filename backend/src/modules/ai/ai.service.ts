import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.module';
import { LlmError } from '../../providers/llm/errors';
import { DEFAULT_RETRY, withRetry } from '../../providers/llm/reliability';
import { LlmRegistry } from '../../providers/llm/llm.module';
import type { LlmMessage, LlmUsage } from '../../providers/llm/types';
import { buildSystemPrompt, wrapTranscript } from './prompts/system-prompt';
import {
  MODEL_OUTPUT_JSON_SCHEMA,
  modelOutputSchema,
  type Command,
  type ModelOutput,
} from './schemas/command.schema';

export interface InterpretContext {
  readonly nowIso: string;
  readonly timezone: string;
  readonly locale: string;
  readonly hasContactDirectory: boolean;
  /** Earlier turns, oldest first. Already scoped to one user's conversation. */
  readonly history: readonly { role: 'user' | 'assistant'; content: string }[];
  /**
   * The request this turn is answering, when the user is replying to a
   * clarification. Stated explicitly rather than left to the history
   * window, which is bounded and may no longer contain the original ask.
   */
  readonly resuming?: { readonly request: string; readonly field: string | null } | null;
}

export interface InterpretResult {
  readonly output: ModelOutput;
  readonly usage: LlmUsage;
  readonly providerId: string;
  /** True when the answer came from the deterministic stand-in. */
  readonly isMock: boolean;
  readonly model: string;
  readonly latencyMs: number;
}

/**
 * Turns a transcript into a validated proposal.
 *
 * It does exactly three things: assemble context, ask a provider, and
 * validate the answer against the schema. It does not decide permissions,
 * does not create actions, and does not execute anything — those belong to
 * the orchestrator and to the policy table, where they can be reasoned
 * about without a model in the loop.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly registry: LlmRegistry,
    private readonly config: AppConfigService,
  ) {}

  async interpret(transcript: string, context: InterpretContext): Promise<InterpretResult> {
    const provider = this.registry.active();
    const settings = this.config.providers.ai;
    const startedAt = Date.now();

    // Randomised per request, so text inside the transcript cannot close the
    // block by guessing the delimiter.
    const nonce = randomUUID().slice(0, 8);

    const messages: LlmMessage[] = [
      { role: 'system', content: buildSystemPrompt(context) },
      ...context.history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: wrapTranscript(transcript, nonce) },
    ];

    const completion = await withRetry(
      { ...DEFAULT_RETRY, maxAttempts: settings.maxAttempts },
      // Generating a completion is a read: a discarded attempt leaves
      // nothing behind, so repeating it is safe. Nothing that writes, sends
      // or charges a third party is retried here.
      (attempt) => {
        if (attempt > 1) this.logger.warn(`Re-asking ${provider.id} (attempt ${attempt})`);
        return provider.complete({
          messages,
          config: { ...provider.defaultConfig, timeoutMs: settings.timeoutMs },
          jsonMode: true,
          tools: [
            {
              name: 'emit_command',
              description: 'Return the structured interpretation of the transcript.',
              parameters: MODEL_OUTPUT_JSON_SCHEMA,
            },
          ],
        });
      },
    );

    const output = this.parseAndValidate(completion.text, completion.toolCall?.arguments, provider.id);

    return {
      output,
      usage: completion.usage,
      providerId: provider.id,
      isMock: provider.kind === 'mock',
      model: completion.model,
      latencyMs: Date.now() - startedAt,
    };
  }

  /**
   * Parses the model's answer and holds it to the schema.
   *
   * An answer that does not validate is discarded rather than patched up.
   * Coercing a malformed response into something usable is how a model's
   * mistake becomes an action nobody intended, so the turn fails instead and
   * the user is told the request could not be understood.
   */
  private parseAndValidate(text: string, toolArguments: unknown, providerId: string): ModelOutput {
    const candidate = toolArguments ?? extractJson(text);

    if (candidate === null) {
      throw new LlmError('invalid_output', providerId, 'The model did not return JSON.');
    }

    const parsed = modelOutputSchema.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      // The offending payload is not logged: it contains the transcript.
      this.logger.warn(`Rejected model output from ${providerId} — ${issues}`);
      throw new LlmError('invalid_output', providerId, 'The model returned an unusable answer.');
    }

    return parsed.data;
  }

  /** Which entities the policy requires are present and non-null. */
  static missingEntities(command: Command, required: readonly string[]): string[] {
    const entities = command.entities as Record<string, unknown>;
    return required.filter((key) => {
      const value = entities[key];
      return value === undefined || value === null || value === '';
    });
  }
}

/**
 * Pulls a JSON object out of a response.
 *
 * Models wrap JSON in prose or code fences even when asked not to, so the
 * first balanced object is extracted rather than requiring a clean body.
 * This is lenient about packaging only — the contents still face the schema.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    const inner = tryParse(fenced[1].trim());
    if (inner !== undefined) return inner;
  }

  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const parsed = tryParse(trimmed.slice(start, i + 1));
        return parsed === undefined ? null : parsed;
      }
    }
  }
  return null;
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
