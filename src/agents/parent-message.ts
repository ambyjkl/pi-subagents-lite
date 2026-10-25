import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getManager } from "../shell.ts";
import { buildAgentDetails } from "./tool-execution.ts";

export interface SubagentMessageDetails extends Record<string, unknown> {
  sender?: string;
  agentId?: string;
  type?: string;
  description?: string;
  modelName?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/** Deliver to the captured parent runtime, not whichever session now owns the shell. */
export async function sendParentMessage(
  parent: ExtensionAPI,
  parentCtx: ExtensionContext,
  senderCtx: ExtensionContext,
  message: unknown,
): Promise<AgentToolResult<undefined>> {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) throw new Error("message is required");

  const sender = senderCtx.sessionManager.getSessionName() ?? senderCtx.sessionManager.getSessionId();
  const record = getManager()
    ?.listAgents()
    .find((record) => record.execution.session?.sessionManager === senderCtx.sessionManager);
  const model = record?.execution.session?.model ?? senderCtx.model;
  const thinking =
    record?.execution.session?.thinkingLevel ?? record?.display.invocation?.thinkingLevel ?? senderCtx.thinkingLevel;
  const details: SubagentMessageDetails = {
    sender,
    ...(record
      ? {
          ...buildAgentDetails(record, { includeStats: true }),
          agentId: record.id,
          type: record.display.type,
          description: record.display.description,
          durationMs: Math.max(0, (record.lifecycle.completedAt ?? Date.now()) - record.lifecycle.startedAt),
        }
      : {}),
    ...(model ? { modelName: model.name, modelId: model.id } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
  };
  parent.sendMessage(
    {
      customType: "subagent-message",
      content: `[Subagent "${sender}" message]\n\n${text}`,
      details,
      display: true,
    },
    {
      deliverAs: parentCtx.isIdle() ? "followUp" : "steer",
      triggerTurn: true,
    },
  );
  return { content: [{ type: "text", text: "Sent to parent" }], details: undefined };
}
