import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const memoryFileMocks = vi.hoisted(() => {
  let document = "";
  return {
    getDocument() {
      return document;
    },
    setDocument(value: unknown) {
      document = JSON.stringify(value);
    },
    Directory: class {
      create() {}
    },
    File: class {
      exists = true;
      parentDirectory = null;

      create() {}

      moveSync() {}

      async text() {
        return document;
      }

      write(value: string) {
        document = value;
      }
    },
  };
});

vi.mock("expo-file-system", () => ({
  Directory: memoryFileMocks.Directory,
  File: memoryFileMocks.File,
  Paths: { document: "/documents" },
}));

import { appAtomRegistry } from "./atom-registry";
import {
  flushModelOptionMemory,
  lookupModelOptionsInState,
  modelOptionMemoryAtom,
  recordModelOptionsInState,
  rememberModelOptions,
  rememberedModelOptions,
  withRememberedModelOptions,
} from "./use-model-option-memory";

const XHIGH = [{ id: "thinking", value: "xhigh" }] as const;
const HIGH = [{ id: "thinking", value: "high" }] as const;

afterEach(async () => {
  await flushModelOptionMemory();
  appAtomRegistry.set(modelOptionMemoryAtom, {});
});

describe("model option memory state", () => {
  it("records and looks up options per instance and model", () => {
    let state = recordModelOptionsInState({}, "codex", "gpt-5.3-codex", [...XHIGH]);
    state = recordModelOptionsInState(state, "codex", "gpt-5.4", [...HIGH]);
    expect(lookupModelOptionsInState(state, "codex", "gpt-5.3-codex")).toEqual(XHIGH);
    expect(lookupModelOptionsInState(state, "codex", "gpt-5.4")).toEqual(HIGH);
    expect(lookupModelOptionsInState(state, "pi", "gpt-5.3-codex")).toBeUndefined();
  });

  it("ignores empty option sets when recording", () => {
    const state = recordModelOptionsInState({}, "codex", "gpt-5.4", []);
    expect(state).toEqual({});
    expect(lookupModelOptionsInState(state, "codex", "gpt-5.4")).toBeUndefined();
  });
});

describe("withRememberedModelOptions", () => {
  it("restores the remembered options over descriptor defaults", () => {
    rememberModelOptions("codex", "gpt-5.3-codex", [...XHIGH]);
    expect(
      withRememberedModelOptions({
        instanceId: "codex",
        model: "gpt-5.3-codex",
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.3-codex", options: XHIGH });
  });

  it("keeps incoming selections that already match memory", () => {
    rememberModelOptions("pi", "xai/grok-4.6", [...XHIGH]);
    const selection = { instanceId: "pi", model: "xai/grok-4.6", options: [...XHIGH] };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });

  it("keeps incoming selections when nothing is remembered", () => {
    const selection = { instanceId: "pi", model: "openai-codex/gpt-5.6-sol" };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });
});

describe("model option memory persistence", () => {
  it("round-trips recorded memory through the persisted document", async () => {
    memoryFileMocks.setDocument({ schemaVersion: 1, byInstance: {} });

    rememberModelOptions("pi", "xai/grok-4.6", [...XHIGH]);
    await flushModelOptionMemory();

    expect(JSON.parse(memoryFileMocks.getDocument())).toEqual({
      schemaVersion: 1,
      byInstance: { pi: { "xai/grok-4.6": XHIGH } },
    });

    // Simulate an app restart: the loader sets the atom from the document.
    appAtomRegistry.set(modelOptionMemoryAtom, {});
    const parsed = JSON.parse(memoryFileMocks.getDocument());
    appAtomRegistry.set(modelOptionMemoryAtom, parsed.byInstance);
    expect(rememberedModelOptions("pi", "xai/grok-4.6")).toEqual(XHIGH);
  });
});
