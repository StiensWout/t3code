// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as DocumentText from "./DocumentText.ts";

it.effect.each(["omitted", "blank"])("keeps the first table column when the cell is %s", (kind) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const path = NodePath.join(dir, "table.docx");
    const fixture = new URL(`./fixtures/docx/leading-cell-${kind}.docx`, import.meta.url);
    yield* fs.copyFile(NodeURL.fileURLToPath(fixture), path);
    const sidecar = yield* (yield* DocumentText.DocumentText).ensure(path);
    expect(sidecar).toBe(path + ".txt");
    expect(yield* fs.readFileString(path + ".txt")).toBe("\tQ1\tQ2\nNorth\t1\t2\nAfter the table");
  }).pipe(Effect.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
