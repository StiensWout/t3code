import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceEnvironmentVariable, ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  getProviderEnvironmentContentKey,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("getProviderEnvironmentContentKey", () => {
  const secretVariable: ProviderInstanceEnvironmentVariable = {
    name: "API_KEY",
    value: "stored-secret",
    sensitive: true,
    valueRedacted: true,
  };
  const baseUrlVariable: ProviderInstanceEnvironmentVariable = {
    name: "BASE_URL",
    value: "https://example.test",
    sensitive: false,
  };
  const environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
    secretVariable,
    baseUrlVariable,
  ];

  it("keeps the same key for the same persisted content in a different array", () => {
    expect(getProviderEnvironmentContentKey(environment)).toBe(
      getProviderEnvironmentContentKey(environment.map((variable) => ({ ...variable }))),
    );
  });

  it("changes the key when persisted values change", () => {
    expect(getProviderEnvironmentContentKey(environment)).not.toBe(
      getProviderEnvironmentContentKey([
        { ...secretVariable, value: "updated-secret" },
        baseUrlVariable,
      ]),
    );
  });

  it("changes the key when persisted rows are removed", () => {
    expect(getProviderEnvironmentContentKey(environment)).not.toBe(
      getProviderEnvironmentContentKey(environment.slice(0, 1)),
    );
  });

  it("changes the key when persisted redaction state changes", () => {
    expect(getProviderEnvironmentContentKey(environment)).not.toBe(
      getProviderEnvironmentContentKey([
        { ...secretVariable, valueRedacted: false },
        baseUrlVariable,
      ]),
    );
  });
});
