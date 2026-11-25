import { readFile } from "node:fs/promises";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("A long project script runs to completion", WEB, async ({ t3, app, browser, screen }) => {
  const payload = "fixture data for the project action\n".repeat(2_000);
  const project = await t3.project("demo", {
    "t3.json": JSON.stringify({
      scripts: [
        {
          name: "Write fixture",
          command: `cat > generated.txt <<'END_FIXTURE'\n${payload}END_FIXTURE`,
        },
      ],
    }),
  });
  const thread = await t3.thread({ project, title: "Generate fixture", messages: ["Start"] });
  await browser.setViewport({ width: 1920, height: 1000 });
  await t3.open(thread);

  await screen.getByRole("button", "Choose project action", { exact: true }).tap();
  await screen.getByRole("menuitem", /Write fixture/).tap();
  await screen.getByRole("button", "Run Write fixture", { exact: true }).tap();
  await screen.getByLabel("Terminal input").waitFor();

  const readOutputSize = async () => {
    const text = await readFile(`${project}/generated.txt`, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    return text === payload ? text.length : 0;
  };
  try {
    await expect.poll(readOutputSize, { timeout: 12_000 }).toBe(payload.length);
  } finally {
    await app.screenshot("after-running-long-project-script");
  }
});
