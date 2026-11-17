import fs from "node:fs";
import path from "node:path";

export interface ContextFile {
  path: string;
  content: string;
}

export const SUBAGENTS_FILE = "SUBAGENTS.md";

function readIfFile(filePath: string): ContextFile | undefined {
  try {
    if (!fs.statSync(filePath).isFile()) return undefined;
    const content = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
    return content.trim() ? { path: filePath, content } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Context for subagents only: `<agentDir>/SUBAGENTS.md`, then `<cwd>/.pi/SUBAGENTS.md`.
 * The main agent never reads these. No ancestor walk: `.pi/` of a worktree is its own checkout,
 * so a worktree and its main repo cannot load the same file twice. The project file is a project
 * resource, so an untrusted target skips it.
 */
export function loadSubagentsMdFiles(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}): ContextFile[] {
  const files = [readIfFile(path.join(options.agentDir, SUBAGENTS_FILE))];
  if (options.projectTrusted) files.push(readIfFile(path.join(options.cwd, ".pi", SUBAGENTS_FILE)));
  return files.filter((f): f is ContextFile => f !== undefined);
}
