// @effect-diagnostics nodeBuiltinImport:off - the guarded file read needs open
// flags (O_NOFOLLOW, O_NONBLOCK) the FileSystem service does not expose.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";

import {
  type DefaultAppearancePreference,
  EnvironmentTheme,
  type ServerSettingsError,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
  THEME_CSS_MAX_LENGTH,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { themeCssLoadsRemoteFiles } from "@t3tools/shared/themeCss";
import {
  MOBILE_DEFAULT_THEME_ID,
  MOBILE_THEME_IDS,
  UNPUBLISHABLE_THEME_IDS,
} from "@t3tools/shared/themePalettes";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";

const decodeEnvironmentThemeFileJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(EnvironmentThemeFile),
);
const encodeEnvironmentThemeFileJson = Schema.encodeEffect(
  fromJsonStringPretty(EnvironmentThemeFile),
);
const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

const THEME_FILE_SUFFIX = ".json";

const MAX_THEME_FILES = 32;
/**
 * Shared with publishing so it cannot accept files the watcher skips. Fits the longest CSS in any
 * JSON encoding, at up to 6 bytes per character for a `\uXXXX` escape, plus the colors.
 */
export const MAX_THEME_FILE_BYTES = 6 * THEME_CSS_MAX_LENGTH + 16 * 1024;
// Clients cache every published theme in localStorage, which holds about 5 MB per origin.
const MAX_THEME_TOTAL_BYTES = 2 * 1024 * 1024;

/** A theme's background is `<id>.<extension>` beside `<id>.json`; earlier extensions win. */
const THEME_BACKGROUND_EXTENSIONS = ["webp", "png", "jpg", "jpeg"] as const;
const MAX_THEME_BACKGROUND_BYTES = 16 * 1024 * 1024;

interface PublishedThemes {
  readonly seq: number;
  readonly themes: ReadonlyArray<EnvironmentTheme>;
}

const INVALID_ID =
  "is not a valid theme id. Use lowercase letters, digits, and hyphens, and not a built-in name.";
const NOT_PUBLISHED = "could not be published. The themes directory may be full or not writable.";

