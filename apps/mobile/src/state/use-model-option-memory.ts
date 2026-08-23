import {
  ProviderOptionSelection as ProviderOptionSelectionSchema,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { writeFileAtomically } from "../lib/atomic-file";
import { SerializedAsyncQueue } from "../lib/serialized-async-queue";
import { appAtomRegistry } from "./atom-registry";

const MODEL_OPTION_MEMORY_SCHEMA_VERSION = 1;
const MODEL_OPTION_MEMORY_DIRECTORY = "composer-drafts";
const MODEL_OPTION_MEMORY_FILE = "model-option-memory.json";
const PERSIST_DEBOUNCE_MS = 200;

/**
 * Cross-thread memory of the option selections last chosen per provider
 * instance and model slug, mirroring the web composer's sticky map. Switching
 * models restores the target model's own remembered choices instead of its
 * descriptor defaults.
 */
export type ModelOptionMemoryState = Readonly<
  Record<string, Readonly<Record<string, ReadonlyArray<ProviderOptionSelection>>>>
>;

const PersistedModelOptionMemorySchema = Schema.Struct({
  schemaVersion: Schema.Literal(MODEL_OPTION_MEMORY_SCHEMA_VERSION),
  byInstance: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Array(ProviderOptionSelectionSchema)),
  ),
});

const decodePersistedModelOptionMemory = Schema.decodeUnknownSync(PersistedModelOptionMemorySchema);

