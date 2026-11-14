/**
 * agent-manager-user-steer.test.ts — A user who steers a subagent directly (the viewer or the
 * /agents menu, not the main agent's MessageAgent tool) must never turn the run into a
 * completion the parent can act on early.
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
import type { AgentRecord } from "../../src/types.js";

describe("AgentManager — direct user steering", () => {
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
    manager = new AgentManager(onComplete);
    manager.setOnResume(onResume);
  });

  afterEach(() => {
    vi.useRealTimers();
    void manager?.dispose().catch(() => {});
  });

  function spawnRunning(): {
    id: string;
    record: AgentRecord;
    session: MockAgentSession;
    run: ReturnType<typeof makeResolvablePromise>;
  } {
    const run = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(run.promise);
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
      description: "task",
      modelKey: "test/model",
    });
    const session = mockAgentSession();
    mockModules.mockRunAgent.mock.calls[0][3].onSessionCreated(session);
    return { id, record: manager.getRecord(id)!, session, run };
  }

  async function spawnCompleted(): Promise<{ id: string; record: AgentRecord; session: MockAgentSession }> {
    const session = mockAgentSession();
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
      description: "task",
      modelKey: "test/model",
    });
    const record = manager.getRecord(id)!;
    await record.execution.promise;
    return { id, record, session };
  }

  async function settle(run: ReturnType<typeof makeResolvablePromise>, session?: MockAgentSession) {
    const completed = new Promise<void>((resolve) => onComplete.mockImplementationOnce(() => resolve()));
    run.resolve(mockRunResult(session ? { session } : {}));
    await completed;
  }

  describe("steering a running agent (mid-turn)", () => {
    it("queues the message on the live session and leaves the run alone", async () => {
      const { id, record, session, run } = spawnRunning();

      await expect(manager.steer(id, "also check X", { source: "user" })).resolves.toBe(true);

      expect(session.steer).toHaveBeenCalledWith("also check X");
      expect(record.lifecycle.status).toBe("running");
      expect(record.execution.settled).toBe(false);
      expect(record.execution.abortController?.signal.aborted).toBe(false);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onResume).not.toHaveBeenCalled();
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();

      // The one run settles once, as completed, after the steered work.
      await settle(run, session);
      expect(record.lifecycle.status).toBe("completed");
      expect(record.execution.settlementCount).toBe(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("does not abort or split the run when the session rejects the steer", async () => {
      const { id, record, session, run } = spawnRunning();
      session.steer.mockRejectedValueOnce(new Error("cannot queue"));

      await expect(manager.steer(id, "/some-command", { source: "user" })).resolves.toBe(false);

      expect(record.lifecycle.status).toBe("running");
      expect(record.execution.abortController?.signal.aborted).toBe(false);
      await settle(run, session);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("buffers a steer sent before the session exists and flushes it with the session", async () => {
      const run = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(run.promise);
      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "t", modelKey: "m/x" });

      await expect(manager.steer(id, "early", { source: "user" })).resolves.toBe(true);
      const session = mockAgentSession();
      mockModules.mockRunAgent.mock.calls[0][3].onSessionCreated(session);

      expect(session.steer).toHaveBeenCalledWith("early");
      expect(manager.getRecord(id)!.lifecycle.status).toBe("running");
      expect(onComplete).not.toHaveBeenCalled();
      await settle(run, session);
    });
  });

  describe("watchdog", () => {
    it("counts a direct user steer as activity for the idle clock", () => {
      vi.useFakeTimers();
      mockStoreState.idleTimeoutMinutes = 1;
      manager = new AgentManager(onComplete);
      const { id, record } = spawnRunning();

      vi.advanceTimersByTime(50_000);
      void manager.steer(id, "still there?", { source: "user" });
      // 100 s after the start but only 50 s after the steer: not idle for a minute yet.
      vi.advanceTimersByTime(50_000);
      expect(record.lifecycle.status).toBe("running");

      vi.advanceTimersByTime(10_000 + WATCHDOG_TICK_MS);
      expect(record.lifecycle.status).toBe("stopped");
      expect(record.lifecycle.stoppedBy).toBe("watchdog");
    });

    it("does not let the main agent's MessageAgent keep a silent agent alive", () => {
      vi.useFakeTimers();
      mockStoreState.idleTimeoutMinutes = 1;
      manager = new AgentManager(onComplete);
      const { id, record } = spawnRunning();

      vi.advanceTimersByTime(50_000);
      void manager.steer(id, "ping");
      vi.advanceTimersByTime(10_000 + WATCHDOG_TICK_MS);
      expect(record.lifecycle.status).toBe("stopped");
    });
  });

  describe("resuming a settled agent", () => {
    it("marks the run as resumed by the user and reports the resume", async () => {
      const { id, record } = await spawnCompleted();
      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);
      expect(record.lifecycle.resumedBy).toBeUndefined();

      await expect(manager.steer(id, "answer to your question", { source: "user" })).resolves.toBe(true);

      expect(record.lifecycle.status).toBe("running");
      expect(record.lifecycle.resumedBy).toBe("user");
      expect(onResume).toHaveBeenCalledTimes(1);
      expect(onResume).toHaveBeenCalledWith(record, "user");
    });

    it("marks a MessageAgent continuation as resumed by the agent", async () => {
      const { id, record } = await spawnCompleted();
      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);

      await manager.steer(id, "go on");

      expect(record.lifecycle.resumedBy).toBe("agent");
      expect(onResume).toHaveBeenCalledWith(record, "agent");
    });

    it("does not report a resume that was rejected", async () => {
      const { id, session } = await spawnCompleted();
      session.isStreaming = true;

      await expect(manager.steer(id, "x", { source: "user" })).resolves.toBe(false);
      expect(onResume).not.toHaveBeenCalled();
      expect(manager.getRecord(id)!.lifecycle.resumedBy).toBeUndefined();
    });

    it("notifies completion again, once, when the resumed run truly finishes", async () => {
      const { id, record } = await spawnCompleted();
      expect(onComplete).toHaveBeenCalledTimes(1);
      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);

      await manager.steer(id, "answer", { source: "user" });
      // Mid-resume: still running, no completion fired for the resumed run yet.
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(record.lifecycle.status).toBe("running");

      await settle(cont);
      expect(onComplete).toHaveBeenCalledTimes(2);
      expect(record.lifecycle.status).toBe("completed");
      expect(record.execution.settlementCount).toBe(2);
      expect(record.lifecycle.resumedBy).toBe("user");
    });

    it("resumes a stopped agent without carrying the stale stop reason", async () => {
      const { id, record, session, run } = spawnRunning();
      manager.abort(id, "watchdog", { kind: "idle", elapsedMs: 1 });
      await settle(run, session);
      expect(record.lifecycle.stoppedBy).toBe("watchdog");
      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);

      await expect(manager.steer(id, "carry on", { source: "user" })).resolves.toBe(true);

      expect(record.lifecycle.status).toBe("running");
      expect(record.lifecycle.stoppedBy).toBeUndefined();
      expect(record.lifecycle.stopDetail).toBeUndefined();
    });

    it("keeps StopAgent working on a resumed agent", async () => {
      const { id, record } = await spawnCompleted();
      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);
      await manager.steer(id, "answer", { source: "user" });
      const controller = record.execution.abortController!;

      expect(manager.abort(id, "agent")).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(record.lifecycle.status).toBe("stopped");

      await settle(cont);
      expect(record.lifecycle.status).toBe("stopped");
    });

    it("keeps MessageAgent working on a resumed agent (steers the live session)", async () => {
      const { id, session } = await spawnCompleted();
      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);
      await manager.steer(id, "answer", { source: "user" });

      await expect(manager.steer(id, "and one more thing")).resolves.toBe(true);
      expect(session.steer).toHaveBeenCalledWith("and one more thing");
      expect(mockModules.mockContinueAgentSession).toHaveBeenCalledTimes(1);
    });

    it("gives the resumed run a fresh idle clock", async () => {
      vi.useFakeTimers();
      mockStoreState.idleTimeoutMinutes = 1;
      manager = new AgentManager(onComplete);
      const { id, record } = await spawnCompleted();
      vi.advanceTimersByTime(10 * 60_000);
      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);
      await manager.steer(id, "answer", { source: "user" });

      // 10 minutes of the earlier run's silence must not count against the resumed run.
      vi.advanceTimersByTime(50_000);
      expect(record.lifecycle.status).toBe("running");
      // Streamed text of the resumed run feeds the same clock.
      mockModules.mockContinueAgentSession.mock.calls[0][2].onTextDelta("x", "x");
      vi.advanceTimersByTime(50_000);
      expect(record.lifecycle.status).toBe("running");
    });
  });

  describe("usage and output file across a user-steered continuation", () => {
    it("adds the continuation's cost to the session total once, without double-counting the agent", async () => {
      const { id, record, session, run } = spawnRunning();
      const usage = (input: number, cost: number) => ({ input, output: 1, cacheWrite: 0, cacheRead: 0, cost });
      mockModules.mockRunAgent.mock.calls[0][3].onAssistantUsage(usage(10, 0.1));
      await settle(run, session);
      expect(manager.getTotalAgentCount()).toBe(1);
      expect(manager.getTotalAgentCost()).toBeCloseTo(0.1);
      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);

      await manager.steer(id, "answer", { source: "user" });
      mockModules.mockContinueAgentSession.mock.calls[0][2].onAssistantUsage(usage(4, 0.05));
      await settle(cont);

      expect(record.stats.lifetimeUsage.input).toBe(14);
      expect(manager.getTotalAgentCount()).toBe(1);
      expect(manager.getTotalAgentCost()).toBeCloseTo(0.15);
    });

    it("keeps appending to the same output file instead of leaving it closed at DONE", async () => {
      const { id, record, session } = await spawnCompleted();
      const firstLog = mockModules.mockAgentOutputLog.mock.results[0].value;
      expect(firstLog.finalize).toHaveBeenCalledTimes(1);
      const cont = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(cont.promise);

      await manager.steer(id, "answer", { source: "user" });

      expect(mockModules.mockAgentOutputLog).toHaveBeenCalledTimes(2);
      const resumeArgs = mockModules.mockAgentOutputLog.mock.calls[1];
      expect(resumeArgs[0]).toBe(id);
      expect(resumeArgs[4]).toBe(record.display.outputFile);
      const resumedLog = mockModules.mockAgentOutputLog.mock.results[1].value;
      expect(resumedLog.attach).toHaveBeenCalledWith(asAgentSession(session));
      expect(record.display.outputFile).toBe("/tmp/out.log");

      await settle(cont);
      expect(resumedLog.finalize).toHaveBeenCalledTimes(1);
      expect(record.execution.outputLog).toBeUndefined();
    });

    it("writes no output file for an agent that never had one", async () => {
      mockStoreState.outputTranscript = false;
      const { id } = await spawnCompleted();
      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);

      await manager.steer(id, "answer", { source: "user" });

      expect(mockModules.mockAgentOutputLog).not.toHaveBeenCalled();
    });
  });
});
