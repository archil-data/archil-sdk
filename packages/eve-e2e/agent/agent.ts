import { defineAgent } from "eve";
import { gateway } from "ai"

export default defineAgent({
  model: gateway(process.env.EVE_E2E_MODEL ?? "openai/gpt-5.4-nano"),
  reasoning: "low",
  modelContextWindowTokens: 400_000,
});
