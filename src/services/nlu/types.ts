import type { ProviderInfo } from '../types';
import type { CommandPlan } from '../actions/types';

export interface ClarificationOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  /** When chosen, this value replaces the named field on the draft plan. */
  readonly value?: string;
  /** Options that need the user to type something instead of picking. */
  readonly prompt?: string;
}

export interface Clarification {
  readonly question: string;
  readonly reason: string;
  /** Field on `draft` that the answer fills in. */
  readonly field: string;
  readonly options: readonly ClarificationOption[];
  readonly draft: CommandPlan;
}

export type InterpretResult =
  | { readonly type: 'plan'; readonly plan: CommandPlan }
  | { readonly type: 'clarify'; readonly clarification: Clarification }
  | { readonly type: 'unsupported'; readonly heard: string; readonly reason: string };

export interface CommandInterpreter {
  readonly info: ProviderInfo;
  interpret: (text: string) => Promise<InterpretResult>;
}
