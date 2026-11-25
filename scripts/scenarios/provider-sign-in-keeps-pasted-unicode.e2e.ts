/// <reference lib="dom" />
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

const PREFIX = "a".repeat(4_095);
const PASTE = PREFIX + "🦊tail";
const PROVIDER = String.raw`
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv.includes("login")) {
  process.stdin.setRawMode(true);
  process.stdout.write("Paste a value at the prompt.\r\n");
  const chunks = [];
  process.stdin.on("data", (chunk) => {
    // "q" is the readiness keystroke and never occurs in the value being pasted.
    const ready = chunk.lastIndexOf(0x71);
    if (ready !== -1) writeFileSync(new URL("login-ready", import.meta.url), "ready");
    chunks.push(chunk.subarray(ready + 1));
    const value = Buffer.concat(chunks).toString("utf8");
    if (!value.endsWith("tail")) return;
    const suffix = value.slice(4095);
    process.stdout.write("Received: " + suffix + "\r\n");
    writeFileSync(new URL("received", import.meta.url), suffix);
  });
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method } = JSON.parse(line);
    if (id === undefined) continue;
    const response = method === "initialize"
      ? { result: {
          protocolVersion: 1,
          agentInfo: { name: "Paste probe", version: "1.0.0" },
          agentCapabilities: {},
          authMethods: [{ id: "terminal", name: "Terminal", type: "terminal", args: ["login"] }],
        } }
      : { error: { code: -32000, message: "Authentication required" } };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...response }) + "\n");
  }
}
`;

test(
  "An emoji crossing a provider sign-in terminal write boundary reaches the program intact",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.emulateMedia({ colorScheme: "dark" });
    const project = await t3.project("demo", { "sign-in-probe.mjs": PROVIDER });
    const instanceId = ProviderInstanceId.make("paste-probe");
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        yield* client["server.updateSettings"]({
          patch: {},
          providerInstanceMutation: {
            operation: "upsert",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Paste probe",
              enabled: true,
              config: {
                source: "local",
                commandPath: process.execPath,
                commandArgs: [`${project}/sign-in-probe.mjs`],
              },
            },
          },
        });
      }).pipe(Effect.scoped),
    );

    const read = (file: string) =>
      runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.readFileString(`${project}/${file}`);
        }).pipe(Effect.orElseSucceed(() => "")),
      );

    await t3.open(`/settings/providers?instanceId=${instanceId}`);
    await screen.getByRole("button", "Sign in", { exact: true }).tap({ timeout: 60_000 });
    const input = screen.getByLabel("Terminal input");
    await input.focus();
    await expect
      .poll(async () => {
        await browser.keyboard.type("q");
        return read("login-ready");
      })
      .toBe("ready");
    await browser.evaluate((text) => {
      const input = document.querySelector('[aria-label="Terminal input"]');
      if (!input) throw new Error("No sign-in terminal input");
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      return null;
    }, PASTE);

    try {
      await expect.poll(() => read("received")).toBe("🦊tail");
    } finally {
      await app.screenshot("pasted-value-in-sign-in-terminal");
    }
  },
);
