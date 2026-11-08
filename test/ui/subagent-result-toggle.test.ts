import { describe, expect, it } from "vite-plus/test";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderSubagentResultToggleable } from "../../src/ui/subagent-result-toggle.ts";
import type { Theme } from "../../src/ui/types.ts";

const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as unknown as Theme;

const makeMessage = (content = "line one\nline two") => ({
  content,
  details: { type: "general-purpose", status: "completed", description: "d", turnCount: 1, toolUses: 0 },
});

const render = (message: ReturnType<typeof makeMessage>, expanded = false, hide = false): Component =>
  renderSubagentResultToggleable(message, { expanded }, theme, false, "id", hide);

const text = (c: Component) => c.render(80).join("\n");

const mouse = (type: TuiMouseEvent["type"], button: TuiMouseEvent["button"] = "left"): TuiMouseEvent =>
  ({ type, button, x: 3, y: 2, screenX: 3, screenY: 2, width: 80, height: 6 }) as TuiMouseEvent;

const dispatch = (c: Component, event: TuiMouseEvent) => c.handleMouse?.(event);
const click = (c: Component, button: TuiMouseEvent["button"] = "left") => dispatch(c, mouse("click", button));

describe("renderSubagentResultToggleable", () => {
  it("starts collapsed and expands on a left click, then collapses again", () => {
    const card = render(makeMessage());
    expect(text(card)).not.toContain("line two");

    expect(click(card)?.handled).toBe(true);
    expect(text(card)).toContain("line two");

    expect(click(card)?.handled).toBe(true);
    expect(text(card)).not.toContain("line two");
  });

  it("ignores other buttons and event types", () => {
    const card = render(makeMessage());

    expect(click(card, "right")).toBeUndefined();
    expect(dispatch(card, mouse("wheel"))).toBeUndefined();
    expect(text(card)).not.toContain("line two");
  });

  it("keeps the clicked state when pi rebuilds the card from the same message", () => {
    const message = makeMessage();
    click(render(message));

    expect(text(render(message))).toContain("line two");
  });

  it("lets Ctrl+O (a changed global flag) override a click", () => {
    const message = makeMessage();
    click(render(message)); // expanded by click

    expect(text(render(message, true))).toContain("line two"); // global expand
    expect(text(render(message, false))).not.toContain("line two"); // global collapse wins over the click
  });

  it("keeps messages independent", () => {
    const a = makeMessage();
    click(render(a));

    expect(text(render(makeMessage()))).not.toContain("line two");
  });

  it("does not handle clicks when there is nothing to expand", () => {
    expect(click(render(makeMessage("")))).toBeUndefined();
  });

  it("renders nothing and handles no clicks when hidden", () => {
    const card = render(makeMessage(), false, true);

    expect(card.render(80)).toEqual([]);
    expect(click(card)).toBeUndefined();
  });
});
