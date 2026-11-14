/**
 * awaiting-input-e2e.test.ts — The incident that motivated ADR-0013, end to end.
 *
 * The user talks to a RUNNING subagent directly; the subagent answers with text only and ends its
 * turn. That used to read as "completed": the parent was nudged to act on an unfinished agent
 * (it merged the branch and removed the worktree). The user now says whether they are in a
 * conversation (chat mode); only then is the turn end a pause. Real AgentManager + SpawnCoordinator, wired
 * the way events.ts wires them, driven through the same steerAsUser the conversation viewer
 * calls. Only the model runner and pi's message sink are faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.js";
import { asExtensionAPI } from "../pi-boundaries.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/home/test/.pi/agent",
}));

function fakeSession() {
  return {
    subscribe: vi.fn(() => () => {}),
    getActiveToolNames: vi.fn(() => [] as string[]),
    messages: [] as unknown[],
    dispose: vi.fn(),
    isStreaming: false,
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    extensionRunner: { emit: vi.fn(async () => undefined) },
  };
}
const runResult = (responseText: string, session = fakeSession()) => ({
  responseText,
  session,
  aborted: false,
  turnLimited: false,
});

const { runAgent, continueAgentSession } = vi.hoisted(() => ({
  runAgent: vi.fn(),
  continueAgentSession: vi.fn(),
}));
vi.mock("../../src/agents/agent-runner.js", () => ({ runAgent, continueAgentSession }));

import { AgentManager } from "../../src/agents/agent-manager.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import { setManager, setPiInstance } from "../../src/shell.js";
import { steerAsUser } from "../../src/ui/steer-input.js";
import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
import { asExtensionContext } from "../pi-boundaries.js";

describe("a user steer of a running subagent whose turn then ends with text only", () => {
  let manager: AgentManager;
  let coordinator: SpawnCoordinator;
  const sendMessage = vi.fn();
  const ctx = fakeCtx();

  const sent = () => sendMessage.mock.calls.map(([message, options]) => ({ message, options }));
  const contents = () => sent().map(({ message }) => message.content as string);
  const flush = () => vi.advanceTimersByTimeAsync(1000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    runAgent.mockReset();
    continueAgentSession.mockReset();
    sendMessage.mockReset();
    setPiInstance(asExtensionAPI({ sendMessage, exec: vi.fn() }));
    manager = new AgentManager();
    setManager(manager);
    coordinator = new SpawnCoordinator(manager);
    manager.setOnComplete((record) => coordinator.onAgentComplete(record));
    manager.setOnResume((record, by) => coordinator.onAgentResumed(record, by));
  });

  afterEach(() => {
    vi.useRealTimers();
    coordinator.dispose();
    setManager(null);
    void manager.dispose().catch(() => {});
  });

  async function spawnBackground() {
    const run = makeResolvablePromise();
    runAgent.mockReturnValueOnce(run.promise);
    const { record } = await coordinator.spawn(fakePi(), ctx, {
      type: "general-purpose",
      prompt: "implement it",
      description: "Implement",
      graceTurns: 6,
      runInBackground: true,
    });
    runAgent.mock.calls[0][3].onSessionCreated(fakeSession());
    return { record, run };
  }

  it("parks the agent in chat mode, nudges the parent nothing, and tells it quietly and truthfully", async () => {
    const { record, run } = await spawnBackground();

    manager.setChatMode(record.id, true);
    steerAsUser(ctx, manager, record, "which approach did you pick?");
    await vi.advanceTimersByTimeAsync(0);
    run.resolve(runResult("I picked X, but should I use Y?"));
    await record.execution.promise;
    await flush();

    expect(record.lifecycle.status).toBe("awaiting_input");
    expect(sent().filter(({ options }) => options?.triggerTurn)).toEqual([]);
    expect(contents().filter((c) => c.includes("completed]"))).toEqual([]);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].options).toEqual({ triggerTurn: false });
    expect(sent()[0].message.content).toContain("awaiting input]");
    expect(sent()[0].message.content).toMatch(/NOT done/);

    const status = await executeAgentStatusTool("c", {}, undefined, undefined, asExtensionContext({}));
    expect(status.content[0].text).toContain(`${record.id.slice(0, 8)} (general-purpose) awaiting input`);
    expect(status.content[0].text).toContain("NOT finished");
  });

  it("completes normally, with exactly one nudge, once the user leaves chat mode and answers the parked agent", async () => {
    const { record, run } = await spawnBackground();
    manager.setChatMode(record.id, true);
    steerAsUser(ctx, manager, record, "which approach?");
    await vi.advanceTimersByTimeAsync(0);
    run.resolve(runResult("X or Y?"));
    await record.execution.promise;
    await flush();
    sendMessage.mockClear();

    const answer = makeResolvablePromise();
    continueAgentSession.mockReturnValueOnce(answer.promise);
    manager.setChatMode(record.id, false);
    steerAsUser(ctx, manager, record, "use X");
    await vi.advanceTimersByTimeAsync(0);
    expect(record.lifecycle.status).toBe("running");
    expect(sent()).toEqual([]); // nothing went stale, so no "resumed by the user" notice

    answer.resolve(runResult("Went with X."));
    await record.execution.promise;
    await flush();

    expect(record.lifecycle.status).toBe("completed");
    expect(sent()).toHaveLength(1);
    expect(sent()[0].options).toMatchObject({ triggerTurn: true });
    expect(sent()[0].message.content).toContain("completed]");
  });

  it("tells the parent once, as completed, when the user submits the parked agent", async () => {
    const { record, run } = await spawnBackground();
    manager.setChatMode(record.id, true);
    steerAsUser(ctx, manager, record, "give a progress report");
    await vi.advanceTimersByTimeAsync(0);
    run.resolve(runResult("Half done."));
    await record.execution.promise;
    await flush();
    sendMessage.mockClear();

    expect(manager.submit(record.id)).toBe(true);
    await flush();

    expect(record.lifecycle.status).toBe("completed");
    expect(record.lifecycle.chatMode).toBe(false);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].options).toMatchObject({ triggerTurn: true });
    expect(sent()[0].message.content).toContain("completed]");
    expect(sent()[0].message.content).toContain("Half done.");
  });

  it("completes a steered agent that is not in chat mode and carries on, with one nudge", async () => {
    const { record, run } = await spawnBackground();
    steerAsUser(ctx, manager, record, "suggestion: use A instead of B");
    await vi.advanceTimersByTimeAsync(0);
    run.resolve(runResult("Used A. Done."));
    await record.execution.promise;
    await flush();

    expect(record.lifecycle.status).toBe("completed");
    expect(sent()).toHaveLength(1);
    expect(sent()[0].options).toMatchObject({ triggerTurn: true });
  });

  it("does not park an agent the main agent steered, or one that nobody steered", async () => {
    const { record, run } = await spawnBackground();
    await manager.steer(record.id, "main agent nudge"); // MessageAgent: source agent
    run.resolve(runResult("done"));
    await record.execution.promise;
    await flush();

    expect(record.lifecycle.status).toBe("completed");
    expect(sent()).toHaveLength(1);
    expect(sent()[0].options).toMatchObject({ triggerTurn: true });
  });
});
