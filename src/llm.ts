// Thin wrapper around the Anthropic SDK shared by the agents.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config } from "./config.js";

let client: Anthropic | undefined;
const getClient = () => (client ??= new Anthropic());

type Effort = "low" | "medium" | "high";

// Server-side fallbacks: if Claude's safety classifiers decline a request, the API
// re-runs it on Anthropic's recommended fallback model instead of returning a refusal.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Ask Claude for JSON matching `schema`. Throws if the model refuses or the output doesn't parse. */
export async function askStructured<T extends z.ZodType>(opts: {
  system: string;
  prompt: string;
  schema: T;
  effort?: Effort;
}): Promise<z.infer<T>> {
  const response = await getClient().beta.messages.parse({
    model: config.model,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(opts.schema) },
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined the request: ${response.stop_details?.explanation ?? "no details"}`);
  }
  if (response.parsed_output == null) {
    throw new Error(`Claude returned unparseable output (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}

/** Ask Claude for plain text. */
export async function askText(opts: { system: string; prompt: string; effort?: Effort }): Promise<string> {
  const response = await getClient().beta.messages.create({
    model: config.model,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    output_config: { effort: opts.effort ?? "low" },
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined the request: ${response.stop_details?.explanation ?? "no details"}`);
  }
  return response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}
