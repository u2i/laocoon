import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveModel } from "../src/provider.mjs";

const ENV = {
  GEMINI_API_KEY: "g",
  ANTHROPIC_API_KEY: "a",
  OPENAI_API_KEY: "o",
  LLM_API_KEY: "k",
  LLM_BASE_URL: "https://openrouter.ai/api/v1",
};

test("bare model defaults to the google provider", () => {
  const r = resolveModel("gemini-3.5-flash", ENV);
  assert.equal(r.provider, "google");
  assert.equal(r.modelId, "gemini-3.5-flash");
  assert.ok(r.model);
});

test("resolves each provider prefix", () => {
  assert.equal(resolveModel("google:gemini-3.1-flash-lite", ENV).provider, "google");
  assert.equal(resolveModel("anthropic:claude-sonnet-4-6", ENV).provider, "anthropic");
  assert.equal(resolveModel("openai:gpt-4o", ENV).provider, "openai");
  assert.equal(resolveModel("compatible:meta-llama/llama-3.1-70b", ENV).provider, "compatible");
});

test("keeps slashes in the model id (e.g. openrouter style)", () => {
  const r = resolveModel("compatible:meta-llama/llama-3.1-70b-instruct", ENV);
  assert.equal(r.modelId, "meta-llama/llama-3.1-70b-instruct");
});

test("falls back to google GOOGLE_GENERATIVE_AI_API_KEY", () => {
  const r = resolveModel("google:gemini-3.5-flash", { GOOGLE_GENERATIVE_AI_API_KEY: "x" });
  assert.equal(r.provider, "google");
});

test("errors clearly when the provider key is missing", () => {
  assert.throws(() => resolveModel("anthropic:claude", {}), /ANTHROPIC_API_KEY/);
  assert.throws(() => resolveModel("openai:gpt-4o", {}), /OPENAI_API_KEY/);
});

test("compatible provider requires a base URL", () => {
  assert.throws(() => resolveModel("compatible:foo", { LLM_API_KEY: "k" }), /LLM_BASE_URL/);
});

test("unknown provider prefix errors", () => {
  assert.throws(() => resolveModel("cohere:command-r", ENV), /Unknown LLM provider/);
});
