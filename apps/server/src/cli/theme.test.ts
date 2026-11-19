// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import { cli } from "../binCli.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as HostProcess from "@t3tools/shared/HostProcess";

vi.mock("node:fs", { spy: true });

// Windows chmod cannot force these directory or file permission failures.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const runCliProcess = (args: ReadonlyArray<string>, nodeArgs: ReadonlyArray<string> = []) =>
  Effect.tryPromise({
    try: (signal) =>
      execFile(
        process.execPath,
        [...nodeArgs, NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), ...args],
        { signal },
      ),
    catch: (error) =>
      error instanceof Error && "stdout" in error
        ? `${error.message}\n${String(error.stdout)}`
        : String(error),
  });

const runCli = (
  args: ReadonlyArray<string>,
  mapFileSystem: (fs: FileSystem.FileSystem) => FileSystem.FileSystem = (fs) => fs,
) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.updateService(FileSystem.FileSystem, mapFileSystem),
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, TestConsole.layer),
    ),
  );

const makeBaseDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-theme-cli-"));

const settingsPathFor = (baseDir: string) => NodePath.join(baseDir, "userdata", "settings.json");

const NIGHTFALL_THEME_JSON = `${JSON.stringify({
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
})}\n`;
const JUNK_THEME_JSON = `${JSON.stringify({ name: "Junk" })}\n`;
const PREVIOUS_NIGHTFALL_THEME_JSON = NIGHTFALL_THEME_JSON.replace(
  '"Nightfall"',
  '"Previous Nightfall"',
);

