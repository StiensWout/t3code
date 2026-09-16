import { toastManager } from "../ui/toast";

export interface WorkspaceFileDragEvent {
  readonly dataTransfer: {
    readonly types: ReadonlyArray<string>;
    readonly files: Iterable<File>;
    readonly items?: Iterable<{
      readonly kind: string;
      getAsFile(): File | null;
      webkitGetAsEntry?(): Pick<FileSystemEntry, "isDirectory"> | null;
    }>;
    dropEffect: string;
  };
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: {
    contains(target: Node | null): boolean;
  };
  preventDefault(): void;
}

export interface WorkspaceFileDropHost {
  setDragActive(active: boolean): void;
  addFiles(files: File[]): void;
}

function isFileDrag(event: WorkspaceFileDragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

function movedWithinDropTarget(event: WorkspaceFileDragEvent): boolean {
  return event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node);
}

export function makeWorkspaceFileDropHandlers(host: WorkspaceFileDropHost) {
  return {
    onDragEnter(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(true);
    },
    onDragOver(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDragLeave(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(false);
    },
    onDrop(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      host.setDragActive(false);
      // A directory can appear in `files` as a non-empty File. Read entry metadata
      // during the drop event, while the browser's drag data store is accessible.
      const items = Array.from(event.dataTransfer.items ?? []).filter(
        (item) => item.kind === "file",
      );
      const files: File[] = [];
      let skippedFolders = false;
      if (items.length > 0) {
        for (const item of items) {
          if (item.webkitGetAsEntry?.()?.isDirectory) {
            skippedFolders = true;
            continue;
          }
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      } else {
        files.push(...event.dataTransfer.files);
      }
      if (skippedFolders) {
        toastManager.add({
          type: "info",
          title: "Folders can't be attached",
          description: "Use @ or paste a folder path accessible to this environment.",
        });
      }
      if (files.length > 0) host.addFiles(files);
    },
  };
}