/** A theme the service will not publish or select. `problem` ends the sentence naming it. */
export class EnvironmentThemeRefusedError extends Schema.TaggedError<EnvironmentThemeRefusedError>()(
  "EnvironmentThemeRefusedError",
  {
    themeId: Schema.String,
    problem: Schema.String,
    known: Schema.optional(Schema.Array(Schema.String)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const known = this.known ? ` Available: ${this.known.join(", ")}.` : "";
    return `Theme "${this.themeId}" ${this.problem}${known}`;
  }
}

/** The settings write that makes a theme or mode the default failed. */
export class EnvironmentThemeNotSelectedError extends Schema.TaggedError<EnvironmentThemeNotSelectedError>()(
  "EnvironmentThemeNotSelectedError",
  {
    /** Absent when only the appearance was set. */
    themeId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const subject = this.themeId === undefined ? "The appearance" : `Theme "${this.themeId}"`;
    return `${subject} was not applied, because the settings could not be saved.`;
  }
}

export class EnvironmentThemeService extends Context.Service<
  EnvironmentThemeService,
  {
    readonly current: Effect.Effect<ReadonlyArray<EnvironmentTheme>>;

    /** The default theme id and the published themes, plus the one named `themeId`. */
    readonly read: (themeId?: string) => Effect.Effect<
      {
        readonly current: string;
        /** Where theme files and their background images live. */
        readonly themesDir: string;
        readonly themes: ReadonlyArray<EnvironmentTheme>;
        readonly theme?: EnvironmentTheme;
      },
      EnvironmentThemeRefusedError | ServerSettingsError
    >;

    /**
     * Makes `themeId` the environment theme and `appearance` its mode, so connected clients
     * switch to them. With `theme`, first publishes that file under the id, replacing one already
     * there.
     */
    readonly apply: (
      input:
        | {
            readonly themeId: string;
            readonly theme?: EnvironmentThemeFile | undefined;
            readonly appearance?: Exclude<DefaultAppearancePreference, ""> | undefined;
          }
        | { readonly appearance: Exclude<DefaultAppearancePreference, ""> },
    ) => Effect.Effect<void, EnvironmentThemeRefusedError | EnvironmentThemeNotSelectedError>;

    /** Subscribes before reading to retain changes during connection. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<EnvironmentTheme>>;
  }
>()("t3/environmentTheme/EnvironmentThemeService") {}

/** True when anything, a dangling symlink included, is at the path. */
const pathIsTaken = (filePath: string): boolean => {
  try {
    NodeFS.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
};

/** Validates and reads one handle; rejects symlinked files, allows symlinked directories.
 * Uses non-blocking opens against FIFOs; Windows lacks these flags and checks symlinks with lstat. */
export const readThemeFileGuarded = (filePath: string, maxBytes: number): string | null => {
  let fd: number;
  try {
    if (NodeFS.constants.O_NOFOLLOW === undefined && NodeFS.lstatSync(filePath).isSymbolicLink()) {
      return null;
    }
    fd = NodeFS.openSync(
      filePath,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
  try {
    const info = NodeFS.fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const contents = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < contents.length) {
      const read = NodeFS.readSync(fd, contents, offset, contents.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    // Unlike Buffer#toString, TextDecoder drops a UTF-8 BOM, which JSON.parse rejects.
    return new TextDecoder().decode(contents.subarray(0, offset));
  } catch {
    return null;
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * The background image published beside `themeId`, if any. Symlinks and oversized files are
 * skipped. `entries` lets a directory scan skip lookups for names it did not list.
 */
export function findThemeBackground(
  themesDir: string,
  themeId: string,
  entries?: ReadonlySet<string>,
): { readonly path: string; readonly revision: string } | null {
  for (const extension of THEME_BACKGROUND_EXTENSIONS) {
    const name = `${themeId}.${extension}`;
    if (entries !== undefined && !entries.has(name)) continue;
    // Native separators: the asset route refuses a path that differs from its canonical form.
    const filePath = NodePath.join(themesDir, name);
    let info: NodeFS.BigIntStats;
    try {
      info = NodeFS.lstatSync(filePath, { bigint: true });
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_THEME_BACKGROUND_BYTES) continue;
    return {
      path: filePath,
      revision: [info.ino, info.size, info.mtimeNs].map((part) => part.toString(36)).join("-"),
    };
  }
  return null;
}

export const readPublishedThemes = Effect.fn(function* (themesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(themesDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  return yield* scanPublishedThemes(themesDir, entries);
});

/** An unreadable entry still takes a slot. Null represents an absent entry. */
interface ThemeLibraryEntry {
  readonly contents: string | null;
}

export function readThemeLibraryEntry(filePath: string): ThemeLibraryEntry | null {
  const contents = readThemeFileGuarded(filePath, MAX_THEME_FILE_BYTES);
  return contents !== null || pathIsTaken(filePath) ? { contents } : null;
}

const scanPublishedThemes = Effect.fnUntraced(function* (
  themesDir: string,
  entries: ReadonlyArray<string>,
  warn = true,
  override?: { readonly name: string; readonly file: ThemeLibraryEntry | null },
) {
  const themes: Array<EnvironmentTheme> = [];
  const entryNames = new Set(entries);
  if (override?.file === null) entryNames.delete(override.name);
  else if (override) entryNames.add(override.name);
  let examined = 0;
  let totalBytes = 0;
  for (const entry of [...entryNames].sort()) {
    if (!entry.endsWith(THEME_FILE_SUFFIX)) continue;
    const id = entry.slice(0, -THEME_FILE_SUFFIX.length);
    // Reserved ids shadow built-ins or capture clients that never chose them.
    if (!isEnvironmentThemeId(id) || UNPUBLISHABLE_THEME_IDS.has(id)) continue;

    // Cap examined files, not accepted themes, to bound work on malformed directories.
    examined += 1;
    if (examined > MAX_THEME_FILES) {
      if (warn)
        yield* Effect.logWarning("ignoring environment theme files past the limit", {
          path: themesDir,
          limit: MAX_THEME_FILES,
        });
      break;
    }

    const filePath = `${themesDir}/${entry}`;
    const raw =
      entry === override?.name
        ? (override.file?.contents ?? null)
        : readThemeFileGuarded(filePath, MAX_THEME_FILE_BYTES);
    if (raw === null) {
      if (warn)
        yield* Effect.logWarning("ignoring unusable environment theme file", {
          path: filePath,
          limit: MAX_THEME_FILE_BYTES,
        });
      continue;
    }
    if (raw.trim().length === 0) continue;

    const decoded = decodeEnvironmentThemeFileJsonExit(raw);
    if (decoded._tag === "Failure") {
      if (warn)
        yield* Effect.logWarning("ignoring invalid environment theme", {
          path: filePath,
          detail: Cause.pretty(decoded.cause),
        });
      continue;
    }
    const file = decoded.value;
    if (!environmentThemeFileHasColors(file)) {
      if (warn)
        yield* Effect.logWarning("ignoring environment theme without colors", { path: filePath });
      continue;
    }

    totalBytes += Buffer.byteLength(raw);
    if (totalBytes > MAX_THEME_TOTAL_BYTES) {
      if (warn)
        yield* Effect.logWarning("ignoring environment themes past the total size limit", {
          path: themesDir,
          limit: MAX_THEME_TOTAL_BYTES,
        });
      break;
    }

    const background = findThemeBackground(themesDir, id, entryNames);
    themes.push({ id, ...file, ...(background ? { background: background.revision } : {}) });
  }
  return themes;
});

class ThemeLibraryPublishError extends Schema.TaggedError<ThemeLibraryPublishError>()(
  "ThemeLibraryPublishError",
  {
    reason: Schema.Literals(["full", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const PUBLISH_LEASE_STALE_MS = 120_000;
const publishUnavailable = (cause: unknown) =>
  new ThemeLibraryPublishError({ reason: "unavailable", cause });

const acquirePublishLease = Effect.fn("EnvironmentTheme.acquirePublishLease")(function* (
  themesDir: string,
) {
  const lockPath = NodePath.join(themesDir, ".publish.lock");
  const statLease = () => NodeFS.lstatSync(lockPath, { bigint: true, throwIfNoEntry: false });
  let original: NodeFS.BigIntStats | null | undefined;
  let compromised: Error | undefined;
  const isSameLease = (current: NodeFS.BigIntStats | undefined) =>
    original != null &&
    current !== undefined &&
    current.dev === original.dev &&
    current.ino === original.ino &&
    current.birthtimeNs === original.birthtimeNs;

  // Both release and the exit hook must leave a successor's lock directory alone.
  const removeLease = (path: string) => {
    if (original === undefined || isSameLease(statLease())) NodeFS.rmdirSync(path);
  };
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        lock(themesDir, {
          lockfilePath: lockPath,
          stale: PUBLISH_LEASE_STALE_MS,
          update: 10_000,
          retries: { retries: 20, factor: 1, minTimeout: 50, maxTimeout: 50 },
          onCompromised: (error) => {
            compromised = error;
          },
          fs: {
            ...NodeFS,
            rmdirSync: removeLease,
            rmdir: (path: string, callback: (error: NodeJS.ErrnoException | null) => void) => {
              try {
                removeLease(path);
              } catch (error) {
                callback(error as NodeJS.ErrnoException);
                return;
              }
              callback(null);
            },
          },
        }),
      catch: publishUnavailable,
    }),
    (release) =>
      Effect.tryPromise({ try: () => release(), catch: publishUnavailable }).pipe(
        Effect.ignore({ log: true }),
      ),
  );

  original = null;
  original = yield* Effect.try({ try: () => statLease() ?? null, catch: publishUnavailable });
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.try({
        try: () => {
          if (compromised) throw compromised;
          const current = statLease();
          if (
            !current ||
            !isSameLease(current) ||
            current.mtime.getTime() < now - PUBLISH_LEASE_STALE_MS
          ) {
            throw new Error("Theme publish lease was lost.");
          }
        },
        catch: publishUnavailable,
      }),
    ),
  );
});

const withLibraryLease = Effect.fn("EnvironmentTheme.withLibraryLease")(function* <A, E, R>(
  themesDir: string,
  use: (checkLease: Effect.Effect<void, ThemeLibraryPublishError>) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(themesDir, { recursive: true }).pipe(Effect.mapError(publishUnavailable));
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const checkLease = yield* acquirePublishLease(themesDir);
      yield* checkLease;
      return yield* use(checkLease);
    }),
  );
});

export const selectPublishedTheme = Effect.fn("EnvironmentTheme.selectPublishedTheme")(function* <
  E,
  R,
  E2,
  R2,
>(themesDir: string, resolve: Effect.Effect<void, E, R>, select: Effect.Effect<void, E2, R2>) {
  yield* withLibraryLease(themesDir, (checkLease) =>
    resolve.pipe(Effect.andThen(checkLease.pipe(Effect.andThen(select), Effect.uninterruptible))),
  );
});

function preservesServedThemes(
  themeId: string,
  previous: ReadonlyArray<EnvironmentTheme>,
  next: ReadonlyArray<EnvironmentTheme>,
) {
  const served = new Set<string>(next.map(({ id }) => id));
  return served.has(themeId) && previous.every(({ id }) => served.has(id));
}

interface ThemePublishBackup {
  readonly previous: ThemeLibraryEntry | null;
  readonly rollback: (destination: "staged" | "missing" | "replaced") => Effect.Effect<void>;
  readonly discard?: Effect.Effect<void>;
}

/** Hold the lease from staging through selection and any rollback. */
export const withThemePublish = Effect.fn("EnvironmentTheme.withThemePublish")(function* <
  E,
  R,
  E2,
  R2,
>(
  themesDir: string,
  themeId: string,
  contents: string,
  backup: (paths: {
    readonly staging: string;
    readonly destination: string;
  }) => Effect.Effect<ThemePublishBackup, E, R>,
  select: (themes: ReadonlyArray<EnvironmentTheme>) => Effect.Effect<void, E2, R2>,
) {
  const fs = yield* FileSystem.FileSystem;
  const name = `${themeId}${THEME_FILE_SUFFIX}`;
  const destination = NodePath.join(themesDir, name);
  const readEntries = fs.readDirectory(themesDir).pipe(Effect.mapError(publishUnavailable));
  const directoryStat = Effect.try({
    try: () => NodeFS.statSync(themesDir, { bigint: true }),
    catch: publishUnavailable,
  });
  const full = new ThemeLibraryPublishError({ reason: "full" });

  return yield* withLibraryLease(themesDir, (checkLease) =>
    Effect.gen(function* () {
      // The reader skips the staging suffix, and exclusive create never follows a symlink.
      const staging = NodePath.join(themesDir, `${name}.staging-${process.pid}`);
      const removeStaging = fs.remove(staging, { force: true });
      return yield* Effect.gen(function* () {
        yield* removeStaging.pipe(
          Effect.andThen(fs.writeFileString(staging, contents, { flag: "wx", mode: 0o644 })),
          Effect.mapError(publishUnavailable),
        );
        const stagedStat = yield* Effect.try({
          try: () => NodeFS.lstatSync(staging),
          catch: publishUnavailable,
        });
        const staged = readThemeFileGuarded(staging, MAX_THEME_FILE_BYTES);
        if (staged !== contents) {
          return yield* publishUnavailable(new Error("Could not read the staged theme."));
        }

        const entries = yield* readEntries;
        const before = yield* scanPublishedThemes(themesDir, entries, false);
        const candidate = yield* scanPublishedThemes(themesDir, entries, false, {
          name,
          file: { contents: staged },
        });
        if (!preservesServedThemes(themeId, before, candidate)) return yield* full;
        yield* checkLease;

        return yield* Effect.gen(function* () {
          const saved = yield* backup({ staging, destination });
          const destinationState = () => {
            try {
              const current = NodeFS.lstatSync(destination, { throwIfNoEntry: false });
              if (!current) return "missing";
              if (current.dev === stagedStat.dev && current.ino === stagedStat.ino) return "staged";
            } catch {}
            return "replaced";
          };
          yield* Effect.gen(function* () {
            yield* fs.rename(staging, destination).pipe(Effect.mapError(publishUnavailable));
            // A direct save can change the listing after readdir. Validate a stable snapshot.
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const start = yield* directoryStat;
              const currentEntries = yield* readEntries;
              const previous = yield* scanPublishedThemes(themesDir, currentEntries, false, {
                name,
                file: saved.previous,
              });
              const next = yield* scanPublishedThemes(themesDir, currentEntries, false);
              const end = yield* directoryStat;
              if (
                start.dev !== end.dev ||
                start.ino !== end.ino ||
                start.mtimeNs !== end.mtimeNs ||
                start.ctimeNs !== end.ctimeNs
              )
                continue;
              if (destinationState() !== "staged") {
                return yield* publishUnavailable(new Error("The staged theme was replaced."));
              }
              if (!preservesServedThemes(themeId, previous, next)) return yield* full;
              yield* checkLease;
              return yield* select(next);
            }
            return yield* publishUnavailable(new Error("The themes directory kept changing."));
          }).pipe(Effect.onError(() => saved.rollback(destinationState())));
          if (saved.discard) yield* saved.discard;
        }).pipe(Effect.uninterruptible);
      }).pipe(Effect.ensuring(removeStaging.pipe(Effect.ignore)));
    }),
  );
});

const make = Effect.gen(function* () {
  const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Sequence numbers let subscribers drop queued events older than their initial snapshot.
  const changes = yield* PubSub.sliding<PublishedThemes>(1);
  const published = yield* Ref.make<PublishedThemes>({ seq: 0, themes: [] });
  // Serialize read/compare/publish so slow older reads cannot publish with newer sequence numbers.
  const refreshSemaphore = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const expose = Effect.fnUntraced(function* (themes: ReadonlyArray<EnvironmentTheme>) {
    // Compare the whole value so new fields cannot silently miss republishes.
    const [changed, next] = yield* Ref.modify(
      published,
      (previous): readonly [readonly [boolean, PublishedThemes], PublishedThemes] => {
        if (Equal.equals(previous.themes, themes)) return [[false, previous], previous];
        const updated: PublishedThemes = { seq: previous.seq + 1, themes };
        return [[true, updated], updated];
      },
    );
    if (changed) yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
    return next;
  });
  const refresh = refreshSemaphore.withPermits(1)(
    readPublishedThemes(environmentThemesDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.flatMap(expose),
    ),
  );

  yield* fs
    .makeDirectory(environmentThemesDir, { recursive: true })
    .pipe(Effect.ignoreCause({ log: true }));

  // A save emits several events, and fs.watch can fire before content is flushed.
  const watchEvents = fs.watch(environmentThemesDir).pipe(Stream.debounce(Duration.millis(100)));

  yield* refresh;
  yield* Stream.runForEach(watchEvents, () => refresh.pipe(Effect.ignoreCause({ log: true }))).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(watcherScope),
    Effect.asVoid,
  );

  // Serialize selection with publishes within this server.
  const publishSemaphore = yield* Semaphore.make(1);

  const publish = Effect.fnUntraced(function* (
    themeId: string,
    file: EnvironmentThemeFile,
    select: Effect.Effect<void, EnvironmentThemeNotSelectedError>,
  ) {
    if (UNPUBLISHABLE_THEME_IDS.has(themeId)) {
      return yield* new EnvironmentThemeRefusedError({ themeId, problem: INVALID_ID });
    }
    if (!environmentThemeFileHasColors(file)) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: "has no colors. Give canvas and accent, or at least one color role.",
      });
    }
    if (file.css !== undefined && themeCssLoadsRemoteFiles(file.css)) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem:
          "has CSS that loads files. Remove @import, image-set(), and url() that is not data: or #id.",
      });
    }
    const contents = yield* encodeEnvironmentThemeFileJson(file).pipe(
      Effect.mapError(
        (cause) => new EnvironmentThemeRefusedError({ themeId, problem: NOT_PUBLISHED, cause }),
      ),
    );
    if (Buffer.byteLength(contents) > MAX_THEME_FILE_BYTES) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: `is larger than ${MAX_THEME_FILE_BYTES} bytes.`,
      });
    }

    yield* refreshSemaphore.withPermits(1)(
      withThemePublish(
        environmentThemesDir,
        themeId,
        contents,
        ({ staging, destination }) =>
          Effect.gen(function* () {
            const previous = readThemeLibraryEntry(destination);
            if (previous !== null && previous.contents === null) {
              return yield* new EnvironmentThemeRefusedError({
                themeId,
                problem: "would replace a file that could not be backed up. Use another theme id.",
              });
            }
            const restore =
              previous?.contents == null
                ? fs.remove(destination, { force: true })
                : fs
                    .writeFileString(staging, previous.contents, { flag: "wx" })
                    .pipe(Effect.andThen(fs.rename(staging, destination)));
            return {
              previous,
              rollback: (state) => (state === "staged" ? restore.pipe(Effect.ignore) : Effect.void),
            } satisfies ThemePublishBackup;
          }),
        (themes) => select.pipe(Effect.andThen(expose(themes)), Effect.asVoid),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.catchTags({
          ThemeLibraryPublishError: (cause) =>
            new EnvironmentThemeRefusedError({ themeId, problem: NOT_PUBLISHED, cause }),
        }),
      ),
    );
  });

  const apply: EnvironmentThemeService["Service"]["apply"] = Effect.fn(
    "EnvironmentThemeService.apply",
  )(function* (input) {
    const themeId = "themeId" in input ? input.themeId : undefined;
    const theme = "theme" in input ? input.theme : undefined;
    const { appearance } = input;
    if (themeId !== undefined && !isEnvironmentThemeId(themeId)) {
      return yield* new EnvironmentThemeRefusedError({ themeId, problem: INVALID_ID });
    }
    // Timestamps make clients apply a set again when its value did not change. Theme and
    // appearance have one each, so setting one does not undo a later local choice of the other.
    // The stock theme is an empty default with a set time, which clients adopt as stock.
    const defaultTheme = themeId === MOBILE_DEFAULT_THEME_ID ? "" : themeId;
    const select = Effect.gen(function* () {
      const setAt = DateTime.formatIso(yield* DateTime.now);
      yield* settings
        .updateSettings({
          ...(defaultTheme === undefined ? {} : { defaultTheme, defaultThemeSetAt: setAt }),
          ...(appearance === undefined
            ? {}
            : { defaultAppearance: appearance, defaultAppearanceSetAt: setAt }),
        })
        .pipe(Effect.mapError((cause) => new EnvironmentThemeNotSelectedError({ themeId, cause })));
    });
    // One at a time, so a selection never sees a file that a failed publish then takes back.
    // If the theme cannot be selected, the file it replaced comes back.
    yield* publishSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (themeId === undefined) return yield* select;
        if (theme === undefined) {
          if (MOBILE_THEME_IDS.some((id) => id === themeId)) return yield* select;
          const resolve = Effect.gen(function* () {
            const known = [...MOBILE_THEME_IDS, ...(yield* refresh).themes.map(({ id }) => id)];
            if (!known.includes(themeId)) {
              return yield* new EnvironmentThemeRefusedError({
                themeId,
                problem: "is not a built-in or published theme.",
                known,
              });
            }
          });
          return yield* selectPublishedTheme(environmentThemesDir, resolve, select).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.catchTags({
              ThemeLibraryPublishError: (cause) =>
                new EnvironmentThemeRefusedError({
                  themeId,
                  problem: "could not be selected. Try again.",
                  cause,
                }),
            }),
          );
        }
        yield* publish(themeId, theme, select);
      }),
    );
  });

  const read: EnvironmentThemeService["Service"]["read"] = Effect.fn(
    "EnvironmentThemeService.read",
  )(function* (themeId) {
    const { themes } = yield* refresh;
    const { defaultTheme } = yield* settings.getSettings;
    const themesDir = environmentThemesDir;
    if (themeId === undefined) return { current: defaultTheme, themesDir, themes };
    const theme = themes.find((candidate) => candidate.id === themeId);
    if (theme === undefined) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: "is not a published theme.",
        known: themes.map(({ id }) => id),
      });
    }
    return { current: defaultTheme, themesDir, themes, theme };
  });

  return {
    current: Effect.map(refresh, (state) => state.themes),
    read,
    apply,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* refresh;
          return Stream.concat(
            Stream.make(snapshot.themes),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.seq > snapshot.seq),
              Stream.map((update) => update.themes),
            ),
          );
        }),
      );
    },
  } satisfies EnvironmentThemeService["Service"];
});

export const layer = Layer.effect(EnvironmentThemeService, make);
