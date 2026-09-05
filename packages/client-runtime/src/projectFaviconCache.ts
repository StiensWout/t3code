import { EnvironmentId } from "@t3tools/contracts";
import {
  getProjectFaviconCacheKey,
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import * as Schema from "effect/Schema";

export const PROJECT_FAVICON_THUMBNAIL_SIZE = 96;
export const PROJECT_FAVICON_MAX_DATA_URL_LENGTH = 32 * 1024;
export const PROJECT_FAVICON_CACHE_MAX_BYTES = 1024 * 1024;
export const PROJECT_FAVICON_CACHE_MAX_ENTRIES = 128;

export interface ProjectFaviconTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
}

const Thumbnail = Schema.String.check(
  Schema.isMaxLength(PROJECT_FAVICON_MAX_DATA_URL_LENGTH),
  Schema.isPattern(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
);
const Entry = Schema.Struct({
  environmentId: EnvironmentId,
  cwd: Schema.String,
  faviconPath: Schema.NullOr(Schema.String),
  revision: Schema.String,
  dataUrl: Thumbnail,
});
const decodeEntries = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Entry)));
const isThumbnail = Schema.is(Thumbnail);

function keyFor(target: ProjectFaviconTarget) {
  return getProjectFaviconResourceKey(target.environmentId, target.cwd, target.faviconPath);
}

/** Stores small, self-contained images so startup never needs an old signed URL. */
export function createProjectFaviconCache(input: {
  readonly read: () => Promise<string | null>;
  readonly write: (json: string) => Promise<void>;
  readonly thumbnail: (url: string, signal: AbortSignal) => Promise<string>;
}) {
  const entries = new Map<string, typeof Entry.Type>();
  const environmentRevisions = new Map<EnvironmentId, number>();
  let hydration: Promise<void> | undefined;
  let writer: Promise<void> | undefined;
  let dirty = false;

  const trim = () => {
    let bytes = 0;
    for (const entry of entries.values()) bytes += entry.dataUrl.length;
    while (
      entries.size > PROJECT_FAVICON_CACHE_MAX_ENTRIES ||
      bytes > PROJECT_FAVICON_CACHE_MAX_BYTES
    ) {
      const oldest = entries.entries().next().value;
      if (!oldest) break;
      bytes -= oldest[1].dataUrl.length;
      entries.delete(oldest[0]);
    }
  };

  const hydrate = () =>
    (hydration ??= (async () => {
      try {
        const json = await input.read();
        if (json === null) return;
        for (const entry of decodeEntries(json)) entries.set(keyFor(entry), entry);
        trim();
      } catch {
        // A missing, corrupt, or unavailable cache must not prevent startup.
      }
    })());

  const persist = () => {
    dirty = true;
    return (writer ??= (async () => {
      while (dirty) {
        dirty = false;
        try {
          await input.write(JSON.stringify([...entries.values()]));
        } catch {
          // Keep the in-memory thumbnail if local storage is full or unavailable.
        }
      }
    })().finally(() => {
      writer = undefined;
      if (dirty) void persist();
    }));
  };

  const peek = (target: ProjectFaviconTarget) => entries.get(keyFor(target))?.dataUrl ?? null;

  const resolve = async (
    target: ProjectFaviconTarget,
    url: string | null,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const environmentRevision = environmentRevisions.get(target.environmentId) ?? 0;
    await hydrate();
    if (signal.aborted || url === null) return peek(target);
    const key = keyFor(target);
    if (isProjectFaviconFallbackUrl(url)) {
      if (entries.delete(key)) void persist();
      return null;
    }
    const revision = getProjectFaviconCacheKey(target.environmentId, target.cwd, url);
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      if (cached.revision === revision) return cached.dataUrl;
    }
    try {
      const dataUrl = await input.thumbnail(url, signal);
      if (
        signal.aborted ||
        environmentRevision !== (environmentRevisions.get(target.environmentId) ?? 0)
      )
        return peek(target);
      if (isThumbnail(dataUrl)) {
        entries.set(key, {
          environmentId: target.environmentId,
          cwd: target.cwd,
          faviconPath: target.faviconPath || null,
          revision,
          dataUrl,
        });
        trim();
        void persist();
        return dataUrl;
      }
    } catch {
      // An outage or failed decode leaves the last successful image visible.
    }
    return peek(target) ?? url;
  };

  return {
    hydrate,
    peek,
    resolve,
    async clearEnvironment(environmentId: EnvironmentId) {
      environmentRevisions.set(environmentId, (environmentRevisions.get(environmentId) ?? 0) + 1);
      await hydrate();
      for (const [key, entry] of entries) {
        if (entry.environmentId === environmentId) entries.delete(key);
      }
      await persist();
    },
    async flush() {
      await writer;
    },
  };
}

export type ProjectFaviconCache = ReturnType<typeof createProjectFaviconCache>;
