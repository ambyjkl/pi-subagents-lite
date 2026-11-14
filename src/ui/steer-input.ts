import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agents/agent-manager.ts";
import { SHORT_ID_LENGTH, type AgentRecord } from "../types.ts";

/**
 * Send what the user typed straight into a subagent (its conversation viewer). The message is
 * marked as the user's, so the main agent is told when it resumes a settled agent. A rejected
 * message (still settling, the model's concurrency slot full, an extension command) is reported
 * instead of vanishing.
 */
export function steerAsUser(
  ctx: Pick<ExtensionContext, "ui">,
  manager: Pick<AgentManager, "steer"> | null | undefined,
  record: Pick<AgentRecord, "id">,
  message: string,
): void {
  const failed = (): void => {
    ctx.ui.notify(
      `Message to ${record.id.slice(0, SHORT_ID_LENGTH)} was not delivered: the agent may still be settling, its model's concurrency slot may be full, or the text is an extension command. Try again.`,
      "warning",
    );
  };
  if (!manager) return failed();
  manager.steer(record.id, message, { source: "user" }).then((sent) => sent || failed(), failed);
}
