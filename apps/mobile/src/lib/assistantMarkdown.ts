import {
  renderCodexInlineDirectivesAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import type { MessageResolver } from "../i18n/messages";
import { splitMarkdownDetails } from "./markdownDetails";
import { markdownReferenceDefinitions, withReferenceDefinitions } from "./markdownDocument";

/** Prepares one level of the reply so callers can open folds on demand. */
export function prepareAssistantMarkdown(
  markdown: string,
  inheritedDefinitions?: ReadonlyArray<string>,
  resolve?: MessageResolver,
) {
  const blocks = splitMarkdownDetails(markdown, resolve).map((block) =>
    block.kind === "details"
      ? block
      : { ...block, segments: splitCodexArtifactTemplateMarkdown(block.markdown) },
  );
  const [first] = blocks;
  // A reply rendered as one document resolves its own references.
  const whole = blocks.length === 1 && first?.kind === "markdown" && first.segments.length === 1;
  const definitions = inheritedDefinitions ?? (whole ? [] : markdownReferenceDefinitions(markdown));
  return {
    definitions,
    blocks: blocks.map((block) =>
      block.kind === "details"
        ? block
        : {
            ...block,
            segments: block.segments.map((segment) =>
              segment.kind === "artifact-template"
                ? segment
                : {
                    ...segment,
                    markdown: renderCodexInlineDirectivesAsMarkdown(
                      withReferenceDefinitions(segment.markdown, definitions),
                    ),
                  },
            ),
          },
    ),
  };
}
