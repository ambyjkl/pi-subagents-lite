import { getPiInstance, getSessionCtx, getWidget } from "../shell.ts";
import { SHORT_ID_LENGTH } from "../types.ts";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, LiveView, SpawnConfig, ToolActivity } from "../types.ts";
import type { AgentManager, SpawnOptions } from "../agents/agent-manager.ts";
import { buildAgentDetails, formatResultContent } from "../agents/tool-execution.ts";

/**
 * spawn-coordinator.ts — Spawn-and-track coordination for subagents.
 *
 * Single entry point for both LLM tool and menu spawn paths.
 * Owns: Nudge system (schedule/batch/emit), background agent tracking. Live-view
 * state rides on the record (attached here at spawn) so continuations re-feed it.
 * Delegates concurrency and record lifecycle to AgentManager (peers, not ownership).
 *
 * Decision refs: D3 (forward events to live-view), D4 (stats on record only),
 * D6 (Nudge owned here), D2 (peers with AgentManager).
 */

// --- Types ---

/** Input for spawn(). Built by each caller from its own validation. */
export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  runInBackground: boolean;
  /**
   * Parent run's interrupt signal. The coordinator detaches it if the child
   * later promotes itself to background through MessageAgent.
   */
  signal?: AbortSignal;
  /** Narrowed to required — all callers resolve this before spawn. */
  graceTurns: number;
}

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
  isBackground: boolean;
}

// --- Constants ---

/** Batch delay for nudges — only emit one update per batch window (ms). */
const NUDGE_DELAY_MS = 200;

/** Body of the notice that a completed agent is running again because the user steered it directly. */
const RESUME_NOTICE =
  'The user answered or steered this subagent directly, so it is running again. Its earlier "completed" report is not final: do not act on it. A new completion notification will arrive when it truly finishes.';

/** Opens the completion nudge of a run the user restarted, so it reads as replacing the earlier report. */
const RESUMED_RUN_NOTE = "(Resumed by the user after an earlier report; this report supersedes it.)";

// --- SpawnCoordinator ---

export class SpawnCoordinator {
  /** Agent IDs spawned as background — the one-shot first-settlement nudge gate; also backs isBackground(). */
  private backgroundAgentIds = new Set<string>();

  /** Pending nudge agent IDs, batched within the delay window. */
  private pendingNudges = new Set<string>();

  /**
   * Agents whose latest settlement the parent was told about: a delivered completion nudge, or
   * the inline result of a foreground Agent call. Only these need a notice when the user resumes
   * them; for any other the parent has not seen a report that could go stale.
   */
  private reportedToParent = new Set<string>();

  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set during dispose to prevent nudge emission after session replacement. */
  private disposed = false;

  constructor(private manager: AgentManager) {}

