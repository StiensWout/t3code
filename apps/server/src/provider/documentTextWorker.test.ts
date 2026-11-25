// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as DocumentText from "./DocumentText.ts";

function docx(body: string) {
  const name = Buffer.from("word/document.xml");
  const data = Buffer.from(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body>\n  " +
      body +
      "</w:body></w:document>",
  );
  const crc = NodeZlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt32LE(crc, 16);
  directory.writeUInt32LE(data.length, 20);
  directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, directory, name, end]);
}

const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const row = (columns: string[], gridBefore?: number) =>
  "<w:tr>" +
  (gridBefore === undefined ? "" : `<w:trPr><w:gridBefore w:val="${gridBefore}"/></w:trPr>`) +
  columns.map((text) => `<w:tc>${paragraph(text)}</w:tc>`).join("") +
  "</w:tr>";

it.effect.each([
  {
    name: "a first row with an omitted leading cell",
    rows: row(["Q1", "Q2"], 1) + row(["North", "1", "2"]),
    expected: "\tQ1\tQ2\nNorth\t1\t2",
  },
  {
    name: "a first row with a blank leading cell",
    rows: row(["", "Q1", "Q2"]) + row(["North", "1", "2"]),
    expected: "\tQ1\tQ2\nNorth\t1\t2",
  },
  {
    name: "offsets beyond the declared grid",
    rows: row(["North", "1", "2"], 4) + row(["South", "3", "4"], 512),
    expected: "North\t1\t2\nSouth\t3\t4",
  },
])("keeps table columns aligned with $name", ({ rows, expected }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const path = NodePath.join(dir, "table.docx");
    const table =
      "<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>" + rows + "</w:tbl>";
    yield* fs.writeFile(path, docx(table + paragraph("After the table")));
    const sidecar = yield* (yield* DocumentText.DocumentText).ensure(path);
    expect(sidecar).toBe(path + ".txt");
    expect(yield* fs.readFileString(path + ".txt")).toBe(expected + "\nAfter the table");
  }).pipe(Effect.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
