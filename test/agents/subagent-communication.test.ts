import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentRecord, fakeCtx, shellMock } from "../fixtures.js";
import { asAgentSession, asExtensionAPI } from "../pi-boundaries.js";
import { COMMUNICATION_GUIDANCE } from "../../src/prompt/prompts.js";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn<ExtensionAPI["sendMessage"]>(),
  isIdle: vi.fn(() => false),
  steer: vi.fn<(id: string, message: string) => Promise<boolean>>(),
  listAgents: vi.fn(),
  matchAgents: vi.fn(),
  spawnGuard: { depth: 1 },
}));

vi.mock("../../src/shell.js", () =>
  shellMock({
    pi: { sendMessage: mocks.sendMessage },
    sessionCtx: { isIdle: mocks.isIdle },
    manager: { steer: mocks.steer, listAgents: mocks.listAgents, matchAgents: mocks.matchAgents },
    store: { agent: { agentStatusLimit: 8 } },
    spawnGuard: mocks.spawnGuard,
  }),
);

import extension from "../../src/index.js";
import { getPiInstance, getSessionCtx, setPiInstance, setSessionCtx } from "../../src/shell.js";

const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
interface StartEvent {
  systemPromptOptions: { sections: Record<string, string> };
}
const on = vi.fn<(event: string, handler: (event: StartEvent) => void) => void>();
const getActiveTools = vi.fn<ExtensionAPI["getActiveTools"]>();
const child = asExtensionAPI({ registerTool, on, getActiveTools });
const senderCtx: ExtensionToolContext = {
  ...fakeCtx(),
  tools: [],
  executeTool: vi.fn<ExtensionToolContext["executeTool"]>(),
};

function tool(name: string) {
  const definition = registerTool.mock.calls.map(([definition]) => definition).find((tool) => tool.name === name);
  if (!definition) throw new Error(`Tool ${name} not registered`);
  return definition;
}

function message(params: Record<string, unknown>) {
  return tool("MessageAgent").execute("call-1", params, undefined, undefined, senderCtx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isIdle.mockReturnValue(false);
  mocks.steer.mockResolvedValue(true);
  mocks.listAgents.mockReturnValue([]);
  setPiInstance(asExtensionAPI({ sendMessage: mocks.sendMessage }));
  setSessionCtx(fakeCtx({ isIdle: mocks.isIdle }));
  extension(child);
});

