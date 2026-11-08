/**
 * Click-to-expand for the "Subagent Result" card. Pi's message renderer only
 * gets the global `expanded` flag (Ctrl+O); tool rows additionally toggle on a
 * left click, so the card does the same, with the click state kept per message.
 */
import { MouseRegion, type Component } from "@earendil-works/pi-tui";
import { renderSubagentResult } from "./renderer.ts";
import type { Theme } from "./types.ts";

interface ToggleState {
  /** Last global flag seen; a change (Ctrl+O) overrides any click. */
  global: boolean;
  expanded: boolean;
}

// Pi rebuilds the card from the same message object on every invalidation.
const states = new WeakMap<object, ToggleState>();

/** `renderSubagentResult`, plus a left click on the card toggles its expansion. */
export function renderSubagentResultToggleable(
  message: { content?: string; details?: Record<string, unknown> },
  options: { expanded?: boolean },
  theme: Theme,
  showCost: boolean,
  modelDisplayStyle: "id" | "name",
  hide: boolean,
): Component {
  if (hide) return renderSubagentResult(message, options, theme, showCost, modelDisplayStyle, hide);

  const global = !!options.expanded;
  let state = states.get(message);
  if (!state || state.global !== global) {
    state = { global, expanded: global };
    states.set(message, state);
  }
  const current = state;
  const hasBody = !!message.content?.trim() && message.details?.turnCount != null;

  let cached: { expanded: boolean; card: Component } | undefined;
  const card: Component = {
    render(width) {
      if (cached?.expanded !== current.expanded) {
        cached = {
          expanded: current.expanded,
          card: renderSubagentResult(
            message,
            { expanded: current.expanded },
            theme,
            showCost,
            modelDisplayStyle,
            false,
          ),
        };
      }
      return cached.card.render(width);
    },
    invalidate() {
      cached = undefined;
    },
  };

  return new MouseRegion(card, (event) => {
    if (!hasBody || event.type !== "click" || event.button !== "left") return undefined;
    current.expanded = !current.expanded;
    return { handled: true };
  });
}
