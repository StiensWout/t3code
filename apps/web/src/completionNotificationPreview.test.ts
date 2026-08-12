import type { MessageId, OrchestrationMessage, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { completionNotificationPreview } from "./completionNotificationPreview.ts";

function assistantMessage(input: {
  readonly id: string;
  readonly turnId: string;
  readonly text: string;
  readonly streaming?: boolean;
}): OrchestrationMessage {
  return {
    id: input.id as MessageId,
    role: "assistant",
    text: input.text,
    turnId: input.turnId as TurnId,
    streaming: input.streaming ?? false,
    createdAt: "2026-08-12T09:00:00.000Z",
    updatedAt: "2026-08-12T09:00:00.000Z",
  };
}

describe("completionNotificationPreview", () => {
  it("uses the completed turn's final assistant message", () => {
    expect(
      completionNotificationPreview({
        messages: [
          assistantMessage({ id: "message-1", turnId: "turn-1", text: "Older response" }),
          assistantMessage({ id: "message-2", turnId: "turn-2", text: "The fix is ready." }),
        ],
        assistantMessageId: "message-2" as MessageId,
        turnId: "turn-2" as TurnId,
      }),
    ).toBe("The fix is ready.");
  });

  it("uses the latest settled assistant message from the completed turn as a fallback", () => {
    expect(
      completionNotificationPreview({
        messages: [
          assistantMessage({ id: "message-1", turnId: "turn-1", text: "First draft" }),
          assistantMessage({
            id: "message-2",
            turnId: "turn-1",
            text: "Still streaming",
            streaming: true,
          }),
          assistantMessage({ id: "message-3", turnId: "turn-1", text: "Final response" }),
        ],
        assistantMessageId: null,
        turnId: "turn-1" as TurnId,
      }),
    ).toBe("Final response");
  });

  it("does not preview an unrelated turn when the expected response is missing", () => {
    expect(
      completionNotificationPreview({
        messages: [assistantMessage({ id: "message-1", turnId: "turn-1", text: "Older response" })],
        assistantMessageId: "message-2" as MessageId,
        turnId: "turn-2" as TurnId,
      }),
    ).toBeNull();
  });
});
