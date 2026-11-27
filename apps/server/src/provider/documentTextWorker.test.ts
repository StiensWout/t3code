// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

const cellHeading = "## Cell 1 (code)\n";
const outputHeading = "\nOutput:\n";

it.each([
  {
    name: "skips an empty opening row before a paragraph",
    body: "\\cell\\cell\\row\\pard Revenue",
    expected: "Revenue",
  },
  {
    name: "keeps the leading cell of a populated row after an empty opening row",
    body: "\\cell\\cell\\row\\cell Revenue\\cell\\row",
    expected: "\tRevenue",
  },
  {
    name: "keeps the leading cells when a paragraph break occurs within the row",
    body: "\\cell\\par\\cell Revenue\\cell\\row",
    expected: "\t\tRevenue",
  },
])("$name", async ({ body, expected }) => {
  const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-rtf-rows-"));
  try {
    const path = NodePath.join(folder, "table.rtf");
    await NodeFSP.writeFile(path, "{\\rtf1\\ansi " + body + "}");
    expect(await extractDocumentText(path, ".rtf")).toBe(expected);
  } finally {
    await NodeFSP.rm(folder, { recursive: true, force: true });
  }
});

it.each([
  {
    name: "omits the output heading when only half an emoji fits after it",
    source: "x".repeat(1_000_000 - cellHeading.length - outputHeading.length - 1),
    outputs: ["😀"],
    remainder: "\n\n[Extracted text truncated at document extraction limits.]",
  },
  {
    name: "keeps reading after a high surrogate in an output below the limit",
    source: "run()",
    outputs: ["\uD83D", "\uDE00"],
    remainder: "\nOutput:\n\uD83D\n\uDE00\n\n## Cell 2 (markdown)\nLater cell",
  },
])("$name", async ({ source, outputs, remainder }) => {
  const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-notebook-budget-"));
  try {
    const path = NodePath.join(folder, "output.ipynb");
    await NodeFSP.writeFile(
      path,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source,
            outputs: outputs.map((text) => ({ output_type: "stream", text })),
          },
          { cell_type: "markdown", source: "Later cell" },
        ],
      }),
    );
    const extracted = await extractDocumentText(path, ".ipynb");
    expect(extracted.slice(source.length + cellHeading.length)).toBe(remainder);
  } finally {
    await NodeFSP.rm(folder, { recursive: true, force: true });
  }
});
