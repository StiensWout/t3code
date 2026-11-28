import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { environmentId, makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const DEFINITION = `export default T3.workflow("docs-check", { version: 1, payload: Schema.Struct({}) },
  Effect.fn(function* () {
    yield* T3.step("Check docs", { returns: Schema.String },
      Effect.fail("See [the [appendix]](https://example.org/a(b))."));
  }));
`;

test(
  "A workflow timeline shows the label of a link with nested brackets",
  WEB,
  async ({ t3, app, screen }) => {
    const definition = await runPromise(
      Effect.map(Path.Path, (path) => path.join(T3_HOME, "workflows/docs-check.ts")),
    );
    const workflowsOn = (on: boolean) =>
      runPromise(
        Effect.gen(function* () {
          const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
          yield* client["server.updateSettings"]({ patch: { workflowsEnabled: on } });
        }).pipe(Effect.scoped),
      );
    try {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(path.dirname(definition), { recursive: true });
          yield* fs.writeFileString(definition, DEFINITION);
        }),
      );
      const project = await t3.project("demo");
      const thread = await t3.thread({ project, title: "Docs", messages: ["Check the docs"] });
      await workflowsOn(true);
      const started = await runPromise(
        makeState(T3_HOME).cli(["workflow", "start", "docs-check", "--key", "one", "--json"]),
      );
      const { run } = JSON.parse(started.stdout);
      const env = await runPromise(environmentId(app.baseUrl ?? ""));
      await t3.open(thread);
      await screen.getByRole("textbox").waitFor();
      await app.open(`/workflows?env=${env}&run=${run.runId}`);

      const row = screen.getByRole("button", /^Check docs/);
      const summary = row.getByText(/^See /);
      await summary.waitFor({ timeout: 30_000 });
      await app.screenshot("workflow-step-summary");
      await expect(summary).toHaveText("See the [appendix].");
    } finally {
      await workflowsOn(false);
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(definition, { force: true })),
      );
    }
  },
);
