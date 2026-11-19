import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  Passthrough: ({ children }: { children?: unknown }) => children,
  release: () => {},
  refresh: vi.fn<() => Promise<string | null>>(),
  download: vi.fn<(input: { signal: AbortSignal }) => Promise<void>>(),
  loadLocal: vi.fn<(attachment: unknown, signal: AbortSignal) => Promise<unknown>>(),
  alert: vi.fn(),
  shared: [] as string[],
}));

vi.mock("react-native", () => ({ Pressable: harness.Passthrough, View: harness.Passthrough }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("expo-crypto", () => ({}));
vi.mock("./ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("./ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("./ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./ui/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("./ui/NativePresentation", () => ({ PresentationSource: harness.Passthrough }));
vi.mock("../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Loading" }),
  useRefreshAssetUrl: () => harness.refresh,
}));
vi.mock("../lib/attachmentDownload", () => ({ downloadAndShareAttachment: harness.download }));
vi.mock("../lib/localAttachmentPreview", () => ({
  loadLocalAttachmentPreview: harness.loadLocal,
  useLocalAttachmentPreview: () => ({ uri: null, error: null }),
}));

import { ComposerContextAttachment } from "./ComposerContextAttachment";
import { ComposerContextId, EnvironmentId } from "@t3tools/contracts";

const record = {
  version: 1,
  contextId: ComposerContextId.make("context-1"),
  label: "annotation.png",
  kind: "image",
  attachmentId: "attachment-1",
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: 1234,
} as const;

const localAttachment = {
  id: "attachment-1",
  type: "file",
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: 1234,
  fileUri: "file:///annotation.png",
} as const;

const held = <A,>(value: A) =>
  new Promise<A>((resolve) => {
    harness.release = () => resolve(value);
  });

// Each stub shares only on a live signal, as the real download and share helpers do.
const shareUnlessAborted = (signal: AbortSignal) => {
  if (!signal.aborted) harness.shared.push("share sheet");
};

it.each([
  {
    stage: "the download",
    attachment: undefined,
    setup: () => {
      harness.refresh.mockResolvedValue("https://example.test/annotation.png");
      harness.download.mockImplementation(async ({ signal }) => {
        await held(undefined);
        shareUnlessAborted(signal);
      });
    },
  },
  {
    stage: "a URL request that then fails",
    attachment: undefined,
    setup: () => harness.refresh.mockImplementation(() => held(null)),
  },
  {
    stage: "the local file",
    attachment: localAttachment,
    setup: () =>
      harness.loadLocal.mockImplementation(async () => {
        await held(undefined);
        return {
          share: async (shareSignal: AbortSignal) => shareUnlessAborted(shareSignal),
          dispose: () => {},
        };
      }),
  },
])("opens nothing after the sheet closes during $stage", async ({ attachment, setup }) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.shared = [];
  harness.alert.mockReset();
  setup();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ComposerContextAttachment
        record={record}
        environmentId={EnvironmentId.make("environment-1")}
        attachment={attachment}
      />,
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  await act(async () => root.unmount());
  await act(async () => harness.release());

  expect(harness.shared).toEqual([]);
  expect(harness.alert).not.toHaveBeenCalled();
});
