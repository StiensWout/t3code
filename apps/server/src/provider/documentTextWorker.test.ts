// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

function zipTextParts(parts: Record<string, string>): Buffer {
  const records: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  const entries = Object.entries(parts);
  for (const [path, source] of entries) {
    const name = Buffer.from(path);
    const data = Buffer.from(source);
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    records.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralDirectory, end]);
}

it.each([
  {
    name: "uses the default outline inside a text box without marking its empty anchor",
    id: "ReportSection",
    properties: '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>',
    body:
      "<w:p><w:r><w:t> </w:t><w:instrText>Field code</w:instrText>" +
      "<w:drawing><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent></w:drawing>" +
      "</w:r></w:p><w:p><w:r><w:noBreakHyphen/></w:r></w:p>",
    expected: "## Box text\n\n## ‑",
  },
  {
    name: "uses a default heading style's built-in id",
    id: "Heading1",
    properties: "",
    body: "<w:p><w:r><w:t>Report</w:t></w:r></w:p>",
    expected: "# Report",
  },
  {
    name: "uses a localized default heading style's built-in name",
    id: "Ueberschrift2",
    properties: '<w:name w:val="heading 2"/>',
    body: "<w:p><w:r><w:t>Report</w:t></w:r></w:p>",
    expected: "## Report",
  },
])("$name", async ({ id, properties, body, expected }) => {
  const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-docx-outline-"));
  try {
    const path = NodePath.join(folder, "report.docx");
    const namespace = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    await NodeFSP.writeFile(
      path,
      zipTextParts({
        "word/document.xml": `<w:document ${namespace}><w:body>${body}</w:body></w:document>`,
        "word/styles.xml":
          `<w:styles ${namespace}><w:style w:type="paragraph" w:default="1" w:styleId="${id}">` +
          `${properties}</w:style></w:styles>`,
      }),
    );
    expect(await extractDocumentText(path, ".docx")).toBe(expected);
  } finally {
    await NodeFSP.rm(folder, { recursive: true, force: true });
  }
});

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