const readSettings = (baseDir: string): Record<string, unknown> => {
  const raw = NodeFS.readFileSync(settingsPathFor(baseDir), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
};

const writeSettings = (baseDir: string, settings: Record<string, unknown>) => {
  NodeFS.mkdirSync(NodePath.dirname(settingsPathFor(baseDir)), { recursive: true });
  NodeFS.writeFileSync(settingsPathFor(baseDir), `${JSON.stringify(settings, null, 2)}\n`);
};

describe("t3 theme", () => {
  it.effect("preserves settings it does not recognise", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, {
        enableProviderUpdateChecks: false,
        somethingFromANewerBuild: { nested: true },
      });

      yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]);

      const settings = readSettings(baseDir);
      assert.equal(settings.defaultTheme, "ocean");
      assert.equal(settings.enableProviderUpdateChecks, false);
      assert.deepEqual(settings.somethingFromANewerBuild, { nested: true });
    }),
  );

  it.effect("clears the default back to leaving fresh clients alone", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, { enableProviderUpdateChecks: false });

      yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]);
      yield* runCli(["theme", "clear", "--base-dir", baseDir]);

      const settings = readSettings(baseDir);
      assert.equal(Object.hasOwn(settings, "defaultTheme"), false);
      assert.equal(settings.enableProviderUpdateChecks, false);
    }),
  );

  it.effect("sets the theme of a dev server running in the default home", () =>
    Effect.gen(function* () {
      const home = makeBaseDir();
      const devStateDir = NodePath.join(home, ".t3", "dev");
      NodeFS.mkdirSync(devStateDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(devStateDir, "server-runtime.json"),
        `${JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 4888,
          origin: "http://127.0.0.1:4888",
          devUrl: "http://127.0.0.1:5999",
          startedAt: "1970-01-01T00:00:00.000Z",
        })}\n`,
      );

      const result = yield* runCli(["theme", "set", "ocean"]).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        Effect.result,
      );

      assert.equal(
        NodeFS.existsSync(NodePath.join(home, ".t3", "userdata", "settings.json")),
        false,
      );
      if (result._tag === "Success") {
        const devSettings = NodePath.join(devStateDir, "settings.json");
        assert.equal(JSON.parse(NodeFS.readFileSync(devSettings, "utf8")).defaultTheme, "ocean");
      }
    }),
  );

  it.effect("publishes a theme file under its filename and sets it", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]);

      const published = NodePath.join(baseDir, "userdata", "themes", "nightfall.json");
      assert.equal(NodeFS.existsSync(published), true);
      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
      const residue = NodeFS.readdirSync(NodePath.dirname(published)).filter(
        (entry) => !entry.endsWith(".json"),
      );
      assert.deepEqual(residue, []);
    }),
  );

  it.effect("refuses to publish over a directory with the theme's file name", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const taken = NodePath.join(baseDir, "userdata", "themes", "nightfall.json");
      NodeFS.mkdirSync(taken, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(taken, "notes.txt"), "notes");
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      const failure = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.include(String(failure), "is a directory");
      assert.equal(NodeFS.readFileSync(NodePath.join(taken, "notes.txt"), "utf8"), "notes");
      assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(taken)), ["nightfall.json"]);
      assert.equal(NodeFS.existsSync(settingsPathFor(baseDir)), false);
    }),
  );

  it.effect("refuses to publish over a directory created just before backup", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      const destination = NodePath.join(themesDir, "nightfall.json");
      const notes = NodePath.join(destination, "notes.txt");
      const { renameSync } = yield* Effect.promise(() => vi.importActual<typeof NodeFS>("node:fs"));
      using _insertDirectory = vi.spyOn(NodeFS, "renameSync").mockImplementationOnce((from, to) => {
        NodeFS.mkdirSync(destination);
        NodeFS.writeFileSync(notes, "notes");
        renameSync(from, to);
      });

      const failure = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.include(String(failure), "is a directory");
      assert.equal(NodeFS.readFileSync(notes, "utf8"), "notes");
      assert.deepEqual(NodeFS.readdirSync(themesDir), ["nightfall.json"]);
      assert.equal(NodeFS.existsSync(settingsPathFor(baseDir)), false);
    }),
  );

  it.effect("publishes a theme despite a rollback file left by an earlier process", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      const destination = NodePath.join(themesDir, "nightfall.json");
      const staleBackup = `${destination}.rollback-${process.pid}`;
      NodeFS.mkdirSync(themesDir, { recursive: true });
      NodeFS.writeFileSync(staleBackup, "previous theme");

      yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]);

      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
      assert.equal(NodeFS.readFileSync(destination, "utf8"), NIGHTFALL_THEME_JSON);
      assert.equal(NodeFS.readFileSync(staleBackup, "utf8"), "previous theme");
      assert.deepEqual(NodeFS.readdirSync(themesDir).sort(), [
        "nightfall.json",
        NodePath.basename(staleBackup),
      ]);
    }),
  );

  it.effect("rejects a file that is not a theme and sets nothing", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themeFile = NodePath.join(baseDir, "junk.json");
      NodeFS.writeFileSync(themeFile, JUNK_THEME_JSON);

      const failure = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      assert.include(String(failure), "not a valid theme file");
      assert.equal(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "themes")), false);
      assert.equal(NodeFS.existsSync(settingsPathFor(baseDir)), false);
    }),
  );

  it.effect.each([
    { incoming: "first-in-library", publishes: false },
    { incoming: "past-the-library", publishes: false },
    { incoming: "library-theme-32", publishes: true },
  ])(
    "publishes $incoming into a full library only when every theme stays served",
    ({ incoming, publishes }) =>
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        writeSettings(baseDir, {});
        const themesDir = NodePath.join(baseDir, "userdata", "themes");
        NodeFS.mkdirSync(themesDir, { recursive: true });
        const library = Array.from(
          { length: 32 },
          (_, index) => `library-theme-${String(index + 1).padStart(2, "0")}.json`,
        );
        for (const entry of library) {
          NodeFS.writeFileSync(NodePath.join(themesDir, entry), NIGHTFALL_THEME_JSON);
        }
        if (publishes) {
          NodeFS.writeFileSync(
            NodePath.join(themesDir, `${incoming}.json`),
            PREVIOUS_NIGHTFALL_THEME_JSON,
          );
        }
        const themeFile = NodePath.join(baseDir, "incoming.json");
        NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

        const result = yield* runCli([
          "theme",
          "set",
          themeFile,
          "--id",
          incoming,
          "--base-dir",
          baseDir,
        ]).pipe(Effect.result);

        assert.equal(result._tag === "Success", publishes);
        assert.deepEqual(NodeFS.readdirSync(themesDir).toSorted(), library);
        assert.equal(readSettings(baseDir).defaultTheme, publishes ? incoming : undefined);
        if (publishes) {
          assert.equal(
            NodeFS.readFileSync(NodePath.join(themesDir, `${incoming}.json`), "utf8"),
            NIGHTFALL_THEME_JSON,
          );
        }
      }),
  );

  it.live("allows only one CLI process to take the last slot", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      NodeFS.mkdirSync(themesDir, { recursive: true });
      for (let index = 1; index <= 31; index++) {
        NodeFS.writeFileSync(NodePath.join(themesDir, `theme-${index}.json`), NIGHTFALL_THEME_JSON);
      }
      const themeFile = NodePath.join(baseDir, "incoming.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      const listed = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const args = (id: string) =>
        ["theme", "set", themeFile, "--id", id, "--base-dir", baseDir] as const;
      const first = yield* runCli(args("a-first"), (fs) => ({
        ...fs,
        readDirectory: (path, options) =>
          fs
            .readDirectory(path, options)
            .pipe(
              Effect.tap(() =>
                path === themesDir
                  ? Deferred.succeed(listed, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                  : Effect.void,
              ),
            ),
      })).pipe(Effect.forkScoped);
      yield* Deferred.await(listed);

      const failure = yield* runCliProcess(args("z-last")).pipe(
        Effect.flip,
        Effect.ensuring(Deferred.succeed(resume, undefined)),
      );
      yield* Fiber.join(first);
      assert.include(failure, "Could not publish the theme");
      assert.equal(readSettings(baseDir).defaultTheme, "a-first");
      assert.deepEqual(
        NodeFS.readdirSync(themesDir).filter((entry) => !entry.startsWith("theme-")),
        ["a-first.json"],
      );
    }),
  );

  it.effect("refuses a publish when a direct save takes the last slot after its check", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, {});
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      NodeFS.mkdirSync(themesDir, { recursive: true });
      const seeded = [
        ...Array.from({ length: 30 }, (_, index) => `theme-${index + 10}.json`),
        "z-existing.json",
      ];
      for (const entry of seeded) {
        NodeFS.writeFileSync(NodePath.join(themesDir, entry), NIGHTFALL_THEME_JSON);
      }
      const themeFile = NodePath.join(baseDir, "incoming.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      let saved = false;
      const saveDirectly = Effect.sync(() => {
        saved = true;
        const temporary = NodePath.join(baseDir, "b-manual.json.tmp");
        NodeFS.writeFileSync(temporary, NIGHTFALL_THEME_JSON);
        NodeFS.renameSync(temporary, NodePath.join(themesDir, "b-manual.json"));
      });
      const failure = yield* runCli(
        ["theme", "set", themeFile, "--id", "a-first", "--base-dir", baseDir],
        (fs) => ({
          ...fs,
          readDirectory: (path, options) =>
            fs
              .readDirectory(path, options)
              .pipe(Effect.tap(() => (path === themesDir && !saved ? saveDirectly : Effect.void))),
        }),
      ).pipe(Effect.flip);

      assert.include(String(failure), "is full");
      assert.deepEqual(
        NodeFS.readdirSync(themesDir).toSorted(),
        [...seeded, "b-manual.json"].toSorted(),
      );
      assert.equal(readSettings(baseDir).defaultTheme, undefined);
    }),
  );

  it.live("refuses to select a provisional theme while a direct save fills the library", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, { defaultTheme: "ocean" });
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      NodeFS.mkdirSync(themesDir, { recursive: true });
      for (let index = 1; index <= 31; index++) {
        NodeFS.writeFileSync(NodePath.join(themesDir, `theme-${index}.json`), NIGHTFALL_THEME_JSON);
      }
      const themeFile = NodePath.join(baseDir, "a-first.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      const saved = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let inserted = false;
      const publisher = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir], (fs) => ({
        ...fs,
        readDirectory: (path, options) =>
          fs.readDirectory(path, options).pipe(
            Effect.tap((entries) => {
              if (path !== themesDir || inserted || !entries.includes("a-first.json")) {
                return Effect.void;
              }
              inserted = true;
              NodeFS.writeFileSync(NodePath.join(themesDir, "b-manual.json"), NIGHTFALL_THEME_JSON);
              return Deferred.succeed(saved, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
              );
            }),
          ),
      })).pipe(Effect.forkScoped);
      yield* Deferred.await(saved);

      const selection = yield* runCliProcess([
        "theme",
        "set",
        "a-first",
        "--base-dir",
        baseDir,
      ]).pipe(Effect.result, Effect.ensuring(Deferred.succeed(resume, undefined)));
      const publication = yield* Fiber.join(publisher).pipe(Effect.flip);

      assert.equal(selection._tag, "Failure");
      assert.include(String(publication), "is full");
      assert.equal(readSettings(baseDir).defaultTheme, "ocean");
      assert.isFalse(NodeFS.existsSync(NodePath.join(themesDir, "a-first.json")));
      assert.isTrue(NodeFS.existsSync(NodePath.join(themesDir, "b-manual.json")));
      assert.isTrue(NodeFS.existsSync(NodePath.join(themesDir, "theme-9.json")));
    }),
  );

  it.live.skipIf(windowsHost)("keeps the previous theme when the staged file is unreadable", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, { defaultTheme: "ocean" });
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      NodeFS.mkdirSync(themesDir);
      const published = NodePath.join(themesDir, "nightfall.json");
      NodeFS.writeFileSync(published, PREVIOUS_NIGHTFALL_THEME_JSON);
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      const failure = yield* runCliProcess(
        ["theme", "set", themeFile, "--base-dir", baseDir],
        ["--import", "data:text/javascript,process.umask(0o400)"],
      ).pipe(Effect.flip);
      assert.include(failure, "Could not publish the theme");
      assert.equal(NodeFS.readFileSync(published, "utf8"), PREVIOUS_NIGHTFALL_THEME_JSON);
      assert.deepEqual(NodeFS.readdirSync(themesDir), ["nightfall.json"]);
      assert.equal(readSettings(baseDir).defaultTheme, "ocean");
    }),
  );

  it.effect.each(["before commit", "during commit"] as const)(
    "reports whether a publish went through when it loses its lease %s",
    (when) =>
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        writeSettings(baseDir, { defaultTheme: "ocean" });
        const themesDir = NodePath.join(baseDir, "userdata", "themes");
        const lockPath = NodePath.join(themesDir, ".publish.lock");
        const published = NodePath.join(themesDir, "nightfall.json");
        const themeFile = NodePath.join(baseDir, "nightfall.json");
        NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

        const replaceLease = Effect.sync(() => {
          NodeFS.renameSync(lockPath, `${lockPath}.moved`);
          NodeFS.mkdirSync(lockPath);
        });
        const result = yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir], (fs) => ({
          ...fs,
          readDirectory: (path, options) =>
            fs
              .readDirectory(path, options)
              .pipe(
                Effect.tap(() =>
                  when === "before commit" && path === themesDir ? replaceLease : Effect.void,
                ),
              ),
          rename: (from, to) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.tap(() =>
                  when === "during commit" && to === settingsPathFor(baseDir)
                    ? replaceLease
                    : Effect.void,
                ),
              ),
        })).pipe(Effect.result);

        // A lease lost after the settings are written cannot undo the publish.
        assert.equal(result._tag, when === "before commit" ? "Failure" : "Success");
        if (result._tag === "Failure") {
          assert.include(String(result.failure), "Could not publish the theme");
        }
        assert.isTrue(NodeFS.existsSync(lockPath));
        assert.equal(NodeFS.existsSync(published), when === "during commit");
        assert.equal(
          readSettings(baseDir).defaultTheme,
          when === "during commit" ? "nightfall" : "ocean",
        );
      }),
  );

  it.effect.skipIf(!symlinksSupported)("never writes through a symlink at the staging path", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const themesDir = NodePath.join(baseDir, "userdata", "themes");
      NodeFS.mkdirSync(themesDir, { recursive: true });
      const victim = NodePath.join(baseDir, "victim.txt");
      NodeFS.writeFileSync(victim, "precious");
      NodeFS.symlinkSync(victim, NodePath.join(themesDir, `nightfall.json.staging-${process.pid}`));
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]);

      assert.equal(NodeFS.readFileSync(victim, "utf8"), "precious");
      assert.equal(readSettings(baseDir).defaultTheme, "nightfall");
    }),
  );

  it.effect.skipIf(windowsHost)("restores the previous theme when a re-publish fails to set", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, {});
      const userdataDir = NodePath.dirname(settingsPathFor(baseDir));
      const themesDir = NodePath.join(userdataDir, "themes");
      NodeFS.mkdirSync(themesDir, { recursive: true });
      const publishedPath = NodePath.join(themesDir, "nightfall.json");
      const previous =
        '{ "name": "Old Nightfall", "appearance": "dark", "canvas": "#000000", "accent": "#ffffff" }\n';
      NodeFS.writeFileSync(publishedPath, previous);
      const themeFile = NodePath.join(baseDir, "nightfall.json");
      NodeFS.writeFileSync(themeFile, NIGHTFALL_THEME_JSON);

      NodeFS.chmodSync(userdataDir, 0o555);
      try {
        yield* runCli(["theme", "set", themeFile, "--base-dir", baseDir]).pipe(Effect.flip);
        assert.equal(NodeFS.readFileSync(publishedPath, "utf8"), previous);
      } finally {
        NodeFS.chmodSync(userdataDir, 0o755);
      }
    }),
  );

  it.effect.skipIf(windowsHost)("refuses to write when the settings file cannot be read", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, { enableProviderUpdateChecks: false });
      NodeFS.chmodSync(settingsPathFor(baseDir), 0o000);

      const failure = yield* runCli(["theme", "set", "ocean", "--base-dir", baseDir]).pipe(
        Effect.flip,
      );

      NodeFS.chmodSync(settingsPathFor(baseDir), 0o644);
      assert.include(String(failure), "Could not read");
      assert.equal(readSettings(baseDir).enableProviderUpdateChecks, false);
      assert.equal(Object.hasOwn(readSettings(baseDir), "defaultTheme"), false);
    }),
  );
});
