/**
 * process-reaper.test.ts — finding and stopping the processes a subagent's bash calls left running.
 * Listers are driven against a fake /proc tree and sample `ps axeww` output; the reaper against fakes;
 * one test reaps a real orphaned process.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createProcFsLister,
  createPsLister,
  createStrayProcessLister,
  parsePsOutput,
  reapSessionProcesses,
  type SessionProcess,
  type StrayProcessLister,
} from "../../src/agents/process-reaper.js";

const SESSION = "0190aaaa-1111-7222-8333-444455556666";
const OTHER = "0190bbbb-1111-7222-8333-444455556666";

describe("createProcFsLister", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reaper-proc-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function proc(pid: number, argv: string[], env: string[]): void {
    mkdirSync(join(root, String(pid)));
    writeFileSync(join(root, String(pid), "cmdline"), argv.join("\0") + "\0");
    writeFileSync(join(root, String(pid), "environ"), env.join("\0") + "\0");
  }

  it("lists every process carrying the session id, whatever its parent", async () => {
    proc(200, ["/usr/bin/vite", "--port", "1"], ["A=1", `PI_SESSION_ID=${SESSION}`]);
    proc(201, ["sleep", "99"], [`PI_SESSION_ID=${SESSION}`]);
    proc(300, ["sleep", "99"], [`PI_SESSION_ID=${OTHER}`]);
    proc(301, ["sleep", "99"], ["PATH=/bin"]);
    mkdirSync(join(root, "self")); // not a pid

    const found = await createProcFsLister(root, 1)(SESSION);

    expect(found.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 200, name: "vite" },
      { pid: 201, name: "sleep" },
    ]);
  });

  it("does not match a longer id that merely starts with the session id", async () => {
    proc(200, ["sleep"], [`PI_SESSION_ID=${SESSION}-extra`]);

    expect(await createProcFsLister(root, 1)(SESSION)).toEqual([]);
  });

  it("never lists its own process, and skips zombies and unreadable entries", async () => {
    proc(100, ["pi"], [`PI_SESSION_ID=${SESSION}`]);
    proc(201, [], [`PI_SESSION_ID=${SESSION}`]); // zombie: empty cmdline
    mkdirSync(join(root, "202")); // exited: no files

    expect(await createProcFsLister(root, 100)(SESSION)).toEqual([]);
  });
});

describe("parsePsOutput", () => {
  const output = [
    "    PID TTY      STAT   TIME COMMAND",
    `  200 ?        Ssl    0:01 /usr/bin/vite --port 1 HOME=/home/a PI_SESSION_ID=${SESSION} PATH=/bin`,
    `  201 pts/1    S      0:00 sleep 99 PI_SESSION_ID=${SESSION}`,
    `  300 ?        S      0:00 sleep 99 PI_SESSION_ID=${OTHER}`,
    `  301 ?        S      0:00 sleep 99 XPI_SESSION_ID=${SESSION}`,
    `  302 ?        S      0:00 sleep 99 PI_SESSION_ID=${SESSION}-extra`,
    `  100 ?        S      0:00 pi PI_SESSION_ID=${SESSION}`,
    "  400 ?        S      0:00 sleep 99 HOME=/home/a",
  ].join("\n");

  it("returns the processes whose environment carries the session id", () => {
    expect(parsePsOutput(output, SESSION, 100)).toEqual([
      { pid: 200, name: "vite" },
      { pid: 201, name: "sleep" },
    ]);
  });

  it("is driven by createPsLister's runner", async () => {
    const run = vi.fn(async () => output);

    expect(await createPsLister(run, 100)(SESSION)).toHaveLength(2);
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("createStrayProcessLister", () => {
  it("has a lister on Linux and other Unix systems, none on Windows", () => {
    expect(createStrayProcessLister("linux")).toBeTypeOf("function");
    expect(createStrayProcessLister("darwin")).toBeTypeOf("function");
    expect(createStrayProcessLister("win32")).toBeUndefined();
  });
});

describe("reapSessionProcesses", () => {
  const noSleep = async (): Promise<void> => {};

  /** A fake machine: processes die from SIGKILL, or from SIGTERM unless they ignore it. */
  function machine(processes: Array<SessionProcess & { ignoresTerm?: boolean }>) {
    const alive = new Map(processes.map((p) => [p.pid, p]));
    const signals: Array<[number, string]> = [];
    const list: StrayProcessLister = async () => [...alive.values()].map(({ pid, name }) => ({ pid, name }));
    const kill = (pid: number, signal: "SIGTERM" | "SIGKILL"): void => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL" || !alive.get(pid)?.ignoresTerm) alive.delete(pid);
    };
    return { list, kill, signals, alive };
  }

  it("does nothing, and reports nothing, when no process is left", async () => {
    const m = machine([]);

    expect(await reapSessionProcesses(SESSION, { list: m.list, kill: m.kill, sleep: noSleep })).toEqual([]);
    expect(m.signals).toEqual([]);
  });

  it("sends SIGTERM only to processes that exit on it", async () => {
    const m = machine([
      { pid: 1, name: "a" },
      { pid: 2, name: "b" },
    ]);

    const reaped = await reapSessionProcesses(SESSION, { list: m.list, kill: m.kill, sleep: noSleep });

    expect(m.signals).toEqual([
      [1, "SIGTERM"],
      [2, "SIGTERM"],
    ]);
    expect(reaped).toEqual([
      { pid: 1, name: "a" },
      { pid: 2, name: "b" },
    ]);
  });

  it("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
    const m = machine([{ pid: 1, name: "stubborn", ignoresTerm: true }]);

    await reapSessionProcesses(SESSION, { list: m.list, kill: m.kill, sleep: noSleep });

    expect(m.signals).toEqual([
      [1, "SIGTERM"],
      [1, "SIGKILL"],
    ]);
    expect(m.alive.size).toBe(0);
  });

  it("gives SIGTERM the grace period before SIGKILL", async () => {
    const m = machine([{ pid: 1, name: "stubborn", ignoresTerm: true }]);
    const sleeps: number[] = [];

    await reapSessionProcesses(SESSION, {
      list: m.list,
      kill: m.kill,
      sleep: async (ms) => void sleeps.push(ms),
      graceMs: 300,
    });

    expect(sleeps.slice(0, 3)).toEqual([100, 100, 100]);
    expect(m.signals.map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("kills a process forked while the others were dying", async () => {
    const m = machine([{ pid: 1, name: "parent", ignoresTerm: true }]);
    const kill = (pid: number, signal: "SIGTERM" | "SIGKILL"): void => {
      m.kill(pid, signal);
      if (signal === "SIGKILL" && pid === 1) m.alive.set(2, { pid: 2, name: "child" });
    };

    const reaped = await reapSessionProcesses(SESSION, { list: m.list, kill, sleep: noSleep });

    expect(m.signals).toContainEqual([2, "SIGKILL"]);
    expect(m.alive.size).toBe(0);
    expect(reaped.map((p) => p.pid)).toEqual([1, 2]);
  });

  it("returns nothing and signals nothing on a platform without a lister", async () => {
    const kill = vi.fn();

    expect(await reapSessionProcesses(SESSION, { list: undefined, kill })).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("ignores a process that is already gone and a lister that fails", async () => {
    const m = machine([{ pid: 1, name: "a" }]);
    const kill = () => {
      throw new Error("ESRCH");
    };
    await expect(
      reapSessionProcesses(SESSION, { list: m.list, kill, sleep: noSleep, graceMs: 100 }),
    ).resolves.toBeDefined();

    const failing: StrayProcessLister = async () => {
      throw new Error("boom");
    };
    await expect(reapSessionProcesses(SESSION, { list: failing })).resolves.toEqual([]);
  });

  it.runIf(process.platform === "linux")("reaps a real orphan that outlived its shell", async () => {
    const id = `reaper-test-${process.pid}-${Date.now()}`;
    // A backgrounded sleep that outlives the shell that started it, like `server &` in a bash call.
    const shell = spawn("sh", ["-c", "sleep 60 & echo $!"], {
      env: { ...process.env, PI_SESSION_ID: id },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = await new Promise<number>((resolve) => shell.stdout.once("data", (d) => resolve(Number(String(d)))));
    await new Promise((resolve) => shell.once("exit", resolve));
    const isAlive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(isAlive()).toBe(true);

    const reaped = await reapSessionProcesses(id, { graceMs: 2000 });

    expect(reaped.map((p) => p.pid)).toContain(pid);
    await vi.waitFor(() => expect(isAlive()).toBe(false), { timeout: 2000 });
  });
});
