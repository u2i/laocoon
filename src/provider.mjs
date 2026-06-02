// Resolves a "provider:model" string into a Vercel AI SDK LanguageModel.
//
// Supported provider prefixes:
//   google:<model>            -> @ai-sdk/google           (GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY)
//   anthropic:<model>         -> @ai-sdk/anthropic         (ANTHROPIC_API_KEY)
//   openai:<model>            -> @ai-sdk/openai            (OPENAI_API_KEY)
//   compatible:<model>        -> @ai-sdk/openai-compatible (LLM_API_KEY + LLM_BASE_URL)
//
// A bare model with no prefix defaults to google: (keeps old config working).
// The OpenAI-compatible provider covers OpenRouter, Together, Groq, the Vercel
// AI Gateway, local Ollama/llama.cpp, etc. via a configurable base URL.

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * @param {string} spec - "provider:model" or bare "model"
 * @param {object} env - process.env (injected for testability)
 * @returns {{ model: import("ai").LanguageModel, provider: string, modelId: string }}
 */
export function resolveModel(spec, env = process.env) {
  const { provider, modelId } = splitSpec(spec);

  switch (provider) {
    case "google": {
      const apiKey = env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY;
      requireKey(apiKey, "google", "GEMINI_API_KEY");
      return { model: createGoogleGenerativeAI({ apiKey })(modelId), provider, modelId };
    }
    case "anthropic": {
      const apiKey = env.ANTHROPIC_API_KEY;
      requireKey(apiKey, "anthropic", "ANTHROPIC_API_KEY");
      return { model: createAnthropic({ apiKey })(modelId), provider, modelId };
    }
    case "openai": {
      const apiKey = env.OPENAI_API_KEY;
      requireKey(apiKey, "openai", "OPENAI_API_KEY");
      return { model: createOpenAI({ apiKey })(modelId), provider, modelId };
    }
    case "compatible": {
      const apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY;
      const baseURL = env.LLM_BASE_URL;
      if (!baseURL) {
        throw new Error(
          `Provider "compatible" requires LLM_BASE_URL (e.g. https://openrouter.ai/api/v1).`
        );
      }
      const client = createOpenAICompatible({
        name: "compatible",
        baseURL,
        apiKey: apiKey || undefined,
      });
      return { model: client(modelId), provider, modelId };
    }
    default:
      throw new Error(
        `Unknown LLM provider "${provider}" in "${spec}". Use google:, anthropic:, openai:, or compatible:.`
      );
  }
}

function splitSpec(spec) {
  const s = String(spec || "").trim();
  const idx = s.indexOf(":");
  // A leading "word:" is treated as a provider prefix. If it's an unrecognized
  // word, error (a typo'd provider should fail loudly, not silently become a
  // google model). A spec with no such prefix defaults to google: for
  // back-compat with bare model ids like "gemini-3.5-flash".
  if (idx > 0 && /^[a-z][a-z0-9_-]*$/i.test(s.slice(0, idx))) {
    return { provider: s.slice(0, idx).toLowerCase(), modelId: s.slice(idx + 1) };
  }
  return { provider: "google", modelId: s };
}

function requireKey(key, provider, envName) {
  if (!key) {
    throw new Error(`Provider "${provider}" requires the ${envName} environment variable.`);
  }
}
