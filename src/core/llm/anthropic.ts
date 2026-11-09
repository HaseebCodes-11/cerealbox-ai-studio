import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { DEFAULT_MODEL, estimateCostUsd } from "../cost";
import { resolveMaxOutputTokens, resolveModel, routingFromEnv, type RoutingEnv } from "./routing";
import { LLMOutputError, type LLMProvider, type LLMResult, type LLMTask } from "./provider";

/**
 * Production provider. Uses structured outputs so the model must return JSON
 * that matches the task schema, adaptive thinking with an effort level per
 * task, prompt caching on the stable system prompt, and the server-side
 * refusal fallback so a policy decline on the main model is retried on
 * Anthropic's default fallback inside the same call.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly routing: RoutingEnv;

  constructor(options: { model?: string; client?: Anthropic; routing?: RoutingEnv } = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    this.routing = options.routing ?? routingFromEnv();
  }

  async run<I, O>(task: LLMTask<I, O>, input: I): Promise<LLMResult<O>> {
    const started = Date.now();
    const model = resolveModel(task, this.routing, this.model);
    const response = await this.client.beta.messages.parse({
      model,
      max_tokens: resolveMaxOutputTokens(task),
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: task.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: task.prompt(input) }],
      output_config: {
        format: betaZodOutputFormat(task.schema),
        effort: task.effort ?? "medium",
      },
    });

    if (response.stop_reason === "refusal") {
      const explanation = response.stop_details?.type === "refusal" ? response.stop_details.explanation : undefined;
      throw new LLMOutputError(`Model declined task ${task.name}: ${explanation ?? "no explanation"}`, task.name);
    }
    if (response.stop_reason === "max_tokens") {
      throw new LLMOutputError(`Model output for ${task.name} was truncated (max_tokens)`, task.name);
    }
    const parsed = response.parsed_output;
    if (parsed === null || parsed === undefined) {
      throw new LLMOutputError(`Model output for ${task.name} could not be parsed`, task.name, response.content);
    }
    const validated = task.schema.safeParse(parsed);
    if (!validated.success) {
      throw new LLMOutputError(
        `Model output for ${task.name} failed schema validation: ${validated.error.message}`,
        task.name,
        parsed,
      );
    }
    const inputTokens =
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0);
    const outputTokens = response.usage.output_tokens;
    return {
      taskName: task.name,
      output: validated.data,
      usage: {
        provider: this.name,
        model: response.model,
        inputTokens,
        outputTokens,
        costUsd: estimateCostUsd(inputTokens, outputTokens, model),
        latencyMs: Date.now() - started,
      },
    };
  }
}
