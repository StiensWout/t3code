import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { writeMessageToClipboard } from "./messageClipboard";

class TestClipboardItem {
  constructor(readonly data: Record<string, Blob | PromiseLike<Blob>>) {}
}

describe("message clipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes prompt text and a PNG as one clipboard item", async () => {
    const write = vi.fn(async (items: TestClipboardItem[]) => {
      await Promise.all(Object.values(items[0]!.data));
    });
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), {
          status: 200,
        }),
      ),
    );

    await expect(
      writeMessageToClipboard("Describe this screenshot", {
        mimeType: "image/png",
        previewUrl: "blob:screenshot",
      }),
    ).resolves.toBe(true);

    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0]![0][0]!;
    expect(Object.keys(item.data)).toEqual(["text/plain", "image/png"]);
    await expect(Promise.resolve(item.data["text/plain"])).resolves.toMatchObject({
      type: "text/plain",
    });
    await expect(Promise.resolve(item.data["image/png"])).resolves.toMatchObject({
      type: "image/png",
      size: 3,
    });
  });

  it("falls back to text copy without a usable image", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(writeMessageToClipboard("Text only", undefined)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("Text only");
  });

  it("still copies the text when the rich clipboard write fails", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      clipboard: {
        write: vi.fn().mockRejectedValue(new Error("rich clipboard rejected")),
        writeText,
      },
    });
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Blob([new Uint8Array([1])], { type: "image/png" }), { status: 200 }),
        ),
    );

    await expect(
      writeMessageToClipboard("Keep this text", {
        mimeType: "image/png",
        previewUrl: "blob:stale-image",
      }),
    ).resolves.toBe(true);

    expect(warn).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("Keep this text");
  });
});
