import { useGT } from "gt-react";

import {
  composerTargetKey,
  resolveLiveComposerDraftTarget,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { Button } from "../ui/button";
import { discardFailedSendAttachments, retryFailedSendAttachments } from "./chatViewSend";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function useFailedAttachmentsBanner(
  composerDraftTarget: ComposerThreadTarget,
): ComposerBannerStackItem | null {
  const gt = useGT();
  const failedAttachments = useComposerDraftStore((store) =>
    store.failedComposerAttachments.find((entry) => {
      const live = resolveLiveComposerDraftTarget(entry.target, store);
      return (
        live === null ||
        composerTargetKey(live) ===
          composerTargetKey(
            resolveLiveComposerDraftTarget(composerDraftTarget, store) ?? composerDraftTarget,
          )
      );
    }),
  );
  return failedAttachments
    ? {
        id: "failed-attachments",
        variant: "warning",
        icon: null,
        title: gt("Attachments still waiting to be restored"),
        description: gt("Make room in this draft, then restore the remaining attachments."),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              retryFailedSendAttachments(failedAttachments, composerDraftTarget);
            }}
          >
            {gt("Restore attachments")}
          </Button>
        ),
        dismissLabel: gt("Discard"),
        onDismiss: () => discardFailedSendAttachments(failedAttachments),
      }
    : null;
}
