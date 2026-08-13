import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => effect(),
    useState: reactHookHarness.useState,
  };
});

import {
  AcpRegistryAgentIcon,
  loadCachedAcpRegistryIcon,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "./AcpRegistryIcon";

describe("ACP Registry icon cache", () => {
  const stored = new Map<string, Response>();
  const match = vi.fn(async (url: string) => stored.get(url)?.clone());
  const put = vi.fn(async (url: string, response: Response) => {
    stored.set(url, response.clone());
  });
  const fetchIcon = vi.fn();

  beforeEach(() => {
    hooks.reset();
    stored.clear();
    match.mockClear();
    put.mockClear();
    fetchIcon.mockReset();
    vi.stubGlobal("caches", { open: vi.fn(async () => ({ match, put })) });
    vi.stubGlobal("fetch", fetchIcon);
  });

  it("single-flights the first fetch and serves later reads from persistent cache", async () => {
    const url = "https://cdn.agentclientprotocol.com/registry/icons/cache-test.svg";
    fetchIcon.mockResolvedValue(
      new Response("<svg/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
    );

    const [first, concurrent] = await Promise.all([
      loadCachedAcpRegistryIcon(url),
      loadCachedAcpRegistryIcon(url),
    ]);
    const cached = await loadCachedAcpRegistryIcon(url);

    expect(first.type).toBe("image/svg+xml");
    expect(concurrent.size).toBe(first.size);
    expect(cached.size).toBe(first.size);
    expect(fetchIcon).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
  });

  it("rejects oversized image responses before caching", async () => {
    const url = "https://cdn.agentclientprotocol.com/registry/icons/oversized.svg";
    fetchIcon.mockResolvedValue(
      new Response("too large", {
        status: 200,
        headers: {
          "content-length": String(513 * 1_024),
          "content-type": "image/svg+xml",
        },
      }),
    );

    await expect(loadCachedAcpRegistryIcon(url)).rejects.toThrow("too large");
    expect(put).not.toHaveBeenCalled();
  });

  it("falls back to the network when CacheStorage cannot be opened", async () => {
    const url = "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg";
    vi.stubGlobal("caches", {
      open: vi.fn(async () => {
        throw new Error("CacheStorage unavailable");
      }),
    });
    fetchIcon.mockResolvedValue(
      new Response("<svg/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
    );

    await expect(loadCachedAcpRegistryIcon(url)).resolves.toMatchObject({
      type: "image/svg+xml",
    });
    expect(fetchIcon).toHaveBeenCalledWith(url, {
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  });

  it("falls back to the network when a persistent cache entry cannot be read", async () => {
    const url = "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg";
    match.mockRejectedValueOnce(new Error("Cache entry unavailable"));
    fetchIcon.mockResolvedValue(
      new Response("<svg/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
    );

    await expect(loadCachedAcpRegistryIcon(url)).resolves.toMatchObject({
      type: "image/svg+xml",
    });
    expect(fetchIcon).toHaveBeenCalledOnce();
  });

  it("accepts only credential-free HTTPS URLs on the official CDN", () => {
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://cdn.agentclientprotocol.com/registry/icons/gemini.png",
      ),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/gemini.png");
    expect(
      resolveOfficialAcpRegistryIconUrl("http://cdn.agentclientprotocol.com/icon.png"),
    ).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl("https://cdn.agentclientprotocol.com.evil/icon.png"),
    ).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl("https://user@cdn.agentclientprotocol.com/icon.png"),
    ).toBeNull();
    expect(officialAcpRegistryIconUrlForAgentId("kilo")).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
    );
    expect(officialAcpRegistryIconUrlForAgentId("../kilo")).toBeNull();
  });

  it("renders the official Kilo SVG directly and removes the fallback only after load", () => {
    const url = "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg";
    fetchIcon.mockImplementation(() => new Promise(() => undefined));
    hooks.beginRender();
    const loading = AcpRegistryAgentIcon({ icon: url }) as ReactElement<Record<string, unknown>>;
    const loadingImage = visitElements(loading, (element) => element.type === "img");

    expect(loadingImage?.props).toMatchObject({
      src: url,
      alt: "",
      decoding: "async",
      referrerPolicy: "no-referrer",
    });
    expect(loadingImage?.props.className).toContain("dark:invert");
    expect(loadingImage?.props.className).toContain("invisible");
    expect(
      visitElements(loading, (element) => element.props["data-slot"] === "acp-icon-fallback"),
    ).not.toBeNull();

    (loadingImage?.props.onLoad as (() => void) | undefined)?.();
    hooks.beginRender();
    const loaded = AcpRegistryAgentIcon({ icon: url }) as ReactElement<Record<string, unknown>>;
    expect(
      visitElements(loaded, (element) => element.type === "img")?.props.className,
    ).not.toContain("invisible");
    expect(
      visitElements(loaded, (element) => element.props["data-slot"] === "acp-icon-fallback"),
    ).toBeNull();

    const loadedImage = visitElements(loaded, (element) => element.type === "img");
    (loadedImage?.props.onError as (() => void) | undefined)?.();
    hooks.beginRender();
    const failed = AcpRegistryAgentIcon({ icon: url }) as ReactElement<Record<string, unknown>>;
    expect(visitElements(failed, (element) => element.type === "img")).toBeNull();
    expect(
      visitElements(failed, (element) => element.props["data-slot"] === "acp-icon-fallback"),
    ).not.toBeNull();
  });
});
