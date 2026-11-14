/**
 * user-steer.ts — how a message the user types into a RUNNING subagent is worded for it.
 *
 * Unlike the main agent's MessageAgent, whose intent the receiving agent can read from the
 * message itself, a person's steer is ambiguous: "use A instead of B" means carry on, "give me a
 * progress report" means answer and stop. The prefix says which, from the agent's chat mode
 * (ADR-0013): outside it the agent must not treat the message as a reason to end its turn.
 * It is applied once, when the message is stored, so the transcript never changes afterwards.
 */

const CARRY_ON = "(Message from the user. Address it, then continue and finish your task.)";
const REPLY = "(Message from the user. Reply to it.)";
const SEPARATOR = "\n\n";

/** The text delivered to a running subagent for a message the user typed. */
export function userSteerText(message: string, chatMode: boolean): string {
  return `${chatMode ? REPLY : CARRY_ON}${SEPARATOR}${message}`;
}

/** A user message as the user typed it: the prefix `userSteerText` added is dropped. */
export function stripUserSteerPrefix(text: string): string {
  for (const prefix of [CARRY_ON, REPLY]) {
    if (text.startsWith(prefix + SEPARATOR)) return text.slice(prefix.length + SEPARATOR.length);
  }
  return text;
}
