/**
 * agent-widget-awaiting-input.test.ts — An agent parked for the user's reply (ADR-0013) is alive,
 * not finished: it shows as "awaiting input", never ages out, counts as active in the status bar,
 * and its cost is not counted twice.
 */
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { agentConfigMock } from "../agent-types-mock.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { AgentRecord } from "../../src/types.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { makeMockManager, makeRunningAgent, makeFinishedAgent, renderWidgetLines } from "./widget-helpers.js";

vi.mock("../../src/agents/agent-types.js", () => ({
  getConfig: (type: string) => ({
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    tools: [],
    maxTurns: undefined,
    thinkingLevel: undefined,
  }),
  getAgentConfig: agentConfigMock(),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string, _width: number) => text,
  visibleWidth: (text: string) => text.length,
}));

function makeAwaitingAgent(id: string, completedMinutesAgo = 1): AgentRecord {
  const agent = makeFinishedAgent(id);
  agent.lifecycle.status = "awaiting_input";
  agent.lifecycle.completedAt = Date.now() - completedMinutesAgo * 60_000;
  return agent;
}

describe("AgentWidget — agent awaiting input", () => {
  let manager: AgentManager;
  let widget: AgentWidget;

  beforeEach(() => {
    manager = makeMockManager([]);
    widget = new AgentWidget(manager, () => undefined);
  });

  it("renders the row with the awaiting icon and an 'awaiting input' status, not 'completed' styling", () => {
    manager.listAgents = () => [makeAwaitingAgent("a1")];

    const lines = renderWidgetLines(widget);

    expect(lines[1]).toContain("[warning:◐]");
    expect(lines[1]).toContain("[warning: awaiting input]");
    expect(lines[1]).not.toContain("[success:");
    expect(lines).toHaveLength(2); // heading + header: no spinner activity line
  });

  it("never ages out of the widget, however long the finished-retention window is exceeded", () => {
    widget.setFinishedRetentionMinutes(1);
    const old = makeFinishedAgent("f1");
    old.lifecycle.completedAt = Date.now() - 30 * 60_000;
    manager.listAgents = () => [makeAwaitingAgent("a1", 30), old];

    const lines = renderWidgetLines(widget);

    expect(lines.some((l) => l.includes("agent a1"))).toBe(true);
    expect(lines.some((l) => l.includes("agent f1"))).toBe(false);
  });

  it("is listed with the running agents, after finished ones", () => {
    const finished = makeFinishedAgent("f1");
    manager.listAgents = () => [finished, makeAwaitingAgent("a1")];

    const lines = renderWidgetLines(widget);

    const order = lines.map((l) => l.match(/agent (f1|a1)/)?.[1]).filter(Boolean);
    expect(order).toEqual(["f1", "a1"]);
  });

  it("does not animate the widget: a parked agent has no spinner", () => {
    manager.listAgents = () => [makeAwaitingAgent("a1")];
    const lines = renderWidgetLines(widget);
    expect(lines.join("\n")).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});

describe("AgentWidget status bar with an agent awaiting input", () => {
  function setup(agents: AgentRecord[], sessionCost: number, done: number) {
    const setStatus = vi.fn<(key: string, text?: string) => void>();
    const manager = makeMockManager(agents, sessionCost, done);
    const widget = new AgentWidget(manager, () => undefined);
    widget.setShowCost(true);
    widget.setUICtx({ setStatus, setWidget: vi.fn() });
    widget.update();
    return setStatus.mock.calls.find((c) => c[0] === "subagents")?.[1];
  }

  it("counts it as active, not done", () => {
    const awaiting = makeAwaitingAgent("a1");

    expect(setup([awaiting], 0, 0)).toBe("◈ Agents: 1 active");
  });

  it("does not count the cost it already tallied twice (session total + its own lifetime cost)", () => {
    const awaiting = makeAwaitingAgent("a1");
    awaiting.stats.lifetimeUsage.cost = 0.5;
    awaiting.execution.talliedCost = 0.5;

    expect(setup([awaiting], 0.5, 0)).toBe("◈ Agents: 1 active · $0.50");
  });

  it("does not count a resumed run's earlier cost twice either", () => {
    const resumed = makeRunningAgent("r1");
    resumed.stats.lifetimeUsage.cost = 0.7; // 0.5 tallied at its last settlement + 0.2 in flight
    resumed.execution.talliedCost = 0.5;

    expect(setup([resumed], 0.5, 1)).toBe("◈ Agents: 1 active · 1 done · $0.70");
  });
});
