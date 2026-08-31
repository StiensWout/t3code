import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PreviewAutomationOperationError,
  PreviewAutomationRecordingNotActiveError,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";

const operationError = (cause: unknown) =>
  new PreviewAutomationOperationError({
    requestId: "request-1",
    operation: "recordingStart",
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
    tabId: null,
    cause,
  });

describe("serializePreviewAutomationHostError", () => {
  it("keeps the underlying failure reason as a flat cause summary", () => {
    const serialized = serializePreviewAutomationHostError(
      operationError(
        Object.assign(new Error("Cannot satisfy constraints"), { name: "OverconstrainedError" }),
      ),
    );

    expect(serialized.detail).toMatchObject({
      cause: "OverconstrainedError: Cannot satisfy constraints",
      operation: "recordingStart",
    });
  });

  it("renders non-error causes without losing them", () => {
    expect(serializePreviewAutomationHostError(operationError("boom")).detail).toMatchObject({
      cause: "boom",
    });
  });

  it("omits cause for errors that carry none", () => {
    const serialized = serializePreviewAutomationHostError(
      new PreviewAutomationRecordingNotActiveError({
        requestId: "request-1",
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
        tabId: null,
      }),
    );

    expect(serialized.detail).not.toHaveProperty("cause");
  });
});