  /**
   * Spawn + wire tracking; await completion unless background was requested
   * or the child's active tools enable parent communication.
   */
  async spawn(pi: ExtensionAPI, ctx: ExtensionContext, intent: SpawnIntent): Promise<SpawnResult> {
    // Create live view BEFORE spawn so callbacks can close over it
    const liveView: LiveView = { activeTools: new Map(), responseText: "" };
    const liveViewCallbacks = this.createLiveViewCallbacks(liveView);

    // SpawnConfig fields pass through unchanged; only the intent-only fields
    // (type/prompt/runInBackground/signal) are forwarded explicitly.
    const { type, prompt, runInBackground, signal, ...config } = intent;
    let agentId: string | undefined;
    let isBackground = runInBackground;
    let promotionPending = false;
    let unsubscribeAgentStart: (() => void) | undefined;
    let resolveBackgroundReady!: () => void;
    const backgroundReady = new Promise<void>((resolve) => {
      resolveBackgroundReady = resolve;
    });
    const markBackground = (id: string) => {
      this.backgroundAgentIds.add(id);
      this.manager.detachParentInterrupt(id);
      const record = this.manager.getRecord(id);
      if (record) {
        record.display.invocation = { ...record.display.invocation, runInBackground: true };
      }
    };
    const clearAgentStartSubscription = () => {
      unsubscribeAgentStart?.();
      unsubscribeAgentStart = undefined;
    };
    const promoteToBackground = () => {
      if (isBackground) return;
      if (!agentId) {
        promotionPending = true;
        return;
      }
      const record = this.manager.getRecord(agentId);
      if (!record || record.lifecycle.status !== "running") return;
      isBackground = true;
      clearAgentStartSubscription();
      markBackground(agentId);
      resolveBackgroundReady();
    };
    const spawnOptions: SpawnOptions = {
      ...config,
      isBackground: runInBackground,
      signal,
      ...liveViewCallbacks,
      onBackgroundPromotion: promoteToBackground,
      onSessionCreated: (session) => {
        if (runInBackground) return;
        unsubscribeAgentStart = session.subscribe((event) => {
          if (event.type === "agent_start" && session.getActiveToolNames().includes("MessageAgent")) {
            promoteToBackground();
          }
        });
      },
    };

    agentId = this.manager.spawn(pi, ctx, type, prompt, spawnOptions);
    const record = this.manager.getRecord(agentId)!;
    if (record.execution.promise) {
      void record.execution.promise.then(clearAgentStartSubscription, clearAgentStartSubscription);
    }
    if (promotionPending) {
      promotionPending = false;
      promoteToBackground();
    }
    // Spawn-time state rides on the record so it survives settlement: the
    // live view is re-fed by continuations, and the ctx keeps the UI-notify
    // fallback reachable for any later nudge (continuations included).
    record.execution.liveView = liveView;
    record.execution.spawnCtx = ctx;

    // Ensure widget timer is running so it displays the new agent
    // (menu path calls this explicitly, but tool path doesn't)
    const widget = getWidget();
    if (widget) {
      widget.ensureTimer();
    }

    if (runInBackground) {
      markBackground(agentId);
    } else if (!isBackground) {
      await Promise.race([record.execution.promise, backgroundReady]);
      // Still foreground: the tool call returns the result inline, so the parent has it.
      if (!isBackground) this.reportedToParent.add(agentId);
    }

    return { agentId, record, isBackground };
  }

  /** Read the live view for an agent. Widget calls this. */
  liveView(id: string): LiveView | undefined {
    return this.manager.getRecord(id)?.execution.liveView;
  }

  isBackground(agentId: string): boolean {
    return this.backgroundAgentIds.has(agentId);
  }

