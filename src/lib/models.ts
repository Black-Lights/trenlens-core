/**
 * Provider + model registry — the single source of truth shared by the BYOK
 * panel (key entry + model picker) and the conversational orchestrator.
 *
 * `cost` is a RELATIVE badge using Anthropic Sonnet as the 1× baseline; it's a
 * rough planning hint for the UI, not a billing figure. Only providers with
 * `chat: true` participate in the conversational loop (`submit_chat_message`);
 * the others (ideogram, openai, …) are still selectable for BYOK key storage.
 */

export interface ModelOption {
  /** Exact id sent to the provider API (e.g. `deepseek-v4-pro`). */
  id: string;
  /** Human label shown in the dropdown. */
  label: string;
  /** Relative cost badge vs. Anthropic Sonnet (1×). */
  cost: string;
}

export interface ProviderDef {
  id: string;
  label: string;
  /** True → routable by the orchestrator (has chat models). */
  chat: boolean;
  models: ModelOption[];
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    chat: true,
    // Current Claude family (Sonnet 4.6 = the 1× cost baseline).
    models: [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', cost: '1×' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', cost: '~5×' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', cost: '~0.3×' },
    ],
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    chat: true,
    models: [
      { id: 'kimi-k2.5', label: 'kimi-k2.5', cost: '~0.2×' },
      { id: 'kimi-k2.6', label: 'kimi-k2.6', cost: '~0.3×' },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    chat: true,
    models: [
      { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', cost: '~0.02×' },
      { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', cost: '~0.15×' },
    ],
  },
  // Non-chat providers — selectable for BYOK key storage only.
  { id: 'openai', label: 'OpenAI', chat: false, models: [] },
  { id: 'ideogram', label: 'Ideogram', chat: false, models: [] },
  { id: 'openrouter', label: 'OpenRouter', chat: false, models: [] },
  { id: 'custom', label: 'custom', chat: false, models: [] },
];

/** The default active chat provider/model when nothing is persisted yet. */
export const DEFAULT_PROVIDER = PROVIDERS[0].id; // anthropic
export const DEFAULT_MODEL = PROVIDERS[0].models[0].id; // claude-3-5-sonnet-latest

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** The model list for a provider (empty for non-chat providers). */
export function modelsFor(providerId: string): ModelOption[] {
  return providerDef(providerId)?.models ?? [];
}

/** The cost badge for a (provider, model) pair, or undefined if not chat-capable. */
export function costFor(providerId: string, modelId: string): string | undefined {
  return modelsFor(providerId).find((m) => m.id === modelId)?.cost;
}

/** Whether a provider participates in the conversational orchestrator. */
export function isChatProvider(providerId: string): boolean {
  return providerDef(providerId)?.chat ?? false;
}
