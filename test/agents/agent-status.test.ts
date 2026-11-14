/** Behavior tests for AgentStatus list selection. */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { asExtensionContext } from "../pi-boundaries.js";
import { shellMock } from "../fixtures.js";

const { mockListAgents, mockStore } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockStore: { agent: { agentStatusLimit: 8 } },
}));

vi.mock("../../src/shell.js", () =>
  shellMock({
    manager: { listAgents: mockListAgents },
    store: mockStore,
  }),
);

import { executeAgentStatusTool } from "../../src/agents/agent-status.js";

describe("AgentStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.agent.agentStatusLimit = 8;
  });

  it("returns a text result for an empty agent list", async () => {
    mockListAgents.mockReturnValue([]);

    const result = await executeAgentStatusTool("call", {}, undefined, undefined, asExtensionContext({}));

    expect(result.content[0].type).toBe("text");
    expect(result.isError).toBeUndefined();
  });

  it("keeps every active agent and the newest settled agents within the configured limit", async () => {
    mockStore.agent.agentStatusLimit = 2;
    mockListAgents.mockReturnValue([
      { id: "aaa11111aaa11111", display: { type: "builder" }, lifecycle: { status: "running", startedAt: 100 } },
      { id: "bbb22222bbb22222", display: { type: "reviewer" }, lifecycle: { status: "queued", startedAt: 90 } },
      {
        id: "ccc33333ccc33333",
        display: { type: "worker" },
        lifecycle: { status: "completed", startedAt: 80, completedAt: 100 },
      },
      {
        id: "ddd44444ddd44444",
        display: { type: "worker" },
        lifecycle: { status: "error", startedAt: 70, completedAt: 90 },
      },
      {
        id: "eee55555eee55555",
        display: { type: "worker" },
        lifecycle: { status: "stopped", startedAt: 60, completedAt: 80 },
      },
    ]);

    const result = await executeAgentStatusTool("call", {}, undefined, undefined, asExtensionContext({}));
    const output = result.content[0].text;

    expect(output).toContain("aaa11111");
    expect(output).toContain("running");
    expect(output).toContain("bbb22222");
    expect(output).toContain("queued");
    expect(output.indexOf("bbb22222")).toBeLessThan(output.indexOf("ccc33333"));
    expect(output).toContain("ccc33333");
    expect(output).toContain("ddd44444");
    expect(output.indexOf("ccc33333")).toBeLessThan(output.indexOf("ddd44444"));
    expect(output).not.toContain("eee55555");
    expect(result.isError).toBeUndefined();
  });

  it("flags a running agent the user resumed after it completed, so its earlier report reads as stale", async () => {
    mockListAgents.mockReturnValue([
      {
        id: "aaa11111aaa11111",
        display: { type: "builder" },
        lifecycle: { status: "running", startedAt: 100, resumedBy: "user" },
      },
      {
        id: "bbb22222bbb22222",
        display: { type: "builder" },
        lifecycle: { status: "running", startedAt: 90, resumedBy: "agent" },
      },
      { id: "ccc33333ccc33333", display: { type: "builder" }, lifecycle: { status: "running", startedAt: 80 } },
      {
        id: "ddd44444ddd44444",
        display: { type: "builder" },
        lifecycle: { status: "completed", startedAt: 70, completedAt: 95, resumedBy: "user" },
      },
    ]);

    const result = await executeAgentStatusTool("call", {}, undefined, undefined, asExtensionContext({}));
    const lines = result.content[0].text.split("\n");

    expect(lines.find((l: string) => l.startsWith("aaa11111"))).toContain("resumed by the user");
    expect(lines.find((l: string) => l.startsWith("bbb22222"))).not.toContain("resumed");
    expect(lines.find((l: string) => l.startsWith("ccc33333"))).not.toContain("resumed");
    // Once it completed again its new report is current.
    expect(lines.find((l: string) => l.startsWith("ddd44444"))).not.toContain("resumed");
  });

  it("lists the description and worktree_path of each agent when present", async () => {
    mockListAgents.mockReturnValue([
      {
        id: "aaa11111aaa11111",
        display: { type: "builder", description: "Build the\n  parser", worktreePath: "/repo/.worktrees/parser" },
        lifecycle: { status: "running", startedAt: 100 },
      },
      {
        id: "bbb22222bbb22222",
        display: { type: "reviewer", description: "" },
        lifecycle: { status: "queued", startedAt: 90 },
      },
    ]);

    const result = await executeAgentStatusTool("call", {}, undefined, undefined, asExtensionContext({}));

    expect(result.content[0].text.split("\n\n")[0]).toBe(
      [
        "aaa11111 (builder) running, description: Build the parser, worktree_path: /repo/.worktrees/parser",
        "bbb22222 (reviewer) queued",
      ].join("\n"),
    );
  });

  it("lists an agent awaiting input as active with a hint that it is not finished", async () => {
    mockStore.agent.agentStatusLimit = 1;
    mockListAgents.mockReturnValue([
      {
        id: "aaa11111aaa11111",
        display: { type: "builder" },
        lifecycle: { status: "awaiting_input", startedAt: 100, completedAt: 150 },
      },
      {
        id: "bbb22222bbb22222",
        display: { type: "worker" },
        lifecycle: { status: "completed", startedAt: 80, completedAt: 200 },
      },
      {
        id: "ccc33333ccc33333",
        display: { type: "worker" },
        lifecycle: { status: "completed", startedAt: 70, completedAt: 190 },
      },
    ]);

    const result = await executeAgentStatusTool("call", {}, undefined, undefined, asExtensionContext({}));
    const output = result.content[0].text;

    // Active agents are exempt from the limit; one settled agent fills it.
    expect(output).toContain("aaa11111 (builder) awaiting input");
    expect(output).not.toContain("awaiting_input");
    expect(output).toMatch(/NOT finished.*do not treat it as done.*merge its branch.*remove its worktree/);
    expect(output).toContain("bbb22222");
    expect(output).not.toContain("ccc33333");
    expect(output.indexOf("aaa11111")).toBeLessThan(output.indexOf("bbb22222"));
  });

  it("notes that a running agent was answered by the user after it stopped for input", async () => {
    mockListAgents.mockReturnValue([
      {
        id: "aaa11111aaa11111",
        display: { type: "builder" },
        lifecycle: { status: "running", startedAt: 100, resumedBy: "user", resumedFromAwaiting: true },
      },
    ]);

    const result = await executeAgentStatusTool("call", {}, undefined, undefined, asExtensionContext({}));

    expect(result.content[0].text).toContain("answered by the user after it stopped for input");
    expect(result.content[0].text).not.toContain("stale");
  });
});
