import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  createProjectFaviconCache,
  PROJECT_FAVICON_CACHE_MAX_BYTES,
  PROJECT_FAVICON_CACHE_MAX_ENTRIES,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
} from "./projectFaviconCache.ts";

const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
const url = "https://remote.test/api/assets/token-a/vabc-icon.svg";
const image = "data:image/png;base64,aWNvbg==";
const replacement = "data:image/png;base64,bmV3";
const signal = () => new AbortController().signal;

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let persisted: string | null = null;
  const thumbnail = vi.fn(async () => image);
  const storage = {
    read: async () => persisted,
    write: async (json: string) => {
      persisted = json;
    },
    thumbnail,
  };
  return {
    storage,
    thumbnail,
    cache: createProjectFaviconCache(storage),
    persisted: () => JSON.parse(persisted ?? "[]") as Array<{ dataUrl: string }>,
  };
}

describe("persistent project favicon cache", () => {
  it("restores image bytes in a fresh client before any remote response", async () => {
    const { cache, storage, thumbnail } = fixture();
    expect(await cache.resolve(target, url, signal())).toBe(image);
    await cache.flush();
    const reloaded = createProjectFaviconCache(storage);
    await reloaded.hydrate();
    expect(reloaded.peek(target)).toBe(image);
    expect(await reloaded.resolve(target, null, signal())).toBe(image);
    expect(thumbnail).toHaveBeenCalledTimes(1);
  });

  it("reuses the thumbnail when signed URLs or connection origins change", async () => {
    const { cache, thumbnail } = fixture();
    await cache.resolve(target, url, signal());
    expect(
      await cache.resolve(target, "https://new.test/api/assets/token-b/vabc-icon.svg", signal()),
    ).toBe(image);
    expect(thumbnail).toHaveBeenCalledTimes(1);
  });

  it("keeps the old image during refresh and failures, then persists its replacement", async () => {
    const { cache, thumbnail, storage } = fixture();
    await cache.resolve(target, url, signal());
    const next = deferred<string>();
    thumbnail.mockImplementationOnce(() => next.promise);
    const refreshing = cache.resolve(target, url.replace("vabc", "vdef"), signal());
    expect(cache.peek(target)).toBe(image);
    next.resolve(replacement);
    expect(await refreshing).toBe(replacement);
    thumbnail.mockRejectedValueOnce(new Error("offline"));
    expect(await cache.resolve(target, url, signal())).toBe(replacement);
    await cache.flush();
    expect(await createProjectFaviconCache(storage).resolve(target, null, signal())).toBe(
      replacement,
    );
  });

  it("persists confirmed removal and ignores an aborted older thumbnail", async () => {
    const { cache, thumbnail, storage } = fixture();
    await cache.resolve(target, url, signal());
    const next = deferred<string>();
    const started = deferred<void>();
    thumbnail.mockImplementationOnce(() => {
      started.resolve();
      return next.promise;
    });
    const controller = new AbortController();
    const pending = cache.resolve(target, url.replace("vabc", "vdef"), controller.signal);
    await started.promise;
    controller.abort();
    expect(
      await cache.resolve(
        target,
        "https://remote.test/api/assets/token/project-favicon-missing",
        signal(),
      ),
    ).toBeNull();
    next.resolve(replacement);
    await pending;
    await cache.flush();
    expect(await createProjectFaviconCache(storage).resolve(target, null, signal())).toBeNull();
  });

  it("isolates environments, workspaces, and icon selections", async () => {
    const { cache } = fixture();
    await cache.resolve(target, url, signal());
    expect(cache.peek({ ...target, faviconPath: null })).toBe(image);
    expect(cache.peek({ ...target, faviconPath: "brand.svg" })).toBeNull();
    expect(cache.peek({ ...target, cwd: "/other" })).toBeNull();
    expect(cache.peek({ ...target, environmentId: EnvironmentId.make("other") })).toBeNull();
  });

  it("does not restore images for an environment removed during a download", async () => {
    const { cache, thumbnail } = fixture();
    const next = deferred<string>();
    const started = deferred<void>();
    thumbnail.mockImplementationOnce(() => {
      started.resolve();
      return next.promise;
    });
    const pending = cache.resolve(target, url, signal());
    await started.promise;
    await cache.clearEnvironment(target.environmentId);
    next.resolve(image);
    await pending;
    expect(cache.peek(target)).toBeNull();
  });

  it("bounds individual thumbnails, total thumbnail bytes, and entry count", async () => {
    const { cache, thumbnail, persisted } = fixture();
    thumbnail.mockResolvedValueOnce(
      `data:image/png;base64,${"a".repeat(PROJECT_FAVICON_MAX_DATA_URL_LENGTH)}`,
    );
    expect(await cache.resolve(target, url, signal())).toBe(url);
    expect(cache.peek(target)).toBeNull();
    const large = `data:image/png;base64,${"a".repeat(PROJECT_FAVICON_MAX_DATA_URL_LENGTH - 32)}`;
    thumbnail.mockResolvedValue(large);
    for (let i = 0; i < 40; i++) {
      await cache.resolve({ ...target, cwd: `/large-${i}` }, url, signal());
    }
    await cache.flush();
    expect(
      persisted().reduce((total, entry) => total + entry.dataUrl.length, 0),
    ).toBeLessThanOrEqual(PROJECT_FAVICON_CACHE_MAX_BYTES);
    expect(cache.peek({ ...target, cwd: "/large-0" })).toBeNull();
    expect(cache.peek({ ...target, cwd: "/large-39" })).toBe(large);
    thumbnail.mockResolvedValue(image);
    for (let i = 0; i <= PROJECT_FAVICON_CACHE_MAX_ENTRIES; i++) {
      await cache.resolve({ ...target, cwd: `/small-${i}` }, url, signal());
    }
    await cache.flush();
    expect(persisted()).toHaveLength(PROJECT_FAVICON_CACHE_MAX_ENTRIES);
    expect(cache.peek({ ...target, cwd: "/small-0" })).toBeNull();
  });

  it.each(["corrupt JSON", "storage unavailable"])("tolerates %s", async (failure) => {
    const cache = createProjectFaviconCache({
      read: async () => {
        if (failure === "storage unavailable") throw new Error(failure);
        return "invalid JSON";
      },
      write: async () => {
        throw new Error("quota exceeded");
      },
      thumbnail: async () => image,
    });
    expect(await cache.resolve(target, url, signal())).toBe(image);
    await cache.flush();
    expect(cache.peek(target)).toBe(image);
  });
});