describe("subagent communication tools", () => {
  it("registers only MessageAgent and AgentStatus without replacing the parent shell", () => {
    const parentPi = getPiInstance();
    const parentCtx = getSessionCtx();
    expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(["MessageAgent", "AgentStatus"]);
    expect(getPiInstance()).toBe(parentPi);
    expect(getSessionCtx()).toBe(parentCtx);
    expect(getPiInstance()).not.toBe(child);
  });

  it.each([undefined, null])("messages a busy parent when agent_id is %s", async (agent_id) => {
    const result = await message({ ...(agent_id === undefined ? {} : { agent_id }), message: "  Need guidance\n" });

    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith(
      {
        customType: "subagent-message",
        content: '[Subagent "test-session" message]\n\nNeed guidance',
        details: {
          sender: "test-session",
          modelName: "Test Model",
          modelId: "model",
          thinkingLevel: senderCtx.thinkingLevel,
        },
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    expect(result.content).toEqual([{ type: "text", text: "Sent to parent" }]);
    expect(mocks.steer).not.toHaveBeenCalled();
  });

  it("persists the originating agent identity and task description for rendering", async () => {
    const record = makeAgentRecord({
      id: "97a7e0e6-4000-400",
      display: { type: "general-purpose", description: "Add cancellable build subprocess scopes" },
      execution: {
        session: asAgentSession({
          sessionManager: senderCtx.sessionManager,
          model: senderCtx.model,
          thinkingLevel: "high",
        }),
      },
    });
    mocks.listAgents.mockReturnValue([record]);
    await message({ message: "Lorem ipsum" });
    expect(mocks.sendMessage.mock.calls[0]?.[0].details).toMatchObject({
      sender: "test-session",
      agentId: record.id,
      type: record.display.type,
      description: record.display.description,
      modelName: "Test Model",
      modelId: "model",
      thinkingLevel: "high",
      turnCount: 1,
      toolUses: 0,
      input: 0,
      output: 0,
      durationMs: expect.any(Number),
    });
  });

  it("wakes an idle parent instead of dropping steering input", async () => {
    mocks.isIdle.mockReturnValue(true);
    await message({ message: "Ready for review" });
    expect(mocks.sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("does not redirect an old child's message into a replacement parent runtime", async () => {
    const replacement = vi.fn<ExtensionAPI["sendMessage"]>();
    setPiInstance(asExtensionAPI({ sendMessage: replacement }));
    setSessionCtx(fakeCtx({ isIdle: () => true }));
    await message({ message: "Still working" });
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage.mock.calls[0]?.[1]?.deliverAs).toBe("steer");
    expect(replacement).not.toHaveBeenCalled();
  });

  it("surfaces delivery failures rather than claiming success", async () => {
    mocks.sendMessage.mockImplementationOnce(() => {
      throw new Error("Parent disposed");
    });
    await expect(message({ message: "Help" })).rejects.toThrow("Parent disposed");
  });

  it.each([undefined, "", " \n "])("rejects an empty message %s", async (messageText) => {
    await expect(message({ message: messageText })).rejects.toThrow("message is required");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps explicit IDs routed through the manager", async () => {
    const target = makeAgentRecord({ id: "abc123de-4000-400" });
    mocks.matchAgents.mockReturnValue([target]);
    const result = await message({ agent_id: "abc123de", message: " Review tests " });
    expect(mocks.steer).toHaveBeenCalledExactlyOnceWith(target.id, "Review tests");
    expect(result.content).toEqual([{ type: "text", text: "Sent (steered)" }]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not treat a blank explicit ID as the parent", async () => {
    await expect(message({ agent_id: " ", message: "Help" })).rejects.toThrow("agent_id is required");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("registers callable tools with the real SDK and accepts omitted/null parent targets", async () => {
    const tempRoot = join(tmpdir(), process.env.PI_SESSION_ID ?? "pi-subagents-lite-tests");
    mkdirSync(tempRoot, { recursive: true });
    const cwd = mkdtempSync(join(tempRoot, "communication-"));
    const settingsManager = SettingsManager.inMemory({});
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      extensionFactories: [extension],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd,
        agentDir: cwd,
        settingsManager,
        sessionManager: SessionManager.inMemory(cwd),
        resourceLoader,
      }));
      await session.bindExtensions({});
      expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "MessageAgent", "AgentStatus"]);
      expect(session.getCallableToolNames()).toEqual(expect.arrayContaining(["MessageAgent", "AgentStatus"]));
      expect(session.getAllTools().map((tool) => tool.name)).not.toContain("Agent");
      expect(session.getAllTools().map((tool) => tool.name)).not.toContain("StopAgent");

      const messageTool = session.agent.state.tools.find((tool) => tool.name === "MessageAgent")!;
      expect(Check(messageTool.parameters, { message: "Help" })).toBe(true);
      expect(Check(messageTool.parameters, { agent_id: null, message: "Help" })).toBe(true);
      expect(Check(messageTool.parameters, { agent_id: "abc123de", message: "Help" })).toBe(true);
      expect(Check(messageTool.parameters, {})).toBe(false);
      await messageTool.execute("real-call", { message: "Help" });
      expect(mocks.sendMessage).toHaveBeenCalledOnce();

      const statusTool = session.agent.state.tools.find((tool) => tool.name === "AgentStatus")!;
      const result = await statusTool.execute("real-status", {});
      expect(result.content).toEqual([
        {
          type: "text",
          text: "No agents running or completed.\n\nDon't poll — completion notifications are delivered to the parent agent.",
        },
      ]);
    } finally {
      session?.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  describe("delivery guidance", () => {
    function startHandler() {
      const call = on.mock.calls.find(([event]) => event === "before_agent_start");
      if (!call) throw new Error("before_agent_start not registered");
      return call[1];
    }

    function run(sections: Record<string, string> = {}) {
      const event = { systemPromptOptions: { sections: { ...sections } } };
      startHandler()(event);
      return event.systemPromptOptions.sections;
    }

    it("adds guidance as a trailing prompt section while MessageAgent is active", () => {
      getActiveTools.mockReturnValue(["read", "MessageAgent"]);
      expect(run({ existing_extension: "Existing extension section" })).toEqual({
        existing_extension: "Existing extension section",
        subagent_communication: COMMUNICATION_GUIDANCE,
      });
      expect(run()).toEqual({ subagent_communication: COMMUNICATION_GUIDANCE });
    });

    it("omits guidance when tool selection deactivates MessageAgent", () => {
      getActiveTools.mockReturnValue(["read", "AgentStatus"]);
      expect(run({ existing_extension: "Existing extension section" })).toEqual({
        existing_extension: "Existing extension section",
      });
    });

    it("does not register a prompt hook outside subagents", () => {
      mocks.spawnGuard.depth = 0;
      on.mockClear();
      extension(
        asExtensionAPI({
          registerTool,
          on,
          getActiveTools,
          registerCommand: vi.fn(),
          registerMessageRenderer: vi.fn(),
        }),
      );
      mocks.spawnGuard.depth = 1;
      expect(on.mock.calls.map(([event]) => event)).not.toContain("before_agent_start");
    });
  });

  it("lists the parent's managed agents without promising child completion notifications", async () => {
    mocks.listAgents.mockReturnValue([makeAgentRecord({ id: "abc123de-4000-400" })]);
    const result = await tool("AgentStatus").execute("status-1", {}, undefined, undefined, senderCtx);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "abc123de (builder) running\n\nDon't poll — completion notifications are delivered to the parent agent.",
      },
    ]);
  });
});
