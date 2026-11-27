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

it("includes EPUB image descriptions according to their winning inline declarations", async () => {
  const cases = [
    ["display: none; display: bogus !important", false],
    ["display: none; all: bogus !important", false],
    ["display: none !important; display: inline table flex !important", false],
    ["display: none; display: inline", true],
    ["display: inline; display: none", false],
    ["display: inline !important; display: none", true],
    ["display: none !important; display: inline", false],
    ["display: none; all: unset", true],
    ["display: none; display: inline flex", true],
    ["display: none !important; width: calc(100% - 1em); display: inline !important", true],
    ["--options: { note: [x;display:none!important;] };", true],
    ['--label: "x;display:none!important;visibility:hidden;";', true],
    ["/* draft; display:none; visibility:hidden; */", true],
    ["visibility: hidden; visibility: visible", true],
    ["visibility: hidden !important; visibility: visible !important", true],
    ["visibility: visible !important; visibility: hidden", true],
    ["visibility: hidden !important; all: unset !important", true],
    ["visibility: hidden !important; all: unset", false],
    ["visibility: visible; visibility: collapse", false],
  ] as const;
  const chapter = cases
    .map(([style], index) => {
      const attribute = style.replaceAll('"', "&quot;");
      return `<p>Case ${index}: <img alt="[map ${index}]" style="${attribute}"/>.</p>`;
    })
    .join("");
  const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-epub-"));
  try {
    const path = NodePath.join(folder, "chapter.epub");
    await NodeFSP.writeFile(
      path,
      storedZip({
        "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
        "book.opf":
          '<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>',
        "chapter.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body>${chapter}</body></html>`,
      }),
    );
    const extracted = await extractDocumentText(path, ".epub");
    expect(extracted).toContain("## Chapter 1");
    for (const [index, [style, visible]] of cases.entries()) {
      expect.soft(extracted.includes(`[map ${index}]`), style).toBe(visible);
    }
  } finally {
    await NodeFSP.rm(folder, { recursive: true, force: true });
  }
});

function storedZip(files: Record<string, string>): Buffer {
  const entries: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    entries.push(local, filename, data);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, ...directory, end]);
}
