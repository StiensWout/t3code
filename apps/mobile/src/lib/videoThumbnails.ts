import type { VideoThumbnail } from "expo-video";

import type { AttachmentPreviewFile } from "./attachmentDownload";

// A frame is reused only for the URL it was decoded from: a file regenerated at the same path
// keeps its key but is reauthorized to a new URL. Renewal re-signs it too, at most every 30 min.
const thumbnails = new Map<string, { readonly uri: string; readonly thumbnail: VideoThumbnail }>();
const MAX_CACHED_THUMBNAILS = 32;
let pending: Promise<unknown> = Promise.resolve();

export function cachedVideoThumbnail(key: string): VideoThumbnail | null {
  return thumbnails.get(key)?.thumbnail ?? null;
}

async function extractFrame(uri: string) {
  const { createVideoPlayer } = await import("expo-video");
  const player = createVideoPlayer(null);
  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let attachedSubscription: { remove(): void } | undefined;
  try {
    // Never play or change audio settings: thumbnails must leave the shared audio session alone.
    player.bufferOptions = { preferredForwardBufferDuration: 1 };
    const timedOut = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), 15_000);
    });
    // iOS resolves replaceAsync before the main thread attaches the item, and until then
    // generateThumbnailsAsync finds no asset and returns no frames.
    const attached = new Promise<void>((resolve) => {
      attachedSubscription = player.addListener("sourceChange", ({ source }) => {
        if (source) resolve();
      });
    });
    const frame = (async () => {
      await player.replaceAsync({ uri, contentType: "progressive" });
      await attached;
      if (disposed) return null;
      const [thumbnail] = await player.generateThumbnailsAsync([0], {
        maxWidth: 480,
        maxHeight: 480,
      });
      return thumbnail ?? null;
    })();
    return await Promise.race([frame, timedOut]);
  } finally {
    disposed = true;
    clearTimeout(timeout);
    attachedSubscription?.remove();
    player.release();
  }
}

export function loadVideoThumbnail(
  key: string,
  resolveSource: (
    signal: AbortSignal,
  ) => Promise<Pick<AttachmentPreviewFile, "uri" | "dispose"> | null>,
  signal: AbortSignal,
): Promise<VideoThumbnail | null> {
  if (signal.aborted) return Promise.resolve(null);
  const load = pending
    .then(async () => {
      if (signal.aborted) return null;
      const source = await resolveSource(signal);
      if (!source) return null;
      try {
        const cached = thumbnails.get(key);
        if (cached?.uri === source.uri) return cached.thumbnail;
        if (signal.aborted) return null;
        // A started extraction finishes even if its reader leaves: its requests are already in
        // flight, and a later reader of the same URL reuses the frame.
        const thumbnail = await extractFrame(source.uri);
        if (!thumbnail) return null;
        thumbnails.set(key, { uri: source.uri, thumbnail });
        if (thumbnails.size > MAX_CACHED_THUMBNAILS) {
          thumbnails.delete(thumbnails.keys().next().value!);
        }
        return thumbnail;
      } finally {
        source.dispose();
      }
    })
    .catch(() => null);
  pending = load;
  return load;
}
