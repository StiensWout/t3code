import type { ChatAttachment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import type { FilePreviewItem } from "../../components/ui/FilePreviewModal.types";
import { prepareAssistantMarkdown } from "../../lib/assistantMarkdown";
import { markdownImageSources, mayHaveMarkdownImages } from "../../lib/markdownImageSources";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import type { ThreadFeedMessage } from "../../lib/threadActivity";

function assistantMarkdownImageSources(
  markdown: string,
  mathRenderingEnabled: boolean,
): Set<string> {
  const sources = new Set<string>();
  const collect = (fragment: string, inheritedDefinitions?: ReadonlyArray<string>) => {
    if (!mayHaveMarkdownImages(fragment)) return;
    const { blocks, definitions } = prepareAssistantMarkdown(fragment, inheritedDefinitions);
    for (const block of blocks) {
      if (block.kind === "details") {
        collect(block.body, definitions);
      } else {
        for (const segment of block.segments) {
          if (segment.kind !== "markdown") continue;
          for (const href of markdownImageSources(segment.markdown, { mathRenderingEnabled })) {
            sources.add(href);
          }
        }
      }
    }
  };
  collect(markdown);
  return sources;
}

export function messageImageGallery(
  message: Pick<ThreadFeedMessage, "text" | "role"> & {
    readonly attachments?: readonly ChatAttachment[];
  },
  context: {
    environmentId: EnvironmentId;
    threadId: ThreadId;
    workspaceRoot: string | null | undefined;
    mathRenderingEnabled?: boolean;
  },
): FilePreviewItem[] {
  const images: FilePreviewItem[] = [];
  for (const attachment of message.attachments ?? []) {
    if (attachment.type !== "image" && imageMimeType(attachment) === null) continue;
    images.push({
      kind: "image",
      name: attachment.name,
      environmentId: context.environmentId,
      resource: {
        _tag: "attachment",
        attachmentId: attachment.id,
        fileName: attachment.name,
        mimeType: attachment.mimeType,
      },
    });
  }
  const sources =
    message.role === "assistant"
      ? assistantMarkdownImageSources(message.text, context.mathRenderingEnabled ?? false)
      : markdownImageSources(message.text, { inlineOnly: true });
  for (const href of sources) {
    const preview = resolveMarkdownMediaPreview(href, { ...context, imageEmbed: true });
    if (preview?.kind === "image") images.push(preview.source);
  }
  return images;
}
