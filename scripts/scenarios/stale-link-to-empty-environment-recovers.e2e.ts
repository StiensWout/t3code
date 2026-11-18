import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "A missing thread link on an environment with no threads returns to the workspace",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("active-workspace");
    await t3.thread({ project, title: "Active work", messages: ["first"] });

    const server = startSecondServer(app.baseUrl ?? "");
    try {
      const { host, token } = await server.ready;
      await makeState(SECOND_HOME).state.project("empty-workspace");

      const { environmentId } = await runPromise(
        HttpClient.get(`${host}/.well-known/t3/environment`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(Schema.Struct({ environmentId: Schema.String })),
          ),
          Effect.provide(FetchHttpClient.layer),
        ),
      );

      await t3.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      await screen.getByRole("button", "More actions for Scenario").waitFor({ timeout: 60_000 });

      // The browser is signed in and the target environment is paired before following the link.
      await app.open(`/${environmentId}/deleted-thread`);
      try {
        await expect(browser).toHaveURL(/\/draft\/[^/?#]+/, { timeout: 30_000 });
      } finally {
        await app.screenshot("after-missing-thread-link");
      }
    } finally {
      await server.stop();
    }
  },
);
