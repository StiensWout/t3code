import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const theme = (name: string) =>
  JSON.stringify({ name, appearance: "light", canvas: "#f4f1ff", accent: "#6d5ae6" });

test(
  "Publishing from the CLI keeps an existing theme available when the library is full",
  WEB,
  async ({ t3, app, screen }) => {
    const workspace = await t3.project("theme-library", { "new-theme.json": theme("New Theme") });
    const { cli } = makeState(T3_HOME);
    const fixture = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const settings = path.join(T3_HOME, "userdata", "settings.json");
        const originalSettings = yield* fs.readFileString(settings);
        const directory = path.join(T3_HOME, "userdata", "themes");
        const files = Array.from({ length: 32 }, (_, index) =>
          path.join(directory, `library-theme-${String(index + 1).padStart(2, "0")}.json`),
        );
        const incomingId = "first-in-library";
        yield* fs.makeDirectory(directory, { recursive: true });
        return {
          seed: Effect.forEach(
            files,
            (file, index) => fs.writeFileString(file, theme(`Library Theme ${index + 1}`)),
            { discard: true },
          ),
          publish: cli(
            ["theme", "set", path.join(workspace, "new-theme.json"), "--id", incomingId],
            [0, 1],
          ),
          restore: Effect.forEach(
            [...files, path.join(directory, `${incomingId}.json`)],
            (file) => fs.remove(file, { force: true }),
            { discard: true },
          ).pipe(Effect.andThen(fs.writeFileString(settings, originalSettings))),
        };
      }),
    );

    try {
      await runPromise(fixture.seed);
      await runPromise(fixture.publish);
      await t3.open("/settings/appearance");

      const lastTheme = screen.getByRole("button", "Use Library Theme 32 theme", { exact: true });
      const previousTheme = screen.getByRole("button", "Use Library Theme 31 theme", {
        exact: true,
      });
      await previousTheme.scrollIntoView();
      await app.screenshot("library-after-cli-publish");
      await expect(lastTheme).toBeVisible();
    } finally {
      await runPromise(fixture.restore);
    }
  },
);
