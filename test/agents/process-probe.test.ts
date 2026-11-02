/**
 * process-probe.test.ts — /proc-based discovery of the programs a subagent's bash call is running.
 * Drives the public probe against a fake /proc tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  createProcessProbe,
  createProcFsProbe,
  parseParentPid,
  parseProgramName,
} from "../../src/agents/process-probe.js";

const PI_PID = 100;

describe("parseParentPid", () => {
  it("reads the parent pid after the comm field", () => {
    expect(parseParentPid("123 (bash) S 100 123 123 0 -1")).toBe(100);
  });

  it("survives spaces and parentheses in comm", () => {
    expect(parseParentPid("123 (my (odd) proc) S 77 123 123 0 -1")).toBe(77);
  });

  it("returns undefined for malformed input", () => {
    expect(parseParentPid("garbage")).toBeUndefined();
  });
});

describe("parseProgramName", () => {
  it("takes the basename of argv0", () => {
    expect(parseProgramName("/usr/bin/sleep\0 5\0")).toBe("sleep");
  });

  it("drops the leading dash of a login shell", () => {
    expect(parseProgramName("-bash\0")).toBe("bash");
  });

  it("is empty for an empty cmdline (zombie)", () => {
    expect(parseProgramName("")).toBe("");
  });
});

describe("createProcFsProbe", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "proc-probe-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function addProcess(pid: number, ppid: number, argv: string[], env: string[] = []): void {
    const dir = join(root, String(pid));
    mkdirSync(dir);
    writeFileSync(join(dir, "stat"), `${pid} (${argv[0] ?? "x"}) S ${ppid} ${pid} ${pid} 0 -1`);
    writeFileSync(join(dir, "cmdline"), argv.length > 0 ? `${argv.join("\0")}\0` : "");
    writeFileSync(join(dir, "environ"), env.length > 0 ? `${env.join("\0")}\0` : "");
  }

  const probe = () => createProcFsProbe(root, PI_PID);

  it("lists the programs of a pipeline inside a subshell, dropping the shells", async () => {
    addProcess(PI_PID, 1, ["pi"]);
    addProcess(200, PI_PID, ["/bin/bash", "-c", "x"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["bash", "-c", "x"]); // ( … ) subshell
    addProcess(202, 201, ["sleep", "5"]);
    addProcess(203, 201, ["cat"]);

    expect(await probe().runningPrograms("mine")).toEqual(["sleep", "cat"]);
  });

  it("stops at the first non-shell program and does not report its children", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["pnpm", "test"]);
    addProcess(202, 201, ["node", "vitest"]);
    addProcess(203, 202, ["sh", "-c", "x"]);

    expect(await probe().runningPrograms("mine")).toEqual(["pnpm"]);
  });

  it("looks through wrappers like timeout and reports the program they run, in every pipeline stage", async () => {
    addProcess(200, PI_PID, ["bash", "-c", "x"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["timeout", "20", "foo"]);
    addProcess(202, 201, ["foo"]);
    addProcess(203, 200, ["bar"]);
    addProcess(204, 200, ["nice", "-n", "5", "env", "A=1", "baz"]);
    addProcess(205, 204, ["env", "A=1", "baz"]);
    addProcess(206, 205, ["baz"]);

    expect(await probe().runningPrograms("mine")).toEqual(["foo", "bar", "baz"]);
  });

  it("reports a wrapper that has not started its program yet", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["timeout", "20", "foo"]);

    expect(await probe().runningPrograms("mine")).toEqual(["timeout"]);
  });

  it("descends through nested shells and $(…) substitutions", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["bash"]);
    addProcess(202, 201, ["sh"]);
    addProcess(203, 202, ["grep", "x"]);

    expect(await probe().runningPrograms("mine")).toEqual(["grep"]);
  });

  it("reports the shell's own program when bash exec'd its last command", async () => {
    addProcess(200, PI_PID, ["sleep", "30"], ["PI_SESSION_ID=mine"]);

    expect(await probe().runningPrograms("mine")).toEqual(["sleep"]);
  });

  it("reports nothing while the shell has no children", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);

    expect(await probe().runningPrograms("mine")).toEqual([]);
  });

  it("keeps repeated programs, one entry per process in tree order", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["curl"]);
    addProcess(202, 200, ["jq"]);
    addProcess(203, 200, ["curl"]);

    expect(await probe().runningPrograms("mine")).toEqual(["curl", "jq", "curl"]);
  });

  it("ignores shells of other sessions and processes not parented by pi", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=other"]);
    addProcess(201, 200, ["theirs"]);
    addProcess(300, 1, ["bash"], ["PI_SESSION_ID=mine"]); // same id, wrong parent
    addProcess(301, 300, ["stranger"]);
    addProcess(400, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(401, 400, ["ours"]);

    expect(await probe().runningPrograms("mine")).toEqual(["ours"]);
  });

  it("does not match a session id that merely starts with the requested one", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine-2"]);
    addProcess(201, 200, ["sleep"]);

    expect(await probe().runningPrograms("mine")).toEqual([]);
  });

  it("covers every concurrent bash call of the session", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["make"]);
    addProcess(210, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(211, 210, ["tsc"]);

    expect(await probe().runningPrograms("mine")).toEqual(["make", "tsc"]);
  });

  it("skips zombies with an empty cmdline", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, []);
    addProcess(202, 200, ["sleep"]);

    expect(await probe().runningPrograms("mine")).toEqual(["sleep"]);
  });

  it("skips processes whose files vanished or are unreadable", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["sleep"]);
    rmSync(join(root, "201", "cmdline"));
    mkdirSync(join(root, "202")); // no stat at all

    expect(await probe().runningPrograms("mine")).toEqual([]);
  });

  it("returns nothing when /proc does not exist", async () => {
    expect(await createProcFsProbe(join(root, "missing"), PI_PID).runningPrograms("mine")).toEqual([]);
  });

  it("finds this very test process's children on a real /proc", async () => {
    if (process.platform !== "linux") return;
    expect(await createProcFsProbe().runningPrograms(`no-such-session-${process.pid}`)).toEqual([]);
  });
});

describe("createProcessProbe", () => {
  it("exists on linux", () => {
    expect(createProcessProbe("linux")).toBeDefined();
  });

  it.each(["darwin", "win32", "freebsd"])("is absent on %s", (platform) => {
    expect(createProcessProbe(platform)).toBeUndefined();
  });
});
