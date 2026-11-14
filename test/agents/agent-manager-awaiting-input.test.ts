/**
 * agent-manager-awaiting-input.test.ts — In chat mode a plain turn end is not a completion
 * (ADR-0013): the agent parks as awaiting_input, alive and resumable. Chat mode is the user's
 * switch alone (steering never sets it) and persists until they turn it off or submit the agent.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vite-plus/test";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.js";
import {
  mockModules,
  mockStoreState,
  mockAgentSession,
  mockRunResult,
  type MockAgentSession,
  type OnAgentComplete,
} from "./manager-mocks.js";
import { AgentManager, WATCHDOG_TICK_MS } from "../../src/agents/agent-manager.js";
import { asAgentSession } from "../pi-boundaries.js";
import { userSteerText } from "../../src/agents/user-steer.js";
import type { AgentRecord } from "../../src/types.js";

type Run = ReturnType<typeof makeResolvablePromise>;

describe("AgentManager — chat mode and awaiting input", () => {
  let manager: AgentManager;
  let onComplete: Mock<OnAgentComplete>;
  let onResume: Mock<(record: AgentRecord, by: "user" | "agent") => void>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    mockModules.mockAgentOutputLog.mockClear();
    mockStoreState.toolTimeoutMinutes = 0;
    mockStoreState.idleTimeoutMinutes = 0;
    mockStoreState.outputTranscript = true;
    onComplete = vi.fn<OnAgentComplete>();
    onResume = vi.fn<(record: AgentRecord, by: "user" | "agent") => void>();
    manager = new AgentManager(onComplete, { default: 1 });
    manager.setOnResume(onResume);
  });

  afterEach(() => {
    vi.useRealTimers();
    void manager?.dispose().catch(() => {});
  });

  function spawnRunning(modelKey = "test/model"): {
    id: string;
    record: AgentRecord;
    session: MockAgentSession;
    run: Run;
  } {
    const run = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(run.promise);
    const calls = mockModules.mockRunAgent.mock.calls.length;
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey });
    const session = mockAgentSession();
    mockModules.mockRunAgent.mock.calls[calls][3].onSessionCreated(session);
    return { id, record: manager.getRecord(id)!, session, run };
  }

  async function settle(run: Run, session?: MockAgentSession, overrides: Parameters<typeof mockRunResult>[0] = {}) {
    const settled = new Promise<void>((resolve) => onComplete.mockImplementationOnce(() => resolve()));
    run.resolve(mockRunResult({ ...(session ? { session } : {}), ...overrides }));
    await settled;
  }

  /** Spawn, switch chat mode on, end the turn: the agent is awaiting input. */
  async function spawnAwaiting() {
    const spawned = spawnRunning();
    manager.setChatMode(spawned.id, true);
    await settle(spawned.run, spawned.session, { responseText: "Do you mean X or Y?" });
    return spawned;
  }

  describe("the decision at turn end", () => {
    it("parks a running agent in chat mode as awaiting_input, keeps chat mode on and its session", async () => {
      const { record, session } = await spawnAwaiting();

      expect(record.lifecycle.status).toBe("awaiting_input");
      expect(record.lifecycle.chatMode).toBe(true);
      expect(record.result).toBe("Do you mean X or Y?");
      expect(record.lifecycle.completedAt).toBeDefined();
      expect(record.execution.session).toBe(asAgentSession(session));
      expect(record.execution.settled).toBe(true);
      expect(session.dispose).not.toHaveBeenCalled();
      // Not "completed": a record the parent can act on as final.
      expect(manager.listAgents().filter((r) => r.lifecycle.status === "completed")).toEqual([]);
    });

    it("completes as before outside chat mode (regression)", async () => {
      const { record, run, session } = spawnRunning();
      await settle(run, session);
      expect(record.lifecycle.status).toBe("completed");
      expect(record.lifecycle.chatMode).toBeFalsy();
    });

    it("completes after the user steered it, since steering does not switch chat mode on", async () => {
      const { id, record, session, run } = spawnRunning();
      await manager.steer(id, "use A instead of B", { source: "user" });
      expect(record.lifecycle.chatMode).toBeFalsy();

      await settle(run, session);
      expect(record.lifecycle.status).toBe("completed");
    });

    it("completes when chat mode is switched off again before the turn ends", async () => {
      const { id, record, session, run } = spawnRunning();
      manager.setChatMode(id, true);
      manager.setChatMode(id, false);

      await settle(run, session);
      expect(record.lifecycle.status).toBe("completed");
    });

    it("honours chat mode switched on before the session exists", async () => {
      const run = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(run.promise);
      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "t", { description: "t", modelKey: "m/x" });
      expect(manager.setChatMode(id, true)).toBe(true);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mock.calls[0][3].onSessionCreated(session);

      await settle(run, session);
      expect(manager.getRecord(id)!.lifecycle.status).toBe("awaiting_input");
    });

    it("reports an unknown agent when switching chat mode", () => {
      expect(manager.setChatMode("missing", true)).toBe(false);
    });

    it("makes two steers in one run a single awaiting transition", async () => {
      const { id, record, session, run } = spawnRunning();
      manager.setChatMode(id, true);
      await manager.steer(id, "one", { source: "user" });
      await manager.steer(id, "two", { source: "user" });

      await settle(run, session);
      expect(record.lifecycle.status).toBe("awaiting_input");
      expect(record.execution.settlementCount).toBe(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("keeps chat mode on across a main-agent steer", async () => {
      const { id, record, session, run } = spawnRunning();
      manager.setChatMode(id, true);
      await manager.steer(id, "agent");

      await settle(run, session);
      expect(record.lifecycle.status).toBe("awaiting_input");
    });

    it("does not deliver a user steer of a queued agent", async () => {
      spawnRunning("test/model");
      mockModules.mockRunAgent.mockReturnValueOnce(makeResolvablePromise().promise);
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "q", {
        description: "q",
        modelKey: "test/model",
      });
      const queued = manager.getRecord(queuedId)!;
      expect(queued.lifecycle.status).toBe("queued");

      await expect(manager.steer(queuedId, "hi", { source: "user" })).resolves.toBe(false);
    });
  });

  describe("how a steer is worded for a running agent", () => {
    it("tells it to carry on when chat mode is off", async () => {
      const { id, session } = spawnRunning();
      await expect(manager.steer(id, "use A instead of B", { source: "user" })).resolves.toBe(true);
      expect(session.steer).toHaveBeenCalledWith(userSteerText("use A instead of B", false));
      expect(session.steer.mock.calls[0][0]).toContain("continue and finish your task");
    });

    it("asks for a reply when chat mode is on", async () => {
      const { id, session } = spawnRunning();
      manager.setChatMode(id, true);
      await manager.steer(id, "give a progress report", { source: "user" });
      expect(session.steer).toHaveBeenCalledWith(userSteerText("give a progress report", true));
      expect(session.steer.mock.calls[0][0]).toContain("Reply to it");
    });

    it("words a steer queued before the session exists the same way", async () => {
      const run = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(run.promise);
      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "t", { description: "t", modelKey: "m/x" });
      await manager.steer(id, "early", { source: "user" });
      expect(manager.getRecord(id)!.execution.pendingSteers).toEqual([userSteerText("early", false)]);
    });

    it("leaves the main agent's MessageAgent text untouched", async () => {
      const { id, session } = spawnRunning();
      await manager.steer(id, "also Z");
      expect(session.steer).toHaveBeenCalledWith("also Z");
    });

    it("reports a rejected steer as not delivered", async () => {
      const { id, session, run, record } = spawnRunning();
      session.steer.mockRejectedValueOnce(new Error("cannot queue"));

      await expect(manager.steer(id, "/some-command", { source: "user" })).resolves.toBe(false);
      await settle(run, session);
      expect(record.lifecycle.status).toBe("completed");
    });
  });

  describe("input to an awaiting agent", () => {
    it("resumes it as running with the message as typed, then completes once chat mode is off", async () => {
      const { id, record } = await spawnAwaiting();
      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);
      manager.setChatMode(id, false);

      await expect(manager.steer(id, "wrap it up", { source: "user" })).resolves.toBe(true);

      expect(record.lifecycle.status).toBe("running");
      expect(mockModules.mockContinueAgentSession.mock.calls[0][1]).toBe("wrap it up");
      expect(record.lifecycle.resumedFromAwaiting).toBe(true);
      expect(onResume).toHaveBeenCalledWith(record, "user");
      expect(onComplete).toHaveBeenCalledTimes(1);

      await settle(cont);
      expect(record.lifecycle.status).toBe("completed");
      expect(record.execution.settlementCount).toBe(2);
      expect(onComplete).toHaveBeenCalledTimes(2);
    });

    it("parks it again at the next turn end while chat mode stays on", async () => {
      const { id, record } = await spawnAwaiting();
      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);
      await manager.steer(id, "X, please", { source: "user" });
      expect(record.lifecycle.chatMode).toBe(true);

      await settle(cont);

      expect(record.lifecycle.status).toBe("awaiting_input");
      expect(record.execution.settlementCount).toBe(2);
    });

    it("resumes it the same way for the main agent's MessageAgent", async () => {
      const { id, record } = await spawnAwaiting();
      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);
      manager.setChatMode(id, false);

      await expect(manager.steer(id, "go on")).resolves.toBe(true);
      expect(record.lifecycle.status).toBe("running");
      expect(record.lifecycle.resumedBy).toBe("agent");

      await settle(cont);
      expect(record.lifecycle.status).toBe("completed");
    });

    it("clears the resumed-from-awaiting marker on the next resume of a settled agent", async () => {
      const { id, record } = await spawnAwaiting();
      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);
      manager.setChatMode(id, false);
      await manager.steer(id, "X", { source: "user" });
      await settle(cont);
      expect(record.lifecycle.status).toBe("completed");

      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);
      await manager.steer(id, "more", { source: "user" });
      expect(record.lifecycle.resumedFromAwaiting).toBe(false);
    });
  });

  describe("submitting an awaiting agent", () => {
    it("completes it, switches chat mode off and announces the completion once", async () => {
      const { id, record } = await spawnAwaiting();
      expect(onComplete).toHaveBeenCalledTimes(1);

      expect(manager.submit(id)).toBe(true);

      expect(record.lifecycle.status).toBe("completed");
      expect(record.lifecycle.chatMode).toBe(false);
      expect(record.result).toBe("Do you mean X or Y?");
      // The parked turn end was settlement 1; the submit is the one the main agent hears (>= 2).
      expect(record.execution.settlementCount).toBe(2);
      expect(onComplete).toHaveBeenCalledTimes(2);
      expect(onComplete.mock.calls[1][0].lifecycle.status).toBe("completed");
      expect(manager.getTotalAgentCount()).toBe(1);
    });

    it("keeps the session, so the agent can still be continued", async () => {
      const { id, record, session } = await spawnAwaiting();
      manager.submit(id);
      expect(record.execution.session).toBe(asAgentSession(session));
      expect(session.dispose).not.toHaveBeenCalled();

      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);
      await expect(manager.steer(id, "one more thing", { source: "user" })).resolves.toBe(true);
      expect(record.lifecycle.status).toBe("running");
      expect(record.lifecycle.resumedFromAwaiting).toBe(false);
    });

    it("does not account the cost a second time", async () => {
      const { id, run, session } = spawnRunning();
      mockModules.mockRunAgent.mock.calls[0][3].onAssistantUsage({
        input: 10,
        output: 1,
        cacheWrite: 0,
        cacheRead: 0,
        cost: 0.1,
      });
      manager.setChatMode(id, true);
      await settle(run, session);
      manager.submit(id);
      expect(manager.getTotalAgentCost()).toBeCloseTo(0.1);
    });

    it("closes the output file with a DONE line instead of awaiting input", async () => {
      const { id, record } = await spawnAwaiting();
      mockModules.mockAgentOutputLog.mockClear();

      manager.submit(id);

      expect(mockModules.mockAgentOutputLog).toHaveBeenCalledTimes(1);
      expect(mockModules.mockAgentOutputLog.mock.calls[0][4]).toBe(record.display.outputFile);
      const log = mockModules.mockAgentOutputLog.mock.results[0].value;
      expect(log.finalize).toHaveBeenCalledTimes(1);
      expect(log.finalize.mock.calls[0][0].awaitingInput).toBeFalsy();
    });

    it.each(["running", "completed"] as const)("refuses an agent that is %s", async (state) => {
      const { id, record, run, session } = spawnRunning();
      if (state === "completed") await settle(run, session);
      expect(manager.submit(id)).toBe(false);
      expect(record.lifecycle.status).toBe(state);
    });

    it("refuses an unknown agent", () => {
      expect(manager.submit("missing")).toBe(false);
    });
  });

  describe("a run that does not end in a plain turn end", () => {
    it.each([
      ["a model error", { modelError: "boom" }, "error"],
      ["an abort", { aborted: true }, "aborted"],
      ["the turn limit", { turnLimited: true }, "turn_limited"],
    ] as const)("settles as usual after %s, whatever chat mode says", async (_label, overrides, status) => {
      const { id, record, session, run } = spawnRunning();
      manager.setChatMode(id, true);

      await settle(run, session, overrides);

      expect(record.lifecycle.status).toBe(status);
    });

    it("settles as error when the run rejects", async () => {
      let reject!: (error: Error) => void;
      const run = new Promise<never>((_, rej) => {
        reject = rej;
      });
      mockModules.mockRunAgent.mockReturnValueOnce(run);
      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "t", { description: "t", modelKey: "m/x" });
      mockModules.mockRunAgent.mock.calls[0][3].onSessionCreated(mockAgentSession());
      manager.setChatMode(id, true);
      const settled = new Promise<void>((resolve) => onComplete.mockImplementationOnce(() => resolve()));

      reject(new Error("exploded"));
      await settled;

      const record = manager.getRecord(id)!;
      expect(record.lifecycle.status).toBe("error");
      expect(record.error).toBe("exploded");
    });

    it("stays stopped when stopped in chat mode", async () => {
      const { id, record, session, run } = spawnRunning();
      manager.setChatMode(id, true);
      manager.abort(id, "user");
      await settle(run, session);
      expect(record.lifecycle.status).toBe("stopped");
    });

    it("is stopped by the watchdog in chat mode without ever becoming awaiting", async () => {
      vi.useFakeTimers();
      mockStoreState.idleTimeoutMinutes = 1;
      manager = new AgentManager(onComplete, { default: 1 });
      const { id, record, session, run } = spawnRunning();
      manager.setChatMode(id, true);

      vi.advanceTimersByTime(60_000 + WATCHDOG_TICK_MS);
      expect(record.lifecycle.status).toBe("stopped");
      expect(record.lifecycle.stoppedBy).toBe("watchdog");
      run.resolve(mockRunResult({ session }));
      await vi.advanceTimersByTimeAsync(0);
      expect(record.lifecycle.status).toBe("stopped");
    });

    it("does not park the agent while the session is still retrying (the run has not ended)", async () => {
      const { id, record, session } = spawnRunning();
      manager.setChatMode(id, true);

      // A transient stream error: the session emits its retry events but prompt() has not resolved.
      const listeners = session.subscribe.mock.calls.map((call) => call[0]);
      for (const listener of listeners) {
        listener({ type: "agent_end", messages: [] } as never);
        listener({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 10,
          errorMessage: "stream",
        } as never);
      }

      expect(record.lifecycle.status).toBe("running");
      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  describe("what an awaiting agent keeps and is not", () => {
    it("holds no concurrency slot while it waits and re-reserves one on resume", async () => {
      const { id, record } = await spawnAwaiting();
      // Limit 1: a second agent can start while the first awaits.
      const other = spawnRunning();
      expect(other.record.lifecycle.status).toBe("running");

      // The slot is taken: the awaiting agent cannot resume until it frees.
      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);
      await expect(manager.steer(id, "x", { source: "user" })).resolves.toBe(false);
      expect(record.lifecycle.status).toBe("awaiting_input");

      await settle(other.run, other.session);
      await expect(manager.steer(id, "x", { source: "user" })).resolves.toBe(true);
      expect(record.lifecycle.status).toBe("running");
    });

    it("releases the slot exactly once per run (no double decrement across the transitions)", async () => {
      const { id } = await spawnAwaiting();
      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);
      await manager.steer(id, "x", { source: "user" });
      // Resumed: slot held again, so a new spawn queues.
      mockModules.mockRunAgent.mockReturnValueOnce(makeResolvablePromise().promise);
      const queuedId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "q", {
        description: "q",
        modelKey: "test/model",
      });
      expect(manager.getRecord(queuedId)!.lifecycle.status).toBe("queued");
      await settle(cont);
      expect(manager.getRecord(queuedId)!.lifecycle.status).toBe("running");
    });

    it("is not cleared as a finished record, but can be stopped and then cleared", async () => {
      const { id, record } = await spawnAwaiting();
      expect(manager.clear(id)).toBe(false);
      expect(manager.getRecord(id)).toBe(record);

      expect(manager.abort(id, "user")).toBe(true);
      expect(record.lifecycle.status).toBe("stopped");
      expect(record.lifecycle.stoppedBy).toBe("user");
      expect(record.execution.session).toBeDefined();
      expect(onComplete).toHaveBeenCalledTimes(2);
      expect(manager.clear(id)).toBe(true);
    });

    it("is not stopped by the idle watchdog while it waits for the owner", async () => {
      vi.useFakeTimers();
      mockStoreState.idleTimeoutMinutes = 1;
      manager = new AgentManager(onComplete, { default: 1 });
      const { run, session, id, record } = spawnRunning();
      manager.setChatMode(id, true);
      run.resolve(mockRunResult({ session }));
      await vi.advanceTimersByTimeAsync(0);
      expect(record.lifecycle.status).toBe("awaiting_input");

      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
      expect(record.lifecycle.status).toBe("awaiting_input");
      expect(session.abort).not.toHaveBeenCalled();
    });

    it("gives the resumed run a fresh idle clock", async () => {
      vi.useFakeTimers();
      mockStoreState.idleTimeoutMinutes = 1;
      manager = new AgentManager(onComplete, { default: 1 });
      const { run, session, id, record } = spawnRunning();
      manager.setChatMode(id, true);
      run.resolve(mockRunResult({ session }));
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(60 * 60_000);
      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);
      await manager.steer(id, "answer", { source: "user" });

      vi.advanceTimersByTime(50_000);
      expect(record.lifecycle.status).toBe("running");
    });

    it("is torn down with the manager like any other session", async () => {
      const { session } = await spawnAwaiting();
      await manager.dispose();
      expect(session.dispose).toHaveBeenCalled();
    });
  });

  describe("usage and the output file", () => {
    it("accounts cost at the awaiting transition and counts the agent as done only once it is final", async () => {
      const { id, run, session } = spawnRunning();
      const usage = (input: number, cost: number) => ({ input, output: 1, cacheWrite: 0, cacheRead: 0, cost });
      mockModules.mockRunAgent.mock.calls[0][3].onAssistantUsage(usage(10, 0.1));
      manager.setChatMode(id, true);
      await settle(run, session);

      expect(manager.getTotalAgentCost()).toBeCloseTo(0.1);
      expect(manager.getTotalAgentCount()).toBe(0);

      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);
      manager.setChatMode(id, false);
      await manager.steer(id, "answer", { source: "user" });
      mockModules.mockContinueAgentSession.mock.calls[0][2].onAssistantUsage(usage(4, 0.05));
      await settle(cont);

      expect(manager.getRecord(id)!.stats.lifetimeUsage.input).toBe(14);
      expect(manager.getTotalAgentCost()).toBeCloseTo(0.15);
      expect(manager.getTotalAgentCount()).toBe(1);
    });

    it("counts an awaiting agent that is then stopped as done, once", async () => {
      const { id } = await spawnAwaiting();
      manager.abort(id, "user");
      expect(manager.getTotalAgentCount()).toBe(1);
    });

    it("marks the output file as awaiting input instead of DONE, then reopens it on resume", async () => {
      const { id, record, session } = await spawnAwaiting();
      const firstLog = mockModules.mockAgentOutputLog.mock.results[0].value;
      expect(firstLog.finalize).toHaveBeenCalledTimes(1);
      expect(firstLog.finalize.mock.calls[0][0]).toMatchObject({ awaitingInput: true });
      expect(record.execution.outputLog).toBeUndefined();

      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);
      manager.setChatMode(id, false);
      await manager.steer(id, "answer", { source: "user" });
      expect(mockModules.mockAgentOutputLog).toHaveBeenCalledTimes(2);
      expect(mockModules.mockAgentOutputLog.mock.calls[1][4]).toBe(record.display.outputFile);
      const resumedLog = mockModules.mockAgentOutputLog.mock.results[1].value;
      expect(resumedLog.attach).toHaveBeenCalledWith(asAgentSession(session));

      await settle(cont);
      expect(resumedLog.finalize.mock.calls[0][0].awaitingInput).toBeFalsy();
    });
  });
});
