/**
 * events-compaction-resumed.test.ts — Compacting the main session clears completed subagents,
 * but never one the user resumed directly: it is running again and must stay in AgentStatus.
 * Drives the real session_compact listener against a real AgentManager (runner mocked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fakeCtx, fakePi, makeResolvablePromise } from "./fixtures.js";
import { asExtensionAPI } from "./pi-boundaries.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/home/test/.pi/agent",
}));

/** A promise-shaped fake session: just enough for the manager to wire and settle a run. */
function fakeSession() {
  return {
    subscribe: vi.fn(() => () => {}),
    messages: [] as unknown[],
    dispose: vi.fn(),
    isStreaming: false,
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    extensionRunner: { emit: vi.fn(async () => undefined) },
  };
}
const runResult = () => ({ responseText: "done", session: fakeSession(), aborted: false, turnLimited: false });

const { runAgent, continueAgentSession } = vi.hoisted(() => ({
  runAgent: vi.fn(),
  continueAgentSession: vi.fn(),
}));
vi.mock("../src/agents/agent-runner.js", () => ({ runAgent, continueAgentSession }));

import { setupEventListeners } from "../src/events.js";
import { AgentManager } from "../src/agents/agent-manager.js";
import { setManager } from "../src/shell.js";

describe("session_compact with a user-resumed subagent", () => {
  let manager: AgentManager;
  let compact: () => void;
  let shutdown: (event: unknown, ctx: unknown) => Promise<void>;

  beforeEach(() => {
    runAgent.mockReset();
    continueAgentSession.mockReset();
    manager = new AgentManager();
    setManager(manager);
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
    };
    setupEventListeners(asExtensionAPI(pi) as ExtensionAPI);
    compact = () => {
      handlers.get("session_compact")!();
    };
    shutdown = async (event, ctx) => {
      await (handlers.get("session_shutdown") as typeof shutdown)(event, ctx);
    };
  });

  afterEach(() => {
    setManager(null);
    // A resumed run that never settles would make dispose wait for it.
    void manager.dispose().catch(() => {});
  });

  async function completedAgent(): Promise<string> {
    runAgent.mockResolvedValueOnce(runResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "t" });
    await manager.getRecord(id)!.execution.promise;
    return id;
  }

  it("clears a completed agent but keeps the one the user resumed", async () => {
    const done = await completedAgent();
    const resumed = await completedAgent();
    continueAgentSession.mockReturnValue(makeResolvablePromise().promise);

    await manager.steer(resumed, "here is my answer", { source: "user" });
    compact();

    expect(manager.getRecord(done)).toBeUndefined();
    expect(manager.getRecord(resumed)?.lifecycle.status).toBe("running");
    expect(manager.listAgents().map((r) => r.id)).toEqual([resumed]);
  });

  it("clears the resumed agent at a later compaction, once it has completed again", async () => {
    const id = await completedAgent();
    const run = makeResolvablePromise();
    continueAgentSession.mockReturnValue(run.promise);
    await manager.steer(id, "answer", { source: "user" });
    compact();
    expect(manager.getRecord(id)).toBeDefined();

    run.resolve(runResult());
    await manager.getRecord(id)!.execution.promise;
    await vi.waitFor(() => expect(manager.getRecord(id)!.lifecycle.status).toBe("completed"));
    compact();

    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("keeps an agent awaiting input: it is not final, and the user may still answer it", async () => {
    const run = makeResolvablePromise();
    runAgent.mockReturnValueOnce(run.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "t" });
    manager.setChatMode(id, true);
    run.resolve(runResult());
    await manager.getRecord(id)!.execution.promise;
    await vi.waitFor(() => expect(manager.getRecord(id)!.lifecycle.status).toBe("awaiting_input"));

    compact();

    expect(manager.listAgents().map((r) => [r.id, r.lifecycle.status])).toEqual([[id, "awaiting_input"]]);
  });

  it("counts an agent awaiting input among those killed by a reload", async () => {
    const run = makeResolvablePromise();
    runAgent.mockReturnValueOnce(run.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "t" });
    manager.setChatMode(id, true);
    run.resolve(runResult());
    await manager.getRecord(id)!.execution.promise;
    await vi.waitFor(() => expect(manager.getRecord(id)!.lifecycle.status).toBe("awaiting_input"));
    const ctx = fakeCtx();

    await shutdown({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("1 agent(s) killed by reload", "warning");
  });
});
