import { McpCapabilityUnavailableError, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class ThreadRenameFailedError extends Schema.TaggedError<ThreadRenameFailedError>()(
  "ThreadRenameFailedError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not rename the current thread.";
  }
}

const RenameThreadTool = Tool.make("rename_thread", {
  description:
    "Rename the current T3 Code thread when the user or a skill asks for a specific name. Pass the desired title, including any task ID or naming convention. This saves a manual title that automatic title generation will not overwrite. Only the calling thread can be renamed.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString.annotate({
      description:
        "The new thread title. Leading and trailing whitespace is removed; it must not be empty.",
    }),
  }),
  success: Schema.Struct({ threadId: ThreadId, title: TrimmedNonEmptyString }),
  failure: Schema.Union([McpCapabilityUnavailableError, ThreadRenameFailedError]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    OrchestrationEngine.OrchestrationEngineService,
  ],
})
  .annotate(Tool.Title, "Rename current thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(RenameThreadTool);
