import {
  createProjectFaviconCache,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
  PROJECT_FAVICON_THUMBNAIL_SIZE,
} from "@t3tools/client-runtime/project-favicon-cache";

export async function createProjectFaviconThumbnail(url: string, signal: AbortSignal) {
  const [{ Image }, { File }] = await Promise.all([
    import("expo-image"),
    import("expo-file-system"),
  ]);
  for (const size of [PROJECT_FAVICON_THUMBNAIL_SIZE, PROJECT_FAVICON_THUMBNAIL_SIZE / 2]) {
    signal.throwIfAborted();
    const image = await Image.loadAsync(url, { maxWidth: size, maxHeight: size });
    const cacheKey = `t3-favicon-thumbnail:${size}:${url}`;
    try {
      signal.throwIfAborted();
      if (image.width > size || image.height > size) {
        throw new Error("Project icon was not resized.");
      }
      await Image.writeToCacheAsync(image, cacheKey);
      const path = await Image.getCachePathAsync(cacheKey);
      if (!path) throw new Error("Project icon thumbnail was not written.");
      const file = new File(path.startsWith("file:") ? path : `file://${path}`);
      try {
        if (file.size > PROJECT_FAVICON_MAX_DATA_URL_LENGTH) continue;
        const base64 = await file.base64();
        // SDWebImage chooses JPEG for opaque images and PNG for transparency.
        const mimeType = base64.startsWith("/9j/")
          ? "image/jpeg"
          : base64.startsWith("iVBORw0KGgo")
            ? "image/png"
            : null;
        if (!mimeType) throw new Error("Unsupported project icon thumbnail encoding.");
        const dataUrl = `data:${mimeType};base64,${base64}`;
        if (dataUrl.length <= PROJECT_FAVICON_MAX_DATA_URL_LENGTH) return dataUrl;
      } finally {
        file.delete();
      }
    } finally {
      image.release();
    }
  }
  throw new Error("Project icon thumbnail exceeds the cache limit.");
}

async function cacheFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.cache, "t3-project-favicons-v1.json");
}

export const projectFaviconCache = createProjectFaviconCache({
  async read() {
    const file = await cacheFile();
    return file.exists ? file.text() : null;
  },
  async write(json) {
    const file = await cacheFile();
    file.write(json);
  },
  thumbnail: createProjectFaviconThumbnail,
});
