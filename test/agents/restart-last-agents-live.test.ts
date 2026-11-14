/**
 * restart-last-agents-live.test.ts — Restarting the last Agent calls skips an agent that is
 * still alive, including one parked as awaiting input (ADR-0013): it can still be answered, and a
 * second copy would redo its work. A finished agent does not block a restart.
 */
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { fakeCtx, makeAgentRecord, shellMock } from "../fixtures.js";
import { asCommandContext } from "../pi-boundaries.js";
import type { AgentStatus } from "../../src/types.js";

const { mockSpawn, mockListAgents } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockListAgents: vi.fn(),
}));

vi.mock("../../src/shell.js", () =>
  shellMock({
    manager: { listAgents: mockListAgents },
    coordinator: { spawn: mockSpawn },
    store: {
      agent: { graceTurns: 6, forceBackground: false, defaultMaxTurns: 25 },
      modelFor: () => "",
    },
  }),
);

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveTypeOrDiscover: vi.fn(async (type: string) => ({ kind: "resolved", key: type })),
  getAgentConfig: vi.fn(() => ({ name: "general-purpose", description: "t", systemPrompt: "p", maxTurns: 25 })),
  resolveType: vi.fn((type: string) => ({ kind: "resolved", key: type })),
  discoverNewAgents: vi.fn(async () => 0),
}));

import { handleRestartLastAgents } from "../../src/agents/restart-last-agents.js";

function messageEntry(content: unknown[]): SessionMessageEntry {
  return {
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content },
  } as SessionMessageEntry;
}

function ctxWithCall() {
  const entry = messageEntry([
    { type: "toolCall", id: "tc-1", name: "Agent", arguments: { prompt: "Do it", description: "Do it" } },
  ]);
  const ctx = asCommandContext(fakeCtx());
  vi.mocked(ctx.sessionManager.getEntries).mockReturnValue([entry]);
  return ctx;
}

describe("handleRestartLastAgents against agents already in the manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockResolvedValue({ agentId: "new", record: makeAgentRecord(), isBackground: true });
  });

  function listed(status: AgentStatus) {
    mockListAgents.mockReturnValue([
      makeAgentRecord({ display: { type: "general-purpose", description: "Do it" }, lifecycle: { status } }),
    ]);
  }

  it.each(["running", "queued", "awaiting_input"] as const)("skips a call whose agent is %s", async (status) => {
    listed(status);

    const result = await handleRestartLastAgents(ctxWithCall());

    expect(result).toEqual({ restarted: [], skipped: ["general-purpose: Do it (already running)"] });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("restarts a call whose agent already completed", async () => {
    listed("completed");

    const result = await handleRestartLastAgents(ctxWithCall());

    expect(result).toEqual({ restarted: ["general-purpose: Do it"], skipped: [] });
  });
});
