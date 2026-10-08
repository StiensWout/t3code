import {
  McpManagementSnapshot,
  ManagedMcpServerSnapshot,
  McpUpsertInput,
  McpRemoveInput,
  McpSetEnabledInput,
  McpCopyInput,
  McpImportPreviewInput,
  McpImportPreviewResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as McpManagement from "../../../mcpManagement/McpManagement.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  success: McpManagementSnapshot,
  dependencies: [
    McpManagement.McpManagement,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};

const catalogSummary = Schema.Struct({
  ...McpManagementSnapshot.fields,
  servers: Schema.Array(
    Schema.Struct({
      ...ManagedMcpServerSnapshot.fields,
      transport: Schema.Union([
        Schema.Struct({ type: Schema.Literal("stdio") }),
        Schema.Struct({ type: Schema.Literal("http"), origin: Schema.String }),
      ]),
    }),
  ),
});

export const McpManagementToolkit = Toolkit.make(
  Tool.make("t3_mcp_list", {
    ...shared,
    success: Schema.Union([McpManagementSnapshot, catalogSummary]),
    description:
      "List this environment's T3-managed MCP definitions, provider assignments, sign-in status, and pending session revisions. Only full-access callers receive configuration. Other callers receive transport types and HTTP origins. Sensitive env, header, and client-secret values are redacted. Native provider settings remain independent.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_mcp_upsert", {
    ...shared,
    parameters: McpUpsertInput,
    description:
      "Add or update a T3-managed MCP definition using the latest catalog revision. Preserve redacted credentials with their valueRedacted marker. Applies when provider sessions next start; OAuth sign-in is performed in Settings > Providers > MCPs.",
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_mcp_remove", {
    ...shared,
    parameters: McpRemoveInput,
    description:
      "Remove a T3-managed MCP definition using the latest catalog revision. Also clears its T3 OAuth grant.",
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_mcp_set_enabled", {
    ...shared,
    parameters: McpSetEnabledInput,
    description:
      "Enable or disable a managed MCP for one provider instance. Applies when its provider sessions next start.",
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_mcp_copy", {
    ...shared,
    parameters: McpCopyInput,
    description:
      "Add the source provider instance's enabled managed MCPs to the target. Existing target assignments are preserved. Credentials stay in this environment.",
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_mcp_import_preview", {
    ...shared,
    parameters: McpImportPreviewInput,
    success: McpImportPreviewResult,
    description:
      "Preview definitions from pasted native JSON, JSONC, or TOML configuration without changing native files or settings. Review warnings and save selected definitions with t3_mcp_upsert. The preview includes supplied credentials.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
