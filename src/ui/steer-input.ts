import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agents/agent-manager.ts";
import { SHORT_ID_LENGTH, type AgentRecord } from "../types.ts";
import type { ConversationViewerOptions } from "./conversation-viewer.ts";

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

/**
 * What the user can do to the agent from its conversation viewer: stop it, steer it, switch chat
 * mode and, once it is parked in chat mode, submit it to the main agent as finished (ADR-0013).
 * Shared by the two places that open the viewer.
 */
export function agentViewerControls(
  ctx: Pick<ExtensionContext, "ui">,
  manager: Pick<AgentManager, "abort" | "steer" | "setChatMode" | "submit"> | null | undefined,
  record: Pick<AgentRecord, "id">,
): Pick<ConversationViewerOptions, "onStop" | "onSteer" | "onSetChatMode" | "onSubmit"> {
  return {
    onStop: () => manager?.abort(record.id, "user"),
    onSteer: (message) => steerAsUser(ctx, manager, record, message),
    onSetChatMode: (enabled) => manager?.setChatMode(record.id, enabled),
    onSubmit: () => manager?.submit(record.id),
  };
}
