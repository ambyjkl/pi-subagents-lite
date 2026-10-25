import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { makeAgentRecord, shellMock } from "../fixtures.js";
import { registerAgents } from "../../src/agents/agent-types.js";
import { DEFAULT_AGENTS } from "../../src/agents/default-agents.js";
import { renderSubagentMessage } from "../../src/ui/renderer.js";
import type { Theme } from "../../src/ui/types.js";

const { matchAgents } = vi.hoisted(() => ({ matchAgents: vi.fn() }));
vi.mock("../../src/shell.js", () =>
  shellMock({ manager: { matchAgents }, store: { agent: { showAgentColors: false } } }),
);

const theme: Theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

const details = {
  agentId: "97a7e0e6-4000-400",
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

beforeEach(() => {
  matchAgents.mockReset();
  matchAgents.mockReturnValue([]);
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
    expect(matchAgents).not.toHaveBeenCalled();
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

  it("resolves the task of a legacy message from its sender prefix", () => {
    matchAgents.mockReturnValue([
      makeAgentRecord({
        id: details.agentId,
        display: { ...details, invocation: { modelName: details.modelId, thinkingLevel: "high" } },
      }),
    ]);
    expect(render({ content: `[Subagent "${details.sender}" message]\n\nLorem ipsum` })).toEqual([
      "◈ Message from Agent",
      "  (gpt-6.1-terra • high)",
      "  Add cancellable build subprocess scopes",
      "",
      "Lorem ipsum",
    ]);
    expect(matchAgents).toHaveBeenCalledExactlyOnceWith("97a7e0e6");
  });

  it("falls back to the sender when an old agent is no longer retained", () => {
    expect(render({ content: `[Subagent "${details.sender}" message]\n\nLorem ipsum` })).toEqual([
      "◈ Message from Agent",
      "  general-purpose#97a7e0e6",
      "",
      "Lorem ipsum",
    ]);
  });

  it("does not assign an ambiguous legacy prefix to either task", () => {
    matchAgents.mockReturnValue([
      makeAgentRecord({ id: "97a7e0e6-aaaa-400", display: { description: "First task" } }),
      makeAgentRecord({ id: "97a7e0e6-bbbb-400", display: { description: "Second task" } }),
    ]);
    expect(render({ content: `[Subagent "${details.sender}" message]\n\nLorem ipsum` })).toEqual([
      "◈ Message from Agent",
      "  general-purpose#97a7e0e6",
      "",
      "Lorem ipsum",
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
