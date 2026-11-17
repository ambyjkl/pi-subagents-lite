import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSubagentsMdFiles } from "../../src/prompt/subagents-md.js";

describe("loadSubagentsMdFiles", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;

  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-md-"));
    agentDir = path.join(root, "agent");
    cwd = path.join(root, "project");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns nothing when neither file exists", () => {
    expect(loadSubagentsMdFiles({ cwd, agentDir, projectTrusted: true })).toEqual([]);
  });

  it("loads the global file, then the project file", () => {
    write(path.join(agentDir, "SUBAGENTS.md"), "global rule");
    write(path.join(cwd, ".pi", "SUBAGENTS.md"), "project rule");

    expect(loadSubagentsMdFiles({ cwd, agentDir, projectTrusted: true })).toEqual([
      { path: path.join(agentDir, "SUBAGENTS.md"), content: "global rule" },
      { path: path.join(cwd, ".pi", "SUBAGENTS.md"), content: "project rule" },
    ]);
  });

  it("skips the project file for an untrusted target but keeps the global one", () => {
    write(path.join(agentDir, "SUBAGENTS.md"), "global rule");
    write(path.join(cwd, ".pi", "SUBAGENTS.md"), "project rule");

    expect(loadSubagentsMdFiles({ cwd, agentDir, projectTrusted: false }).map((f) => f.content)).toEqual([
      "global rule",
    ]);
  });

  it("does not walk ancestors: only <cwd>/.pi/SUBAGENTS.md counts", () => {
    write(path.join(root, ".pi", "SUBAGENTS.md"), "ancestor rule");
    write(path.join(cwd, "SUBAGENTS.md"), "not under .pi");

    expect(loadSubagentsMdFiles({ cwd, agentDir, projectTrusted: true })).toEqual([]);
  });

  it("ignores an empty file, a directory of that name and a BOM", () => {
    write(path.join(agentDir, "SUBAGENTS.md"), "  \n");
    fs.mkdirSync(path.join(cwd, ".pi", "SUBAGENTS.md"), { recursive: true });
    expect(loadSubagentsMdFiles({ cwd, agentDir, projectTrusted: true })).toEqual([]);

    write(path.join(agentDir, "SUBAGENTS.md"), "\uFEFFrule");
    expect(loadSubagentsMdFiles({ cwd, agentDir, projectTrusted: true })[0]?.content).toBe("rule");
  });
});
