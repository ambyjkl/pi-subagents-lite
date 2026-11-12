import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseProgramName } from "./process-probe.ts";

/**
 * process-reaper.ts — stop what a subagent's `bash` calls left running.
 *
 * pi kills a bash call's process group only on abort or timeout. After a normal exit,
 * `server &`, `nohup x &` and `setsid x` keep running, re-parented to init, so walking the process
 * tree from pi no longer finds them. They still carry the PI_SESSION_ID pi gives every bash call of
 * a session, so processes are found by that environment variable instead.
 *
 * Linux reads /proc/<pid>/environ; other Unix systems (macOS, BSD) parse `ps axeww`, which prints
 * each process's environment after its command. Windows has no way to read another process's
 * environment, so createStrayProcessLister() returns undefined and nothing is reaped there.
 * Processes that clear their environment, or belong to another user, are not found.
 */

export interface SessionProcess {
  pid: number;
  /** argv0 basename. */
  name: string;
}

/** Processes whose environment carries the given session id, never including this process. */
export type StrayProcessLister = (sessionId: string) => Promise<SessionProcess[]>;

const SESSION_ENV = "PI_SESSION_ID";

export function createProcFsLister(procRoot = "/proc", ownPid = process.pid): StrayProcessLister {
  return async (sessionId) => {
    const names = await readdir(procRoot).catch(() => [] as string[]);
    const wanted = `${SESSION_ENV}=${sessionId}`;
    const found = await Promise.all(
      names
        .filter((name) => /^\d+$/.test(name) && Number(name) !== ownPid)
        .map(async (name): Promise<SessionProcess | undefined> => {
          try {
            const environ = await readFile(`${procRoot}/${name}/environ`, "utf8");
            if (!environ.split("\0").includes(wanted)) return undefined;
            const program = await readFile(`${procRoot}/${name}/cmdline`, "utf8").then(parseProgramName, () => "");
            return program === "" ? undefined : { pid: Number(name), name: program }; // empty: a zombie
          } catch {
            return undefined; // exited meanwhile, or not ours to read
          }
        }),
    );
    return found.filter((entry): entry is SessionProcess => entry !== undefined);
  };
}

/**
 * Matching processes in `ps axeww` output: `PID TTY STAT TIME COMMAND ENV…` per line. The id is a
 * uuid, so it is matched as a whole word anywhere after the command rather than by parsing the environment.
 */
export function parsePsOutput(output: string, sessionId: string, ownPid = process.pid): SessionProcess[] {
  const wanted = ` ${SESSION_ENV}=${sessionId}`;
  const found: SessionProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+\S+\s+\S+\s+\S+\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const rest = match[2]!;
    if (pid === ownPid) continue;
    const at = rest.indexOf(wanted);
    if (at < 0 || (rest[at + wanted.length] ?? " ") !== " ") continue;
    found.push({ pid, name: basename(rest.split(" ")[0]!) });
  }
  return found;
}

function runPs(): Promise<string> {
  return new Promise((resolve) => {
    // Every process's environment, so the output is large.
    execFile("ps", ["axeww"], { maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

export function createPsLister(run: () => Promise<string> = runPs, ownPid = process.pid): StrayProcessLister {
  return async (sessionId) => parsePsOutput(await run(), sessionId, ownPid);
}

/** The lister for this platform, or undefined where processes cannot be matched by environment. */
export function createStrayProcessLister(platform: string = process.platform): StrayProcessLister | undefined {
  if (platform === "linux") return createProcFsLister();
  if (platform === "win32") return undefined;
  return createPsLister();
}

export interface ReapOptions {
  list?: StrayProcessLister | undefined;
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long SIGTERM gets before SIGKILL, ms. */
  graceMs?: number;
}

const DEFAULT_GRACE_MS = 1500;
const POLL_MS = 100;
/** SIGKILL sweeps after the grace period: the extra ones catch processes forked while others were dying. */
const KILL_SWEEPS = 3;

/**
 * Terminate every process left running by a session: SIGTERM, up to `graceMs` for them to exit, then
 * SIGKILL sweeps. The list is read afresh before each signal, so a recycled pid is never signalled.
 * Returns what was signalled (empty where the platform has no lister). Never rejects.
 */
export async function reapSessionProcesses(sessionId: string, options: ReapOptions = {}): Promise<SessionProcess[]> {
  const list = "list" in options ? options.list : createStrayProcessLister();
  if (!list) return [];
  const kill =
    options.kill ??
    ((pid, signal) => {
      process.kill(pid, signal);
    });
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

  const signalled = new Map<number, SessionProcess>();
  const signalAll = async (signal: "SIGTERM" | "SIGKILL"): Promise<boolean> => {
    const processes = await list(sessionId);
    for (const proc of processes) {
      signalled.set(proc.pid, proc);
      try {
        kill(proc.pid, signal);
      } catch {
        /* already gone */
      }
    }
    return processes.length > 0;
  };

  try {
    if (await signalAll("SIGTERM")) {
      for (let waited = 0; waited < graceMs; waited += POLL_MS) {
        await sleep(POLL_MS);
        if ((await list(sessionId)).length === 0) return [...signalled.values()];
      }
      for (let sweep = 0; sweep < KILL_SWEEPS; sweep++) {
        if (!(await signalAll("SIGKILL"))) break;
        await sleep(POLL_MS);
      }
    }
  } catch {
    /* best effort: a failing listing must not block teardown */
  }
  return [...signalled.values()];
}
