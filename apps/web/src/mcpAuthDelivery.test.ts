import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearMcpAuthDelivery,
  pendingMcpAuthDelivery,
  prepareMcpAuthDelivery,
} from "./mcpAuthDelivery";

afterEach(() => {
  clearMcpAuthDelivery();
  vi.unstubAllGlobals();
});

function callbackWindow(href: string) {
  const replaceState = vi.fn();
  vi.stubGlobal("window", { location: { href }, history: { state: null, replaceState } });
  return replaceState;
}

describe("MCP sign-in callback delivery", () => {
  it("retains the callback for the selected environment while removing credentials from router history", () => {
    const href =
      "https://client.example/auth/mcp-callback?environmentId=remote-env&id=github&state=private-state&code=private-code";
    const replaceState = callbackWindow(href);
    prepareMcpAuthDelivery();
    expect(pendingMcpAuthDelivery()).toEqual({
      environmentId: "remote-env",
      id: "github",
      callbackUrl: href,
    });
    const visible = new URL(replaceState.mock.calls[0]![2]);
    expect(visible.searchParams.get("code")).toBeNull();
    expect(visible.searchParams.get("state")).toBeNull();
    expect(visible.searchParams.get("environmentId")).toBe("remote-env");
    clearMcpAuthDelivery();
    expect(pendingMcpAuthDelivery()).toBeUndefined();
  });

  it("scrubs OAuth error details even when the callback cannot be delivered", () => {
    const replaceState = callbackWindow(
      "https://client.example/auth/mcp-callback?id=t3-code&code=private-code&state=private-state&error=access_denied&error_description=private-details",
    );
    prepareMcpAuthDelivery();
    expect(pendingMcpAuthDelivery()).toBeUndefined();
    const visible = new URL(replaceState.mock.calls[0]![2]);
    expect(visible.searchParams.has("code")).toBe(false);
    expect(visible.searchParams.has("state")).toBe(false);
    expect(visible.searchParams.has("error")).toBe(false);
    expect(visible.searchParams.has("error_description")).toBe(false);
  });

  it("leaves unrelated navigation intact", () => {
    const replaceState = callbackWindow("https://client.example/settings/providers?code=unrelated");
    prepareMcpAuthDelivery();
    expect(replaceState).not.toHaveBeenCalled();
    expect(pendingMcpAuthDelivery()).toBeUndefined();
  });
});
