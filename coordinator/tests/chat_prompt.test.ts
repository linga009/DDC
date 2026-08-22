import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptFromMessages } from "../src/chat_prompt.ts";

test("buildPromptFromMessages renders a single user message with a trailing Assistant: prompt", () => {
  const prompt = buildPromptFromMessages([{ role: "user", content: "What is the capital of France?" }]);
  assert.equal(prompt, "User: What is the capital of France?\nAssistant:");
});

test("buildPromptFromMessages renders a system message with its own System: label, not collapsed into Assistant:", () => {
  const prompt = buildPromptFromMessages([
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hi" },
  ]);
  assert.equal(prompt, "System: You are a helpful assistant.\nUser: Hi\nAssistant:");
});

test("buildPromptFromMessages renders a full system+user+assistant+user transcript in order", () => {
  const prompt = buildPromptFromMessages([
    { role: "system", content: "Be concise." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "How are you?" },
  ]);
  assert.equal(prompt, "System: Be concise.\nUser: Hi\nAssistant: Hello!\nUser: How are you?\nAssistant:");
});

test("buildPromptFromMessages on an empty messages array still produces a bare Assistant: prompt", () => {
  const prompt = buildPromptFromMessages([]);
  assert.equal(prompt, "Assistant:");
});
