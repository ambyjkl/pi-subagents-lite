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

Steering an agent that is still running does not split the run: pi queues the message and drains
the queue before the run ends, so the run settles once, after the steered work. That settlement is
no longer always `completed`: see ADR-0013, where a turn end of an agent the user put in chat mode
is `awaiting_input`.

## Why not a new "awaiting input" status for a resume

For a resume of an already-completed agent the extension still has nothing to go on: a final
completion and a turn end that waits for the user are both an assistant message with no tool call,
and a new status would need a heuristic over the last message. The notice reaches the same goal, the
main agent only acts on a completion that no later user input has superseded.

> **Superseded in part by ADR-0013.** The original text said the extension "cannot tell" the two
> apart. For one case the user can say so: an agent in chat mode (a switch the user flips) is
> mid-conversation with the user, so its turn end is the new non-final `awaiting_input` status
> rather than `completed`. That case is the one that caused the incident (the main agent merged an
> unfinished agent's branch). The resume-of-completed behaviour above is unchanged.

## Consequences

- A completed report can still be acted on in the window before the user types; nothing can prevent
  that, and it is not stale then.
- A completed record cleared by compaction while its nudge is still pending drops that nudge.