  /**
   * Schedule a nudge for an agent.
   * Batches with NUDGE_DELAY_MS window to coalesce rapid completions.
   */
  scheduleNudge(agentId: string): void {
    this.pendingNudges.add(agentId);

    if (this.nudgeTimer) return;

    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      const batch = [...this.pendingNudges];
      this.pendingNudges.clear();

      for (const id of batch) {
        this.emitIndividualNudge(id);
      }
    }, NUDGE_DELAY_MS);
  }

  /**
   * Called by AgentManager's onComplete callback (wired at session_start).
   * Owns the completion side-effects: nudge scheduling. The live view stays
   * on the record — a settled agent can be continued and re-feeds it.
   */
  onAgentComplete(record: AgentRecord): void {
    // One-shot background gate: the first settlement of a background agent
    // nudges and consumes the set entry. Continuation settlements (ordinal
    // >= 2, written by the manager before this callback fires) nudge for both
    // spawn classes — the coordinator never observes steers itself.
    if (this.backgroundAgentIds.delete(record.id) || record.execution.settlementCount >= 2) {
      this.scheduleNudge(record.id);
    }
  }

  /**
   * Called by AgentManager when a settled agent is prompted again (its record is already running).
   *
   * Any completion nudge still waiting in its batch window is stale either way and is dropped.
   * When the user did it, directly in the subagent, the main agent cannot know: if it was told the
   * agent completed, it is now told promptly that the report is superseded, so it never acts on it.
   * Its next completion nudge is then marked as the resumed run's. A resume by the main agent's own
   * MessageAgent needs no notice.
   */
  onAgentResumed(record: AgentRecord, by: "user" | "agent"): void {
    this.pendingNudges.delete(record.id);
    const wasReported = this.reportedToParent.delete(record.id);
    if (by === "user" && wasReported) this.emitResumeNotice(record);
  }

  dispose(): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.pendingNudges.clear();
    this.reportedToParent.clear();
    this.backgroundAgentIds.clear();
    this.disposed = true;
  }

  // ── Private ──

  /** Create callbacks that bridge manager events to a specific live view. */
  private createLiveViewCallbacks(view: LiveView): Pick<SpawnOptions, "onToolActivity" | "onTextDelta"> {
    return {
      onToolActivity: (activity: ToolActivity) => {
        if (activity.type === "start") {
          // Parallel tool calls can start within the same millisecond, so the call id keeps their keys distinct.
          view.activeTools.set(activity.toolCallId ?? `${activity.toolName}_${Date.now()}`, activity.toolName);
        } else if (activity.toolCallId) {
          view.activeTools.delete(activity.toolCallId);
        } else {
          // Synthetic end events (e.g. extension-error) carry no call id: clear the oldest call of that tool.
          for (const [key, name] of view.activeTools) {
            if (name === activity.toolName) {
              view.activeTools.delete(key);
              break;
            }
          }
        }
      },
      onTextDelta: (_delta: string, fullText: string) => {
        view.responseText = fullText;
      },
    };
  }

  private emitIndividualNudge(agentId: string): void {
    // Skip if disposed — prevents stale pi usage after session replacement
    if (this.disposed) return;

    // Read pi from shell at call time so we get a fresh reference after reload.
    const pi = getPiInstance();
    if (!pi) return;

    const record = this.manager.getRecord(agentId);
    if (!record) return;

    const details = buildAgentDetails(record, {
      includeStats: true,
      includeStatus: true,
    });
    // A run the user restarted by typing into the subagent: the main agent may hold an
    // earlier report from it, and this one replaces that.
    const resumedByUser = record.lifecycle.resumedBy === "user";
    if (resumedByUser) details.resumedByUser = true;
    const body = `${resumedByUser ? `${RESUMED_RUN_NOTE}\n\n` : ""}${formatResultContent(record)}`;
    const header = `[Subagent "${record.display.type}" ${record.id.slice(0, SHORT_ID_LENGTH)} ${record.lifecycle.status}]`;

    this.reportedToParent.add(agentId);
    try {
      // Pick delivery mode based on parent session state:
      // - steer: queues while running, delivers before next LLM call
      // - followUp: waits for agent to finish, then delivers
      const ctx = getSessionCtx();
      const parentIdle = ctx?.isIdle?.() ?? true;
      const deliverAs = parentIdle ? "followUp" : "steer";

      pi.sendMessage(
        { customType: "subagent-result", content: `${header}\n\n${body}`, details, display: true },
        { deliverAs, triggerTurn: true },
      );
    } catch {
      // sendMessage failed (shared runtime overwritten by subagent bindCore).
      // Fall back to UI notification using the captured spawning-session context.
      const spawnCtx = record.execution.spawnCtx;
      if (spawnCtx?.ui?.notify) {
        try {
          spawnCtx.ui.notify(`[Subagent "${record.display.type}" ${record.lifecycle.status}] Result available`, "info");
        } catch {
          // ctx may also be stale if session was replaced
        }
      }
    }
  }

  /**
   * Tell the parent that an agent it was told had completed is running again. A busy parent gets
   * it ahead of its next LLM call (it may be about to act on the stale report); an idle parent
   * just records it, so nothing wakes it until the resumed run's own completion nudge.
   */
  private emitResumeNotice(record: AgentRecord): void {
    if (this.disposed) return;
    const pi = getPiInstance();
    if (!pi) return;

    const shortId = record.id.slice(0, SHORT_ID_LENGTH);
    const details = buildAgentDetails(record, { includeStats: true, includeStatus: true });
    details.resumedByUser = true;
    try {
      const parentIdle = getSessionCtx()?.isIdle?.() ?? true;
      pi.sendMessage(
        {
          customType: "subagent-result",
          content: `[Subagent "${record.display.type}" ${shortId} resumed by the user]\n\n${RESUME_NOTICE}`,
          details,
          display: true,
        },
        parentIdle ? { triggerTurn: false } : { deliverAs: "steer", triggerTurn: true },
      );
    } catch {
      try {
        record.execution.spawnCtx?.ui?.notify(
          `[Subagent "${record.display.type}" ${shortId} resumed by the user] Its earlier completed report is superseded`,
          "info",
        );
      } catch {
        // ctx may be stale if the session was replaced
      }
    }
  }
}
