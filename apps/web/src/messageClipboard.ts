import { ClipboardWriteError, writeTextToClipboard } from "./hooks/useCopyToClipboard";

export interface MessageClipboardImage {
  readonly mimeType: string;
  readonly previewUrl?: string;
}

function imageBlobAsPng(blob: Blob): Promise<Blob> {
  if (blob.type.toLowerCase() === "image/png") {
    return Promise.resolve(blob);
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.addEventListener(
      "load",
      () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) {
            reject(new Error("Could not prepare the copied image."));
            return;
          }
          context.drawImage(image, 0, 0);
          canvas.toBlob((png) => {
            if (png) {
              resolve(png);
            } else {
              reject(new Error("Could not encode the copied image."));
            }
          }, "image/png");
        } catch (cause) {
          reject(cause);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Could not read the copied image."));
      },
      { once: true },
    );
    image.src = objectUrl;
  });
}

async function fetchClipboardImageAsPng(previewUrl: string, mimeType: string): Promise<Blob> {
  const response = await fetch(previewUrl);
  if (!response.ok) {
    throw new Error("Could not load the copied image.");
  }
  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error("The copied image is empty.");
  }
  const typedBlob = blob.type.startsWith("image/") ? blob : new Blob([blob], { type: mimeType });
  return imageBlobAsPng(typedBlob);
}

/** Writes text plus one image as a single clipboard item so both paste together. */
export async function writeMessageToClipboard(
  value: string,
  image: MessageClipboardImage | undefined,
): Promise<boolean> {
  if (!value) return false;

  if (
    !image?.previewUrl ||
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    typeof ClipboardItem === "undefined" ||
    typeof navigator.clipboard?.write !== "function"
  ) {
    return writeTextToClipboard(value, "message");
  }

  try {
    const item = new ClipboardItem({
      "text/plain": new Blob([value], { type: "text/plain" }),
      "image/png": fetchClipboardImageAsPng(image.previewUrl, image.mimeType),
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch (cause) {
    console.warn(
      new ClipboardWriteError({
        target: "message with image",
        cause,
      }),
    );
    return writeTextToClipboard(value, "message");
  }
}
