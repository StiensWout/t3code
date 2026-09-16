import { describe, expect, it, vi } from "vite-plus/test";
import { toastManager } from "../ui/toast";
import {
  makeWorkspaceFileDropHandlers,
  type WorkspaceFileDragEvent,
  type WorkspaceFileDropHost,
} from "./workspaceFileDrop";

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function makeDragEvent(options?: {
  types?: string[];
  files?: File[];
  items?: WorkspaceFileDragEvent["dataTransfer"]["items"];
  movedWithinTarget?: boolean;
}) {
  const preventDefault = vi.fn();
  const event = {
    dataTransfer: {
      types: options?.types ?? ["Files"],
      files: options?.files ?? [],
      ...(options?.items ? { items: options.items } : {}),
      dropEffect: "none",
    },
    relatedTarget: options?.movedWithinTarget ? ({} as EventTarget) : null,
    currentTarget: {
      contains: () => options?.movedWithinTarget ?? false,
    },
    preventDefault,
  } satisfies WorkspaceFileDragEvent;
  return { event, preventDefault };
}

function makeHost() {
  const setDragActive = vi.fn();
  const addFiles = vi.fn();
  const host = { setDragActive, addFiles } satisfies WorkspaceFileDropHost;
  return { host, setDragActive, addFiles };
}

describe("makeWorkspaceFileDropHandlers", () => {
  it("activates the target for an external file drag", () => {
    const { host, setDragActive } = makeHost();
    const { event, preventDefault } = makeDragEvent();

    makeWorkspaceFileDropHandlers(host).onDragEnter(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setDragActive).toHaveBeenCalledWith(true);
  });

  it("ignores non-file drags", () => {
    const { host, setDragActive } = makeHost();
    const { event, preventDefault } = makeDragEvent({ types: ["text/plain"] });

    makeWorkspaceFileDropHandlers(host).onDragOver(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(setDragActive).not.toHaveBeenCalled();
  });

  it("does not flicker when the drag moves between children", () => {
    const { host, setDragActive } = makeHost();
    const { event } = makeDragEvent({ movedWithinTarget: true });

    const handlers = makeWorkspaceFileDropHandlers(host);
    handlers.onDragEnter(event);
    handlers.onDragLeave(event);

    expect(setDragActive).not.toHaveBeenCalled();
  });

  it("forwards dropped files and clears the active state", () => {
    const file = new File(["contents"], "example.txt", { type: "text/plain" });
    const { host, setDragActive, addFiles } = makeHost();
    const { event } = makeDragEvent({ files: [file] });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(setDragActive).toHaveBeenCalledWith(false);
    expect(addFiles).toHaveBeenCalledWith([file]);
  });

  it("rejects folders without staging attachments and explains how to reference them", () => {
    const folder = new File(["directory metadata"], "sample-folder");
    const { host, setDragActive, addFiles } = makeHost();
    const { event, preventDefault } = makeDragEvent({
      files: [folder],
      items: [
        { kind: "file", getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) },
      ],
    });
    vi.mocked(toastManager.add).mockClear();

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setDragActive).toHaveBeenCalledWith(false);
    expect(addFiles).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledExactlyOnceWith({
      type: "info",
      title: "Folders can't be attached",
      description: "Use @ or paste a folder path accessible to this environment.",
    });
  });

  it("attaches only real files from a mixed drop, including files without a MIME type", () => {
    const folder = new File(["directory metadata"], "folder.txt");
    const file = new File(["contents"], "README");
    const image = new File(["image"], "image.png", { type: "image/png" });
    const { host, addFiles } = makeHost();
    const { event } = makeDragEvent({
      files: [folder, file, image],
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) },
        { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) },
        { kind: "file", getAsFile: () => image, webkitGetAsEntry: () => ({ isDirectory: false }) },
      ],
    });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(addFiles).toHaveBeenCalledExactlyOnceWith([file, image]);
  });

  it.each([undefined, () => null])(
    "keeps files when entry metadata is unavailable (%s)",
    (webkitGetAsEntry) => {
      const file = new File(["contents"], "README");
      const { host, addFiles } = makeHost();
      const { event } = makeDragEvent({
        files: [file],
        items: [
          {
            kind: "file",
            getAsFile: () => file,
            ...(webkitGetAsEntry ? { webkitGetAsEntry } : {}),
          },
        ],
      });

      makeWorkspaceFileDropHandlers(host).onDrop(event);

      expect(addFiles).toHaveBeenCalledExactlyOnceWith([file]);
    },
  );

  it("does not restore rejected folders from the file list when other items have no file", () => {
    const folder = new File(["directory metadata"], "folder");
    const { host, addFiles } = makeHost();
    const { event } = makeDragEvent({
      files: [folder],
      items: [
        { kind: "file", getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) },
        { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => null },
      ],
    });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(addFiles).not.toHaveBeenCalled();
  });
});
