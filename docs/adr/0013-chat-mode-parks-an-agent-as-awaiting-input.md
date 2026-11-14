# Chat mode: a turn end the user is waiting on is awaiting input, not completed

The user steered a RUNNING subagent directly (conversation viewer or `/agents` menu). The subagent
answered with text only and ended its turn. The extension read that as `completed`, sent the main
agent a completed nudge, and the main agent acted on it as final: it merged the agent's branch and
deleted its worktree while the agent was still talking to the user. ADR-0012 covered the user
resuming an agent that had already completed; it did not cover this, and it said the extension
"cannot tell" a final completion from a turn end that waits for the user.

The first design here inferred the answer from who steered: a user steer of a running agent made its
next turn end `awaiting_input`. That is wrong in both directions. A steer is often a suggestion
("use A, not B") after which the agent should finish and report; and a user who wants a conversation
may never steer a running agent at all. No other harness infers it either. OpenHands has the agent
call a `finish` tool, and plain text waits for the user; Gemini has `complete_task`; Claude Code and
opencode treat every turn end as idle/completed and their subagents do not ask the user directly.
Only the user knows which conversation this is, so the user declares it.

## Decision

**Chat mode** is a per-agent switch the user flips (`c` in the conversation viewer, "Chat mode" in
the `/agents` agent actions). It is `lifecycle.chatMode` on the record. The switch is inert: it
changes nothing until the agent's next plain turn end, and then it decides what that turn end is.

- Chat mode **on**: a plain turn end is `awaiting_input` (the agent is waiting for the user).
- Chat mode **off** (the default): a plain turn end is `completed`, as before.
- Aborted, model error and turn-limit outcomes keep their own status either way.
- The flag persists across runs until the user turns it off or submits the agent. Nothing the
  extension observes (a steer, a turn end, a stop, a continue) changes it.
- A steer never sets it. The main agent's `MessageAgent` cannot set it and never needs to.
- No tool is added to subagents to declare "finished": the project keeps tool count and context
  light, and a user switch needs none.

**State machine.**

```
queued -> running --- plain turn end, chat mode off ------------------> completed
             |
             +------- plain turn end, chat mode on ------------------> awaiting_input
                                                                          |
   user continues (Enter) or MessageAgent -> running (resumedFromAwaiting)|
   user Submit (s)  -> completed (chat mode cleared, one completion nudge)|
   user Stop / StopAgent -> stopped                                       |
```

| State    | Chat mode | Enter    | `s`                    |
| -------- | --------- | -------- | ---------------------- |
| running  | on or off | steer    | stop                   |
| awaiting | on        | continue | **submit** (one press) |
| awaiting | off       | continue | stop (two presses)     |

**Submit** is how the user says "this conversation is over". It completes the agent, clears chat
mode, appends `[DONE]` to the output file, tallies the completion, and increments the settlement
count so the completion nudge fires for a foreground agent as well as a background one. The main
agent then receives exactly one ordinary completion.

**Steer prefix.** A pi steer is an ordinary user message to the model, indistinguishable from the
task prompt. So that the agent knows who is talking and what to do, a steer the user sends to a
RUNNING agent is stored once, at store time, with a one-line prefix (stored once, so the prompt
cache is not disturbed):

- chat mode off: `(Message from the user. Address it, then continue and finish your task.)`
- chat mode on: `(Message from the user. Reply to it.)`

Continuing a parked or settled agent gets no prefix (the agent has nothing in flight to resume), and
`MessageAgent` text is untouched. The viewer strips the prefix when it shows a user message.
This is the one change here that alters what the agent sees; every other part is UI and
bookkeeping. Claude Code wraps mid-turn user messages similarly.

Rules:

1. At turn end, and only after the aborted, model error and turn-limit outcomes have been decided,
   chat mode on makes the record `awaiting_input`.
2. `awaiting_input` is **not final**. The session stays alive and resumable, the output file gets
   an `[AWAITING INPUT]` line instead of `[DONE]` (a continue appends after it, as after `[DONE]`),
   and usage is accounted at once.
3. Input from the user, or a `MessageAgent` message, to an awaiting agent resumes it as `running`
   (`resumedFromAwaiting`). Chat mode stays as it was, so it may park again at the next turn end.
4. Resuming a `completed` agent is unchanged (ADR-0012: Resume notice, superseding nudge).
5. The cost of forgetting `c`: a user who steers an agent for a progress report without chat mode
   sees it complete, exactly as before this ADR. That keeps today's behaviour for anyone who does
   not use the switch.

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
  it with source `agent`. Chat mode is unchanged, so it parks again if it is still on.
- **Clear:** refused while awaiting (live work, ADR-0006). "Stop all", "Clear all" and "Clear done"
  in `/agents` skip it.
- **Done count:** the status bar counts an awaiting agent as active, not done, until it finishes or
  is stopped; its cost is tallied immediately and not counted twice.

## Consequences

- Only an agent in chat mode can produce the status. A subagent that asks a question on its own,
  with chat mode off, still completes; that remains indistinguishable from a final answer and is
  reported as completed, as before.
- Every consumer of the status enum had to be audited; the audit is recorded in the changelog and
  commit messages, and `statusLabel()` renders the raw `awaiting_input` as "awaiting input".