export class ModelOptionMemoryPersistenceError extends Schema.TaggedErrorClass<ModelOptionMemoryPersistenceError>()(
  "ModelOptionMemoryPersistenceError",
  {
    operation: Schema.Literals(["open", "read", "decode", "encode", "write", "hydrate"]),
    directory: Schema.String,
    fileName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Model option memory persistence operation ${this.operation} failed for ${this.directory}/${this.fileName}.`;
  }
}

export const modelOptionMemoryAtom = Atom.make<ModelOptionMemoryState>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:model-option-memory"),
);

let loadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const persistenceQueue = new SerializedAsyncQueue();

/** Pure map update so callers stay unit-testable without file system mocks. */
export function recordModelOptionsInState(
  state: ModelOptionMemoryState,
  instanceId: string,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection>,
): ModelOptionMemoryState {
  if (options.length === 0) {
    return state;
  }
  return {
    ...state,
    [instanceId]: {
      ...(state[instanceId] ?? {}),
      [model]: options,
    },
  };
}

/** Pure lookup; `undefined` means "no memory, fall back to descriptor defaults". */
export function lookupModelOptionsInState(
  state: ModelOptionMemoryState,
  instanceId: string,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return state[instanceId]?.[model];
}

function normalizePersistedMemory(value: unknown): ModelOptionMemoryState {
  const parsed = decodePersistedModelOptionMemory(value);
  const byInstance: Record<
    string,
    Readonly<Record<string, ReadonlyArray<ProviderOptionSelection>>>
  > = {};
  for (const [instanceId, byModel] of Object.entries(parsed.byInstance)) {
    const keptModels = Object.fromEntries(
      Object.entries(byModel).filter(([, options]) => options.length > 0),
    );
    if (Object.keys(keptModels).length > 0) {
      byInstance[instanceId] = keptModels;
    }
  }
  return byInstance;
}

async function getModelOptionMemoryFile() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, MODEL_OPTION_MEMORY_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, MODEL_OPTION_MEMORY_FILE);
}

async function loadPersistedModelOptionMemory(): Promise<ModelOptionMemoryState> {
  let operation: ModelOptionMemoryPersistenceError["operation"] = "open";
  try {
    const file = await getModelOptionMemoryFile();
    if (!file.exists) {
      return {};
    }
    operation = "read";
    const raw = await file.text();
    operation = "decode";
    return normalizePersistedMemory(JSON.parse(raw) as unknown);
  } catch (cause) {
    console.warn(
      "[model-option-memory] ignored persisted memory failure",
      new ModelOptionMemoryPersistenceError({
        operation,
        directory: MODEL_OPTION_MEMORY_DIRECTORY,
        fileName: MODEL_OPTION_MEMORY_FILE,
        cause,
      }),
    );
    return {};
  }
}

async function writePersistedModelOptionMemory(state: ModelOptionMemoryState): Promise<void> {
  let operation: ModelOptionMemoryPersistenceError["operation"] = "open";
  try {
    const file = await getModelOptionMemoryFile();
    operation = "encode";
    const encoded = JSON.stringify({
      schemaVersion: MODEL_OPTION_MEMORY_SCHEMA_VERSION,
      byInstance: state,
    });
    operation = "write";
    await writeFileAtomically(file, encoded);
  } catch (cause) {
    throw new ModelOptionMemoryPersistenceError({
      operation,
      directory: MODEL_OPTION_MEMORY_DIRECTORY,
      fileName: MODEL_OPTION_MEMORY_FILE,
      cause,
    });
  }
}

function schedulePersistModelOptionMemory(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistenceQueue
      .run(() => writePersistedModelOptionMemory(appAtomRegistry.get(modelOptionMemoryAtom)))
      .catch((error: unknown) => {
        // Memory persistence is best-effort; in-memory state still keeps working.
        console.warn("[model-option-memory] failed to persist memory", error);
      });
  }, PERSIST_DEBOUNCE_MS);
}

export function ensureModelOptionMemoryLoaded(): void {
  if (loadPromise !== null) {
    return;
  }
  loadPromise = loadPersistedModelOptionMemory()
    .then((persisted) => {
      if (Object.keys(persisted).length === 0) {
        return;
      }
      appAtomRegistry.set(modelOptionMemoryAtom, {
        ...persisted,
        ...appAtomRegistry.get(modelOptionMemoryAtom),
      });
    })
    .catch((cause) => {
      console.warn(
        "[model-option-memory] failed to hydrate memory",
        new ModelOptionMemoryPersistenceError({
          operation: "hydrate",
          directory: MODEL_OPTION_MEMORY_DIRECTORY,
          fileName: MODEL_OPTION_MEMORY_FILE,
          cause,
        }),
      );
    });
}

/** Records an explicitly chosen option set for one instance and model. */
export function rememberModelOptions(
  instanceId: string,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection>,
): void {
  if (options.length === 0) {
    return;
  }
  const current = appAtomRegistry.get(modelOptionMemoryAtom);
  const next = recordModelOptionsInState(current, String(instanceId), model, options);
  if (next !== current) {
    appAtomRegistry.set(modelOptionMemoryAtom, next);
    schedulePersistModelOptionMemory();
  }
}

export function rememberedModelOptions(
  instanceId: string,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return lookupModelOptionsInState(
    appAtomRegistry.get(modelOptionMemoryAtom),
    String(instanceId),
    model,
  );
}

/**
 * Restores a remembered option set for a freshly picked selection, keeping the
 * incoming selections when nothing is remembered or they already match.
 */
export function withRememberedModelOptions<
  T extends {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
  },
>(selection: T): T {
  const remembered = rememberedModelOptions(selection.instanceId, selection.model);
  if (
    remembered === undefined ||
    JSON.stringify(remembered) === JSON.stringify(selection.options ?? [])
  ) {
    return selection;
  }
  return { ...selection, options: remembered };
}

/**
 * Lands any debounced or in-flight memory write before the JS runtime is torn
 * down (app update restart), matching the draft flush contract.
 */
export async function flushModelOptionMemory(): Promise<void> {
  do {
    while (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
      await persistenceQueue.run(() =>
        writePersistedModelOptionMemory(appAtomRegistry.get(modelOptionMemoryAtom)),
      );
    }
    await persistenceQueue.run(() => Promise.resolve());
  } while (persistTimer !== null);
}
