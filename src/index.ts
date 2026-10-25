/**
 * index.ts — Local subagents extension entry point.
 *
 * Stealth tool registration: all tools register at init with no description,
 * promptSnippet, or promptGuidelines; the model param is injected via the
 * tool_call listener. Config lives in ConfigStore (loaded from
 * ~/.pi/agent/subagents-lite.json at session_start); tool execution and
 * menus read/write through it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setPiInstance, isInsideSubagentSpawn, getPiInstance, getSessionCtx } from "./shell.ts";
import { registerTools, registerCommunicationTools } from "./registration.ts";
import { setupEventListeners } from "./events.ts";

export default function (pi: ExtensionAPI) {
  // Child runtimes get communication tools only. Capture the spawning parent,
  // never replace its shell or install parent lifecycle handlers in the child.
  if (isInsideSubagentSpawn()) {
    registerCommunicationTools(pi, { pi: getPiInstance(), ctx: getSessionCtx() });
    return;
  }
  setPiInstance(pi);
  registerTools(pi);
  setupEventListeners(pi);
}
