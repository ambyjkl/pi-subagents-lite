/**
 * session-teardown.test.ts — The single child-session disposal path.
 *
 * Pi's AgentSession.dispose() emits no session_shutdown, so extension
 * resources loaded per child spawn would leak. disposeChildSession aborts,
 * emits session_shutdown, then disposes — idempotent per session.
 */

import { describe, it, expect, vi } from "vite-plus/test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { disposeChildSession, reapChildSessionProcesses } from "../../src/agents/session-teardown.js";

const { mockReap } = vi.hoisted(() => ({ mockReap: vi.fn(async (_sessionId: string) => []) }));
vi.mock("../../src/agents/process-reaper.js", () => ({ reapSessionProcesses: mockReap }));

/** The session surface the teardown drives, asserted against the real type. */
interface TeardownSession {
  abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  extensionRunner: { emit: ReturnType<typeof vi.fn<(event: unknown) => Promise<void>>> };
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

function teardownSession(overrides: Partial<TeardownSession> = {}): TeardownSession & AgentSession {
  return {
    abort: vi.fn(async () => {}),
    extensionRunner: { emit: vi.fn(async () => undefined) },
    dispose: vi.fn(),
    ...overrides,
  } as TeardownSession & AgentSession;
}

/** A session that knows its id, as the real one does. */
function identifiedSession(id: string, overrides: Partial<TeardownSession> = {}): TeardownSession & AgentSession {
  const session = teardownSession(overrides);
  Object.assign(session, { sessionManager: { getSessionId: () => id } });
  return session;
}

describe("reapChildSessionProcesses", () => {
  it("reaps the processes of the session's id", async () => {
    await reapChildSessionProcesses(identifiedSession("sess-1"));

    expect(mockReap).toHaveBeenCalledWith("sess-1");
  });

  it("resolves when the session has no id or the reaper throws", async () => {
    await expect(reapChildSessionProcesses(teardownSession())).resolves.toBeUndefined();
    mockReap.mockRejectedValueOnce(new Error("boom"));
    await expect(reapChildSessionProcesses(identifiedSession("sess-2"))).resolves.toBeUndefined();
  });
});

describe("disposeChildSession", () => {
  it("reaps stray processes after the abort and before session_shutdown", async () => {
    const session = identifiedSession("sess-3");
    const order: string[] = [];
    session.abort.mockImplementation(async () => void order.push("abort"));
    mockReap.mockImplementationOnce(async () => {
      order.push("reap");
      return [];
    });
    session.extensionRunner.emit.mockImplementation(async () => void order.push("emit"));

    await disposeChildSession(session);

    expect(order).toEqual(["abort", "reap", "emit"]);
    expect(mockReap).toHaveBeenCalledWith("sess-3");
  });

  it("aborts, then emits session_shutdown (quit), then disposes", async () => {
    const session = teardownSession();
    const order: string[] = [];
    session.abort.mockImplementation(async () => {
      order.push("abort");
    });
    session.extensionRunner.emit.mockImplementation(async () => {
      order.push("emit");
      return undefined;
    });
    session.dispose.mockImplementation(() => {
      order.push("dispose");
    });

    await disposeChildSession(session);

    expect(order).toEqual(["abort", "emit", "dispose"]);
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
  });

  it("is idempotent: a second call disposes exactly once and returns the first teardown", async () => {
    const session = teardownSession();
    const first = disposeChildSession(session);
    const second = disposeChildSession(session);

    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it("proceeds to emit and dispose when abort rejects", async () => {
    const session = teardownSession({
      abort: vi.fn(async () => {
        throw new Error("listener rejected");
      }),
    });

    await disposeChildSession(session);

    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("proceeds to dispose when the shutdown emit rejects", async () => {
    const session = teardownSession({
      extensionRunner: {
        emit: vi.fn(async () => {
          throw new Error("handler failed");
        }),
      },
    });

    await disposeChildSession(session);

    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("never rejects when dispose throws", async () => {
    const session = teardownSession({
      dispose: vi.fn(() => {
        throw new Error("dispose failed");
      }),
    });

    await expect(disposeChildSession(session)).resolves.toBeUndefined();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
