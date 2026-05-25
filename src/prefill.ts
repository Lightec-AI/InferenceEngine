/**
 * KV prefill planning inside the engine process. See docs/kv-cache-prefill.md.
 */

export interface ConversationKvState {
  prefixHash: string;
  prefilledTokens: number;
}

export interface PrefillPlan {
  warmPrefixTokens: number;
  coldSuffixTokens: number;
}

export function planVllmPrefill(
  state: ConversationKvState | undefined,
  promptTokenCount: number,
  prefixHash: string,
): { plan: PrefillPlan; nextState: ConversationKvState } {
  const tokens = Math.max(0, promptTokenCount);
  if (!state || state.prefixHash !== prefixHash) {
    return {
      plan: { warmPrefixTokens: 0, coldSuffixTokens: tokens },
      nextState: { prefixHash, prefilledTokens: tokens },
    };
  }
  const warm = Math.min(state.prefilledTokens, tokens);
  const cold = tokens - warm;
  return {
    plan: { warmPrefixTokens: warm, coldSuffixTokens: cold },
    nextState: { prefixHash, prefilledTokens: tokens },
  };
}

export function conversationKvKey(conversationId: string, model: string): string {
  return `${conversationId}\0${model}`;
}
