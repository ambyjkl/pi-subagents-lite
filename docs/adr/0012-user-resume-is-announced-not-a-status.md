# A user resuming a completed subagent is announced, not a new status

A user who types into a subagent after it completed (conversation viewer or `/agents` menu) left the
main agent holding a "completed" report for an agent that was running again. It could act on that
report, or on its own earlier conclusion, while the user was still talking to the subagent.

## Decision

Keep one lifecycle: every run end is `completed`, and a resumed agent is the same agent, same id,
status `running` again. When the user resumes an agent the main agent was told had completed, the
extension sends a **Resume notice** at once: delivered as a steer when the main agent is busy (it
reaches it before its next model call), only recorded when it is idle. The resumed run's completion
nudge says it supersedes the earlier report, and `AgentStatus` marks the running agent as resumed by
the user. A resume by `MessageAgent` is silent, and so is one for an agent whose completion was never
announced.

Steering an agent that is still running changes nothing: pi queues the message and drains the queue
before the run ends, so the run settles once, after the steered work.

## Why not a new "awaiting input" status

The extension cannot tell a final completion from a turn end that is waiting for the user: both are
an assistant message with no tool call. A new status would need a heuristic over the last message,
and would touch every place that enumerates statuses (widget, menus, statistics, nudges, compaction
clearing, concurrency). The notice reaches the same goal, the main agent only acts on a completion
that no later user input has superseded, without changing the contract of `completed`.

## Consequences

- A completed report can still be acted on in the window before the user types; nothing can prevent
  that, and it is not stale then.
- A completed record cleared by compaction while its nudge is still pending drops that nudge.
