// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { expect, it } from "vite-plus/test";
import { extractDocumentText } from "./documentTextWorker.ts";

function epub(chapter: string): Buffer {
  const parts = {
    "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
    "book.opf":
      '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    "chapter.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><body>${chapter}</body></html>`,
  };
  const entries: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(parts)) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(NodeZlib.crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    local.copy(central, 6, 4);
    central.writeUInt32LE(offset, 42);
    entries.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, centralDirectory, end]);
}

it.each(["main", "footer", "header", "article", "nav", "figure", "details", "summary", "hgroup"])(
  "separates EPUB %s text from surrounding text without adding a line for an empty block",
  async (tag) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-epub-"));
    try {
      const path = NodePath.join(dir, "book.epub");
      const block = `Before.<${tag}> </${tag}>Still before.<${tag}><span>Block.</span></${tag}>After.`;
      const chapter = tag === "summary" ? `<details>${block}</details>` : block;
      await NodeFSP.writeFile(path, epub(chapter));
      await expect(extractDocumentText(path, ".epub")).resolves.toBe(
        "## Chapter 1\nBefore. Still before.\nBlock.\nAfter.",
      );
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);
