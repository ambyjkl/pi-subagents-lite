/**
 * steer-input.test.ts — What the user types into a subagent is sent as the user's, and a message
 * that does not get through is reported instead of vanishing.
 */
import { describe, it, expect, vi } from "vite-plus/test";
import { steerAsUser } from "../../src/ui/steer-input.js";

function setup(steer: (id: string, msg: string, opts?: { source?: "user" | "agent" }) => Promise<boolean>) {
  const notify = vi.fn();
  const manager = { steer: vi.fn(steer) };
  return { notify, manager, ctx: { ui: { notify } } as never };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("steerAsUser", () => {
  it("steers with the user as the source and stays quiet on success", async () => {
    const { ctx, manager, notify } = setup(async () => true);
    steerAsUser(ctx, manager, { id: "abcdef123456" }, "use main");
    await flush();
    expect(manager.steer).toHaveBeenCalledWith("abcdef123456", "use main", { source: "user" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("warns when the manager refuses the message", async () => {
    const { ctx, manager, notify } = setup(async () => false);
    steerAsUser(ctx, manager, { id: "abcdef123456" }, "use main");
    await flush();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("abcdef12 was not delivered"), "warning");
  });

  it("warns when sending rejects", async () => {
    const { ctx, manager, notify } = setup(async () => {
      throw new Error("session disposed");
    });
    steerAsUser(ctx, manager, { id: "abcdef123456" }, "use main");
    await flush();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not delivered"), "warning");
  });

  it("warns when there is no manager", () => {
    const { ctx, notify } = setup(async () => true);
    steerAsUser(ctx, null, { id: "abcdef123456" }, "use main");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not delivered"), "warning");
  });
});
