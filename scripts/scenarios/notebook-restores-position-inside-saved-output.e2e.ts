/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const notebook = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { language_info: { name: "python" } },
  cells: [
    {
      id: "results",
      cell_type: "code",
      source: [],
      metadata: {},
      execution_count: 1,
      outputs: [
        {
          output_type: "display_data",
          metadata: {},
          data: {
            "text/html": Array.from({ length: 100 }, (_, i) => `<p>Result ${i + 1}</p>`).join(""),
          },
        },
      ],
    },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `notes-${i}`,
      cell_type: "markdown",
      source: `Notes ${i + 1}\n\n${"Follow-up paragraph.\n\n".repeat(4)}`,
      metadata: {},
    })),
  ],
};

test(
  "A notebook returns to the part of a long saved HTML output the reader was viewing",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", {
      "results.ipynb": JSON.stringify(notebook),
      "notes.txt": "Review notes",
    });
    const thread = await t3.thread({ project, title: "Review results", messages: ["Start"] });
    await t3.open(thread);
    await screen.getByText("fixture turn complete", { exact: false }).waitFor();

    const openFile = async (name: string) => {
      await browser.keyboard.press("Control+p");
      await screen.getByPlaceholder("Search files…").fill(name);
      await screen.getByRole("option", name, { exact: false }).tap();
    };
    await openFile("results.ipynb");
    const output = "[data-notebook-output] iframe";
    await browser.locator(`${output}[style]:not([style*="height: 80px"])`).waitFor({
      timeout: 120_000,
    });
    await browser.evaluate((selector) => {
      const frame = document.querySelector<HTMLElement>(selector)!;
      const scroller = frame.closest<HTMLElement>(".overflow-auto")!;
      scroller.scrollTop =
        frame.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 1200;
      return null;
    }, output);

    await openFile("notes.txt");
    await screen.getByRole("button", "results.ipynb", { exact: true }).tap();
    await browser.locator("[data-notebook-output]").waitFor({ timeout: 120_000 });
    try {
      await expect
        .poll(() =>
          browser.evaluate((selector) => {
            const frame = document.querySelector<HTMLElement>(selector);
            if (!frame) return "saved output is outside the viewport";
            const scroller = frame.closest<HTMLElement>(".overflow-auto")!;
            const offset = scroller.getBoundingClientRect().top - frame.getBoundingClientRect().top;
            return Math.abs(offset - 1200) <= 5
              ? "at the saved position"
              : `output offset ${Math.round(offset)}`;
          }, output),
        )
        .toBe("at the saved position");
    } finally {
      await app.screenshot("notebook-position-after-switching-back");
    }
  },
);
