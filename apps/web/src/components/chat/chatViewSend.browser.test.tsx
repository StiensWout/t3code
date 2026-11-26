import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS, ThreadId } from "@t3tools/contracts";
import { expect, it, onTestFinished } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ToastProvider } from "../ui/toast";
import { restoreFailedSendAttachments } from "./chatViewSend";

it("restores failed images and files after making room in the newer draft", async () => {
  const target = scopeThreadRef(EnvironmentId.make("test"), ThreadId.make("attachment-retry"));
  const store = useComposerDraftStore.getState();
  onTestFinished(() => store.clearComposerContent(target));
  store.setPrompt(target, "Keep this new draft");

  const file = new File(["notes"], "notes.txt", { type: "text/plain" });
  const attachment = {
    type: "file" as const,
    id: "failed-file",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
  const newerFiles = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
    ...attachment,
    id: `new-file-${index}`,
  }));
  store.addFiles(target, newerFiles, { allowDuplicates: true });

  const screenshot = new File(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>',
    ],
    "screenshot.svg",
    { type: "image/svg+xml" },
  );
  const originalPreview = URL.createObjectURL(screenshot);
  URL.revokeObjectURL(originalPreview);
  await using _screen = await render(<ToastProvider>{null}</ToastProvider>);
  restoreFailedSendAttachments(target, {
    images: [
      {
        type: "image",
        id: "failed-image",
        name: screenshot.name,
        mimeType: screenshot.type,
        sizeBytes: screenshot.size,
        file: screenshot,
        previewUrl: originalPreview,
      },
    ],
    files: [attachment],
  });

  expect(store.getComposerDraft(target)?.images).toEqual([]);
  expect(store.getComposerDraft(target)?.files).toEqual(newerFiles);
  const retry = page.getByRole("button", { name: "Restore attachments" });
  await expect.element(retry).toBeVisible();

  store.removeFile(target, "new-file-0");
  await retry.click();
  await expect.element(retry).toBeVisible();
  store.removeFile(target, "new-file-1");
  await retry.click();

  const previewUrl = store.getComposerDraft(target)?.images[0]?.previewUrl;
  if (!previewUrl) throw new Error("Expected the recovered screenshot to have a preview");
  onTestFinished(() => URL.revokeObjectURL(previewUrl));
  const preview = new Image();
  preview.src = previewUrl;
  await preview.decode();
  expect(preview.naturalWidth).toBe(16);
  expect(store.getComposerDraft(target)?.prompt).toBe("Keep this new draft");
  expect(store.getComposerDraft(target)?.files).toEqual([...newerFiles.slice(2), attachment]);
  await expect.element(retry).not.toBeInTheDocument();
});
