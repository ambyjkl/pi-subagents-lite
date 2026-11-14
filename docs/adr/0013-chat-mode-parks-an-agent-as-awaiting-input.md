# A user-steered agent that ends its turn is awaiting input, not completed

The user steered a RUNNING subagent directly (conversation viewer or `/agents` menu). The subagent
answered with text only and ended its turn. The extension read that as `completed`, sent the main
agent a completed nudge, and the main agent acted on it as final: it merged the agent's branch and
deleted its worktree while the agent was still talking to the user. ADR-0012 covered the user
resuming an agent that had already completed; it did not cover this, and it said the extension
"cannot tell" a final completion from a turn end that waits for the user. For one case it can.

## Decision

A turn end is `awaiting_input` instead of `completed` exactly when **the user steered the agent
while it was running** during that run. The extension records that as a per-agent flag,
`lifecycle.steeredByUser`, and reads it where a run is settled, in the settlement chain of
`AgentManager` (`attachSettlementChain`). No heuristic over the last message is involved: the flag
is set by a fact the extension observed (a `source: "user"` steer reaching a `running` record), not
inferred.

**State machine.**

```
before   queued -> running -> completed | turn_limited | aborted | stopped | error
                                (every plain turn end is "completed")

after    queued -> running --- plain turn end ------------------------> completed
                      |
                      +-- user steers it while running (flag set) --+
                                                                    v
                                              plain turn end -> awaiting_input   (flag cleared)
                                                                    |
              user reply, or MessageAgent -> running (no flag, resumedFromAwaiting)
                                              |-- plain turn end --> completed (one nudge)
                                              |-- user steers it again --> flag set, as above
                           StopAgent / user Stop -> stopped
```

Rules:

1. The flag is set only by a user steer (`source: "user"`) of a record that is `running`, including
   a steer buffered before the session exists. A `MessageAgent` steer, a resume of a settled or
   awaiting agent, and programmatic continuation never set it. A steer that fails to deliver
   restores the previous value.
2. At turn end with the flag set, and only after the aborted, model error and turn-limit outcomes
   have been decided (those keep their status), the record becomes `awaiting_input`. The flag is
   cleared at the same moment, whatever the outcome.
3. `awaiting_input` is **not final**. The session stays alive and resumable, the output file gets
   an `[AWAITING INPUT]` line instead of `[DONE]` (a resume appends after it, as after `[DONE]`),
   and usage is accounted at once.
4. Input from the user, or a `MessageAgent` message, to an awaiting agent resumes it as `running`
   with no flag (`resumedFromAwaiting`). Its next turn end completes normally with exactly one
   nudge. A user steer during that resumed run sets the flag again.
5. Resuming a `completed` agent is unchanged (ADR-0012: Resume notice, superseding nudge).

## What the main agent is told

- **No completed nudge** for the awaiting settlement, and the background agent's one-shot first
  nudge stays unspent, so the real completion nudges later.
- A background agent gets one quiet record (`customType: "subagent-result"`, `triggerTurn: false`,
  never delivered as a steer or follow-up). It states facts and prescribes nothing: the agent is
  waiting on the user, is NOT done, its branch must not be merged and its worktree must not be
  removed, and a completion notification will follow. A busy parent sees it at its next turn
  boundary; an idle parent is not woken. A foreground `Agent` call instead returns an inline
  `[Agent awaiting input — NOT finished]` result.
- `AgentStatus` lists the agent as "awaiting input" with the same warning, always shown (exempt from
  the settled-list limit), and a running agent the user answered says so.
- Answering an awaiting agent sends no Resume notice: no report was ever delivered that could go
  stale, and the completion nudge does not claim to supersede one.

## Decisions on the questions this raises

- **Concurrency slot: released.** An awaiting agent holds no slot. Its turn has ended, so it uses
  no model capacity, and it can wait indefinitely for the user: holding a slot would block queued
  agents behind a person who may never reply. Resuming it re-reserves a slot, exactly like
  resuming a completed agent, and is rejected with the existing "slot may be full" warning when
  none is free. This departs from the first instinct to keep the slot; the cost is that a reply can
  be refused until a slot frees, which the user sees and can retry.
- **Compaction: kept.** `session_compact` clears only `completed` records. An awaiting agent is not
  final, and the user may still answer it.
- **Watchdog: exempt.** The idle check only watches `running` agents. Waiting for the user is not
  inactivity, and the stop would turn a pending question into a mystery `stopped` agent. There is
  no timer: per ADR-0006 a record lives until stopped, cleared or the session ends. Resuming it
  restarts the idle clock.
- **StopAgent / user Stop: allowed.** An awaiting agent is stoppable (`stopped`, normal stop nudge).
  Because it was not counted as done yet, the stop counts it. It is then clearable.
- **MessageAgent: resumes it.** As for any settled agent with a live session, the message restarts
  it with source `agent` and no flag, so it ends `completed`.
- **Clear:** refused while awaiting (live work, ADR-0006). "Stop all", "Clear all" and "Clear done"
  in `/agents` skip it.
- **Done count:** the status bar counts an awaiting agent as active, not done, until it finishes or
  is stopped; its cost is tallied immediately and not counted twice.

## Consequences

- Only a user steer of a running agent can produce the status. A subagent that asks a question on
  its own, unsteered, still completes; that remains indistinguishable from a final answer and is
  reported as completed, as before.
- Every consumer of the status enum had to be audited; the audit is recorded in the changelog and
  commit messages, and `statusLabel()` renders the raw `awaiting_input` as "awaiting input".
