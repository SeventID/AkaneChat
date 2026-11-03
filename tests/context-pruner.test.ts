import { describe, expect, test } from "bun:test";
import { pruneContext } from "../src/context-pruner";

describe("context pruner", () => {
  test("keeps system prompt and recent messages", () => {
    const messages = [
      { role: "system", content: "Always be accurate." },
      ...Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message-${index}` })),
    ];
    const result = pruneContext(messages, { keepRecentMessages: 4 });
    expect(result[0]?.content).toBe("Always be accurate.");
    expect(result.at(-1)?.content).toBe("message-13");
    expect(result.some((item) => item.content === "message-0")).toBe(false);
    expect(result.some((item) => item.content?.includes("message-0"))).toBe(true);
  });

  test("does not split assistant tool calls from tool results", () => {
    const messages = [
      { role: "user", content: "old" },
      { role: "assistant", content: null, tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: "result a" },
      { role: "tool", tool_call_id: "b", content: "result b" },
      { role: "user", content: "latest" },
    ];
    const result = pruneContext(messages, { keepRecentMessages: 2 });
    const assistant = result.find((item) => item.tool_calls?.length);
    expect(assistant).toBeDefined();
    expect(result.some((item) => item.tool_call_id === "a")).toBe(true);
    expect(result.some((item) => item.tool_call_id === "b")).toBe(true);
    expect(result.at(-1)?.content).toBe("latest");
  });

  test("redacts common credentials in generated summary", () => {
    const messages = [
      { role: "user", content: `token: abcdefghijklmnop and sk-12345678901234567890` },
      ...Array.from({ length: 12 }, (_, index) => ({ role: "user", content: `new-${index}` })),
    ];
    const result = pruneContext(messages, { keepRecentMessages: 4 });
    const summary = result.find((item) => item.content?.includes("Earlier conversation summary"))?.content ?? "";
    expect(summary).toContain("[REDACTED]");
    expect(summary).not.toContain("abcdefghijklmnop");
    expect(summary).not.toContain("sk-12345678901234567890");
  });

  test("does not mutate original messages", () => {
    const messages = Array.from({ length: 14 }, (_, index) => ({ role: "user", content: `item-${index}` }));
    const before = structuredClone(messages);
    pruneContext(messages);
    expect(messages).toEqual(before);
  });
});
