import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * process-probe.ts — what a subagent's `bash` tool call is running right now.
 *
 * pi spawns each bash call as a direct child of the pi process and exposes the
 * calling session's id to it as PI_SESSION_ID. Every subagent has its own
 * session, so the shell belonging to one subagent is the child of this process
 * whose environment carries that id. From that shell we walk down through
 * shell processes (subshells, `$(…)`, `&` groups) and wrapper programs
 * (`timeout foo`, `env X=1 foo`, …) and report the first other program on
 * each branch — no parsing of the command string.
 *
 * Linux only (/proc). Elsewhere createProcessProbe() returns undefined and the
 * widget keeps its generic "running command…" label.
 */

export interface ProcessProbe {
  /** argv0 basenames of the programs currently running under the session's bash calls, one entry per process (repeats kept), in process-tree order. */
  runningPrograms(sessionId: string): Promise<string[]>;
}

/** Program names treated as transparent: the walk descends through them instead of reporting them. */
const SHELL_NAMES = new Set(["bash", "sh", "dash", "ash", "zsh", "ksh", "mksh", "fish"]);

/**
 * Programs that only launch another program: the walk reports what they run (`timeout 5 foo` → foo)
 * rather than them. A wrapper with no child yet (still starting up) is reported itself.
 */
const WRAPPER_NAMES = new Set([
  "timeout",
  "env",
  "nice",
  "nohup",
  "stdbuf",
  "setsid",
  "ionice",
  "time",
  "command",
  "exec",
]);

interface ProcEntry {
  pid: number;
  ppid: number;
}

/** Parent pid from /proc/<pid>/stat. The comm field may contain spaces and parentheses, so parse after the last ")". */
export function parseParentPid(stat: string): number | undefined {
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

/** argv0 basename from raw /proc/<pid>/cmdline contents; a leading "-" (login shell) is dropped. Empty for zombies. */
export function parseProgramName(cmdline: string): string {
  const argv0 = cmdline.split("\0")[0] ?? "";
  return basename(argv0).replace(/^-/, "");
}

async function readProcessTable(procRoot: string): Promise<ProcEntry[]> {
  const names = await readdir(procRoot).catch(() => [] as string[]);
  const entries = await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name): Promise<ProcEntry | undefined> => {
        try {
          const ppid = parseParentPid(await readFile(`${procRoot}/${name}/stat`, "utf8"));
          return ppid === undefined ? undefined : { pid: Number(name), ppid };
        } catch {
          return undefined; // exited between readdir and read
        }
      }),
  );
  return entries.filter((entry): entry is ProcEntry => entry !== undefined);
}

export function createProcFsProbe(procRoot = "/proc", ownPid = process.pid): ProcessProbe {
  const programName = async (pid: number): Promise<string> =>
    readFile(`${procRoot}/${pid}/cmdline`, "utf8").then(parseProgramName, () => "");

  const hasSessionId = async (pid: number, sessionId: string): Promise<boolean> =>
    readFile(`${procRoot}/${pid}/environ`, "utf8").then(
      (environ) => environ.split("\0").includes(`PI_SESSION_ID=${sessionId}`),
      () => false,
    );

  return {
    async runningPrograms(sessionId) {
      const table = await readProcessTable(procRoot);
      const children = new Map<number, number[]>();
      for (const { pid, ppid } of table) {
        const siblings = children.get(ppid);
        if (siblings) siblings.push(pid);
        else children.set(ppid, [pid]);
      }

      const candidates = children.get(ownPid) ?? [];
      const matches = await Promise.all(candidates.map((pid) => hasSessionId(pid, sessionId)));
      const roots = candidates.filter((_, i) => matches[i]).sort((a, b) => a - b);

      const found: string[] = [];
      const visit = async (pid: number): Promise<void> => {
        const name = await programName(pid);
        if (name === "") return;
        const kids = [...(children.get(pid) ?? [])].sort((a, b) => a - b);
        if (SHELL_NAMES.has(name)) {
          for (const child of kids) await visit(child);
          return;
        }
        // Any other process is the program itself: either a direct child of a
        // shell, or the shell's own process after bash exec'd its last command.
        // A wrapper is looked through unless it has nothing to look at yet.
        if (WRAPPER_NAMES.has(name) && kids.length > 0) {
          for (const child of kids) await visit(child);
          return;
        }
        found.push(name);
      };
      for (const root of roots) await visit(root);

      return found;
    },
  };
}

/** The probe for this platform, or undefined where none exists. */
export function createProcessProbe(platform: string = process.platform): ProcessProbe | undefined {
  return platform === "linux" ? createProcFsProbe() : undefined;
}
