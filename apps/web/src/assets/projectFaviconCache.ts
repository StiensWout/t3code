import {
  createProjectFaviconCache,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
  PROJECT_FAVICON_THUMBNAIL_SIZE,
} from "@t3tools/client-runtime/project-favicon-cache";

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("t3code:project-favicons", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore("thumbnails"));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("Project icon cache is blocked.")));
  }));
}

export async function createProjectFaviconThumbnail(url: string, signal: AbortSignal) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => finish(signal.reason);
      const loaded = () => finish();
      const failed = () => finish(new Error("Could not decode project icon."));
      const finish = (error?: unknown) => {
        signal.removeEventListener("abort", abort);
        image.removeEventListener("load", loaded);
        image.removeEventListener("error", failed);
        if (error) reject(error);
        else resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      image.addEventListener("load", loaded, { once: true });
      image.addEventListener("error", failed, { once: true });
      if (signal.aborted) finish(signal.reason);
      else image.src = url;
    });
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    for (const size of [PROJECT_FAVICON_THUMBNAIL_SIZE, PROJECT_FAVICON_THUMBNAIL_SIZE / 2]) {
      const scale = Math.min(1, size / image.naturalWidth, size / image.naturalHeight);
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/webp", 0.85);
      if (dataUrl.length <= PROJECT_FAVICON_MAX_DATA_URL_LENGTH) return dataUrl;
    }
    throw new Error("Project icon thumbnail exceeds the cache limit.");
  } finally {
    image.src = "";
  }
}

export const projectFaviconCache = createProjectFaviconCache({
  async read() {
    const db = await openDatabase();
    return new Promise<string | null>((resolve, reject) => {
      const request = db.transaction("thumbnails", "readonly").objectStore("thumbnails").get("v1");
      request.addEventListener("success", () =>
        resolve(typeof request.result === "string" ? request.result : null),
      );
      request.addEventListener("error", () => reject(request.error));
    });
  },
  async write(json) {
    const db = await openDatabase();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("thumbnails", "readwrite");
      transaction.objectStore("thumbnails").put(json, "v1");
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  },
  thumbnail: createProjectFaviconThumbnail,
});
