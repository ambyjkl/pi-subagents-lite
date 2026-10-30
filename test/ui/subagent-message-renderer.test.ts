import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { shellMock } from "../fixtures.js";
import { registerAgents } from "../../src/agents/agent-types.js";
import { DEFAULT_AGENTS } from "../../src/agents/default-agents.js";
import { renderSubagentMessage } from "../../src/ui/renderer.js";
import type { Theme } from "../../src/ui/types.js";

vi.mock("../../src/shell.js", () => shellMock({ store: { agent: { showAgentColors: false } } }));

const theme: Theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

const details = {
  sender: "general-purpose#97a7e0e6",
  type: "general-purpose",
  description: "Add cancellable build subprocess scopes",
  modelName: "GPT-6.1 Terra",
  modelId: "gpt-6.1-terra",
  thinkingLevel: "high",
};

function render(message: Parameters<typeof renderSubagentMessage>[0], width = 100): string[] {
  return renderSubagentMessage(message, theme)
    .render(width)
    .map((line) => stripTerminalSequences(line).trimEnd());
}

beforeAll(() => {
  initTheme("dark", false);
  registerAgents(new Map(DEFAULT_AGENTS));
});

describe("subagent message rendering", () => {
  it("shows the agent heading, task, one blank separator, and body", () => {
    expect(render({ content: `[Subagent "${details.sender}" message]\n\nLorem ipsum`, details })).toEqual([
      "◈ Message from Agent",
      "  (gpt-6.1-terra • high)",
      "  Add cancellable build subprocess scopes",
      "",
      "Lorem ipsum",
    ]);
  });

  it("keeps the saved task description after the agent is cleared", () => {
    expect(render({ content: "Lorem ipsum", details })).toEqual([
      "◈ Message from Agent",
      "  (gpt-6.1-terra • high)",
      "  Add cancellable build subprocess scopes",
      "",
      "Lorem ipsum",
    ]);
  });

  it("renders saved runtime statistics in the same format as completed agents", () => {
    const stats = {
      ...details,
      turnCount: 90,
      toolUses: 21,
      input: 121000,
      output: 11000,
      contextPercent: 4,
      compactions: 0,
      cost: 1.23,
      durationMs: 29000,
    };
    expect(render({ content: "Finding", details: stats })).toEqual([
      "◈ Message from Agent",
      "  (gpt-6.1-terra • high)·21⚒ ·90⟳ ·↑121k↓11k 4%·29s",
      "  Add cancellable build subprocess scopes",
      "",
      "Finding",
    ]);
    const withCost = renderSubagentMessage({ content: "Finding", details: stats }, theme, "id", true)
      .render(100)
      .map((line) => stripTerminalSequences(line).trimEnd());
    expect(withCost[1]).toContain("$1.23");
  });

  it("respects model display style", () => {
    const lines = renderSubagentMessage({ content: "Finding", details }, theme, "name")
      .render(100)
      .map((line) => stripTerminalSequences(line).trimEnd());
    expect(lines).toEqual([
      "◈ Message from Agent",
      "  (GPT-6.1 Terra • high)",
      "  Add cancellable build subprocess scopes",
      "",
      "Finding",
    ]);
  });

  it("uses the same display name as a custom agent's tool call", () => {
    expect(render({ content: "Useful finding", details: { ...details, type: "Explore" } })).toEqual([
      "◈ Message from Explore",
      "  (gpt-6.1-terra • high)",
      "  Add cancellable build subprocess scopes",
      "",
      "Useful finding",
    ]);
  });

  it("uses the saved agent type if its custom definition is no longer registered", () => {
    const removedAgent = {
      ...details,
      sender: "security-review#97a7e0e6",
      type: "security-review",
      description: "Review authentication boundaries",
    };
    expect(
      render({ content: `[Subagent "${removedAgent.sender}" message]\n\nFindings`, details: removedAgent }),
    ).toEqual([
      "◈ Message from security-review",
      "  (gpt-6.1-terra • high)",
      "  Review authentication boundaries",
      "",
      "Findings",
    ]);
  });

  it("renders Markdown rather than exposing formatting markers", () => {
    expect(render({ content: "**Important** update", details })).toEqual([
      "◈ Message from Agent",
      "  (gpt-6.1-terra • high)",
      "  Add cancellable build subprocess scopes",
      "",
      "Important update",
    ]);
  });

  it("supports text-block content and preserves body paragraphs", () => {
    expect(render({ content: [{ type: "text", text: "First\n\nSecond" }] })).toEqual([
      "◈ Message from Agent",
      "",
      "First",
      "",
      "Second",
    ]);
  });

  it("fits the heading, long task description, and body to narrow terminals", () => {
    const lines = render({ content: "An actionable finding with more detail than one line", details }, 24);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(lines.filter((line) => line === "")).toHaveLength(1);
  });
});
