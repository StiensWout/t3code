import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const origin = "https://forgejo.scenario.invalid";

// Supply tracker responses through the scenario home's PATH. The local repos and app are real;
// the fake tea never makes a network request.
const tea = `#!/usr/bin/env node
import fs from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const origin = ${JSON.stringify(origin)};
const titlePath = join(import.meta.dirname, "edited-issue-title");
const original = "First project issue";
const write = (value, link) => {
  console.error("HTTP/1.1 200 OK");
  if (link) console.error("Link: " + link);
  console.log(JSON.stringify(value));
};
const row = (repo, number, title) => ({
  number,
  title,
  html_url: origin + "/demo/" + repo + "/issues/" + number,
  user: { login: "scenario" },
  state: "open",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
});
const title = () => fs.existsSync(titlePath) ? fs.readFileSync(titlePath, "utf8") : original;
if (args[0] === "login" && args[1] === "list") {
  console.log(JSON.stringify([{
    name: "scenario", url: origin, user: "scenario", default: "true",
  }]));
} else if (args[0] === "api") {
  const url = new URL(args.at(-1));
  const path = url.pathname.replace(/^\\/api\\/v1/, "");
  if (path === "/user") {
    write({ login: "scenario" });
  } else if (path === "/repos/demo/first" || path === "/repos/demo/second") {
    write({ full_name: path.slice(7), permissions: { push: true, admin: true } });
  } else if (path === "/repos/demo/first/issues") {
    write([row("first", 1, title())], "<" + url + ">; rel=last");
  } else if (path === "/repos/demo/second/issues") {
    if (url.searchParams.get("page") === "1") {
      write([row("second", 2, "Second project issue")], "<" + url + ">; rel=next");
    } else {
      write([row("second", 3, "Older issue from the second project")], "<" + url + ">; rel=last");
    }
  } else if (path === "/repos/demo/first/issues/1") {
    if (args.includes("PATCH")) fs.writeFileSync(titlePath, JSON.parse(fs.readFileSync(0, "utf8")).title);
    write(row("first", 1, title()));
  } else if (/^\\/repos\\/demo\\/first\\/issues\\/1\\/(timeline|comments|reactions)$/.test(path)) {
    write([]);
  } else {
    console.error("HTTP/1.1 404 Not Found");
  }
} else if (args.includes("--version") || args.includes("version")) {
  console.log("tea version 0.16.0");
} else {
  process.exitCode = 1;
}
`;

test(
  "Renaming an issue keeps the other project's loaded issues",
  WEB,
  async ({ t3, app, screen }) => {
    const installTea = (remove = false) =>
      runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const bin = path.join(T3_HOME, "bin");
          const shim = path.join(bin, "tea");
          if (remove) {
            yield* fs.remove(shim, { force: true });
            yield* fs.remove(path.join(bin, "edited-issue-title"), { force: true });
          } else {
            yield* fs.writeFileString(shim, tea);
            yield* fs.chmod(shim, 0o755);
          }
        }),
      );

    await installTea();
    try {
      for (const name of ["first", "second"]) {
        await t3.project(name, {
          ".git/config": `[remote "origin"]\n\turl = ${origin}/demo/${name}.git\n`,
        });
      }
      await t3.open("/issues");

      const older = screen.getByRole("button", /Older issue from the second project/);
      const first = screen.getByRole("button", /First project issue/);
      await first.waitFor({ timeout: 60_000 });
      await screen.getByRole("button", "Load more").tap();
      await older.waitFor();
      await first.tap();
      await screen.getByRole("button", "Edit title").tap();
      await screen.getByRole("textbox", "Issue title").fill("Renamed first project issue");
      await screen.getByRole("button", "Save", { exact: true }).tap();

      // Wait for the edited title in the list, so the check is after the list handles the write.
      await screen.getByRole("button", /#1\s*Renamed first project issue/).waitFor();
      await app.screenshot("issues-after-rename");
      await expect(older).toBeVisible();
    } finally {
      await installTea(true);
    }
  },
);
