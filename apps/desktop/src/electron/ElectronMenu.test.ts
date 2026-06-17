import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const { buildFromTemplateMock, createFromNamedImageMock, setApplicationMenuMock } = vi.hoisted(
  () => ({
    buildFromTemplateMock: vi.fn(),
    createFromNamedImageMock: vi.fn(),
    setApplicationMenuMock: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
    setApplicationMenu: setApplicationMenuMock,
  },
  nativeImage: {
    createFromNamedImage: createFromNamedImageMock,
  },
}));

import * as ElectronMenu from "./ElectronMenu.ts";

const electronMenuLayerForPlatform = (platform: NodeJS.Platform) =>
  ElectronMenu.layer.pipe(Layer.provide(Layer.succeed(HostProcessPlatform, platform)));

describe("ElectronMenu", () => {
  beforeEach(() => {
    buildFromTemplateMock.mockReset();
    createFromNamedImageMock.mockReset();
    setApplicationMenuMock.mockReset();
  });

  it.effect("returns none without building a menu when there are no valid items", () =>
    Effect.gen(function* () {
      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [],
        position: Option.none(),
      });

      assert.isTrue(Option.isNone(selectedItemId));
      assert.equal(buildFromTemplateMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("resolves with the clicked leaf item id", () =>
    Effect.gen(function* () {
      buildFromTemplateMock.mockImplementation(
        (template: Electron.MenuItemConstructorOptions[]) => ({
          popup: () => {
            const firstItem = template[0];
            assert.isDefined(firstItem);
            const click = firstItem.click;
            if (!click) {
              throw new Error("Expected menu item to have a click handler.");
            }
            click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
          },
        }),
      );

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [{ id: "copy", label: "Copy" }],
        position: Option.none(),
      });

      assert.equal(Option.getOrNull(selectedItemId), "copy");
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("resolves with none when the menu closes without a click", () =>
    Effect.gen(function* () {
      buildFromTemplateMock.mockImplementation(() => ({
        popup: (options: Electron.PopupOptions) => {
          options.callback?.();
        },
      }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [{ id: "copy", label: "Copy" }],
        position: Option.some({ x: 10.8, y: 20.2 }),
      });

      assert.isTrue(Option.isNone(selectedItemId));
      assert.deepEqual(buildFromTemplateMock.mock.calls[0]?.[0][0], {
        label: "Copy",
        enabled: true,
        click: buildFromTemplateMock.mock.calls[0]?.[0][0].click,
      });
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("marks the macOS destructive menu icon as a template image", () =>
    Effect.gen(function* () {
      const setTemplateImageMock = vi.fn<(option: boolean) => void>();
      const resizedIcon = {
        isEmpty: vi.fn<() => boolean>(() => false),
        setTemplateImage: setTemplateImageMock,
      } as unknown as Electron.NativeImage;
      const resizeMock = vi.fn<
        (options: Parameters<Electron.NativeImage["resize"]>[0]) => Electron.NativeImage
      >(() => resizedIcon);
      const sourceIcon = {
        resize: resizeMock,
      } as unknown as Electron.NativeImage;
      createFromNamedImageMock.mockReturnValue(sourceIcon);
      buildFromTemplateMock.mockImplementation(() => ({
        popup: (options: Electron.PopupOptions) => {
          options.callback?.();
        },
      }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [
          { id: "copy", label: "Copy" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position: Option.none(),
      });

      const template = buildFromTemplateMock.mock.calls[0]?.[0] as
        | Electron.MenuItemConstructorOptions[]
        | undefined;
      assert.isDefined(template);
      assert.deepEqual(resizeMock.mock.calls[0]?.[0], { width: 12, height: 12 });
      assert.equal(template?.[1]?.type, "separator");
      assert.equal(template?.[2]?.label, "Delete");
      assert.strictEqual(template?.[2]?.icon, resizedIcon);
      assert.deepEqual(setTemplateImageMock.mock.calls, [[true]]);
      assert.isTrue(
        (setTemplateImageMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY) <
          (buildFromTemplateMock.mock.invocationCallOrder[0] ?? 0),
      );
    }).pipe(Effect.provide(electronMenuLayerForPlatform("darwin"))),
  );

  it.effect("defers popupTemplate side effects until the returned Effect runs", () =>
    Effect.gen(function* () {
      const popupMock = vi.fn();
      buildFromTemplateMock.mockImplementation(() => ({ popup: popupMock }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const popup = electronMenu.popupTemplate({
        window: {} as Electron.BrowserWindow,
        template: [{ label: "Copy" }],
      });

      assert.equal(buildFromTemplateMock.mock.calls.length, 0);
      assert.equal(popupMock.mock.calls.length, 0);

      yield* popup;

      assert.equal(buildFromTemplateMock.mock.calls.length, 1);
      assert.equal(popupMock.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );
});
