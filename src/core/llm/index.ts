import { MockProvider } from "./mock";
import type { LLMProvider } from "./provider";

export * from "./provider";
export { MockProvider, stableStringify } from "./mock";
export * from "./routing";

/**
 * Pick the provider from the environment. Defaults to the deterministic mock
 * so the repo works with no keys; set LLM_PROVIDER=anthropic to use Claude.
 * The Anthropic adapter is loaded lazily so the mock path never touches the SDK.
 */
export async function getProvider(env: NodeJS.ProcessEnv = process.env): Promise<LLMProvider> {
  const choice = (env.LLM_PROVIDER ?? "mock").toLowerCase();
  if (choice === "anthropic") {
    const { AnthropicProvider } = await import("./anthropic");
    return new AnthropicProvider({ model: env.ANTHROPIC_MODEL });
  }
  if (choice !== "mock") {
    throw new Error(`Unknown LLM_PROVIDER "${choice}". Use "mock" or "anthropic".`);
  }
  return new MockProvider({ seed: env.MOCK_SEED, pricingModel: env.ANTHROPIC_MODEL });
}
