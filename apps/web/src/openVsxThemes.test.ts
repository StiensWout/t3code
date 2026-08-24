import { sha256 } from "@noble/hashes/sha2";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  importOpenVsxThemeExtension,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
} from "./openVsxThemes";
import { getThemeColorsForMode, themeColorToHex } from "./themePalette";

const ASSET_ROOT = "https://open-vsx.org/api/demo/theme/1.0.0/file";

function extensionDetail(overrides: Record<string, unknown> = {}) {
  return {
    namespace: "demo",
    name: "theme",
    displayName: "Demo Theme",
    description: "A nice theme",
    version: "1.0.0",
    downloadCount: 123456,
    license: "MIT",
    verified: true,
    publishedBy: { loginName: "demo-publisher" },
    repository: "https://github.com/demo/theme",
    files: {
      icon: `${ASSET_ROOT}/icon.png`,
      manifest: `${ASSET_ROOT}/package.json`,
      sha256: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
      download: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    },
    ...overrides,
  };
}

function selectedExtension(overrides: Partial<OpenVsxThemeExtension> = {}): OpenVsxThemeExtension {
  return {
    collectionId: "open-vsx:demo.theme",
    id: "demo.theme",
    extensionName: "theme",
    name: "Demo Theme",
    publisher: "demo",
    publishedBy: "demo-publisher",
    description: "",
    downloadCount: 1,
    iconUrl: null,
    repositoryUrl: "https://github.com/demo/theme",
    sourceUrl: "https://github.com/demo/theme",
    license: "MIT",
    manifestUrl: `${ASSET_ROOT}/package.json`,
    sha256Url: `${ASSET_ROOT}/demo.theme-1.0.0.sha256`,
    version: "1.0.0",
    verified: true,
    vsixUrl: `${ASSET_ROOT}/demo.theme-1.0.0.vsix`,
    ...overrides,
  };
}

function responseAt(response: Response, url?: string): Response {
  if (url) Object.defineProperty(response, "url", { value: url });
  return response;
}

function packageChecksum(bytes: Uint8Array): string {
  return [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildThemePackage({
  contributionPath = "./themes/theme.json",
  files = {
    "themes/theme.json": JSON.stringify({ colors: { "editor.background": "#181818" } }),
  },
  compression = "STORE",
}: {
  contributionPath?: string;
  files?: Readonly<Record<string, string>>;
  compression?: "STORE" | "DEFLATE";
} = {}): Promise<{ bytes: Uint8Array; checksum: string }> {
  const zip = new JSZip();
  zip.file(
    "extension/package.json",
    JSON.stringify({
      publisher: "demo",
      name: "theme",
      version: "1.0.0",
      license: "MIT",
      contributes: {
        themes: [{ label: "Demo", uiTheme: "vs-dark", path: contributionPath }],
      },
    }),
  );
  for (const [path, source] of Object.entries(files)) zip.file(`extension/${path}`, source);
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression,
    ...(compression === "DEFLATE" ? { compressionOptions: { level: 9 } } : {}),
  });
  return { bytes, checksum: packageChecksum(bytes) };
}

function stubThemeImport(
  fixture: { bytes: Uint8Array; checksum: string },
  {
    detail = extensionDetail(),
    finalUrls = {},
  }: {
    detail?: unknown;
    finalUrls?: Partial<Record<"manifest" | "package" | "checksum", string>>;
  } = {},
): void {
  const extension = selectedExtension();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://open-vsx.org/api/demo/theme/1.0.0") {
        return new Response(JSON.stringify(detail), { status: 200 });
      }
      if (url === extension.manifestUrl) {
        return responseAt(
          new Response(
            JSON.stringify({ license: "MIT", contributes: { themes: [{ path: "./theme.json" }] } }),
            { status: 200 },
          ),
          finalUrls.manifest,
        );
      }
      if (url === extension.sha256Url) {
        return responseAt(new Response(fixture.checksum), finalUrls.checksum);
      }
      if (url === extension.vsixUrl) {
        return responseAt(
          new Response(new Uint8Array(fixture.bytes).buffer, {
            status: 200,
            headers: { "Content-Length": String(fixture.bytes.byteLength) },
          }),
          finalUrls.package,
        );
      }
      return new Response(null, { status: 404 });
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Open VSX themes", () => {
  it("searches theme extensions and keeps only verified open-source results", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/-/search?")) {
        return new Response(
          JSON.stringify({
            extensions: [
              { namespace: "demo", name: "theme" },
              { namespace: "icons", name: "theme" },
              { namespace: "oversized", name: "theme" },
              { namespace: "unlicensed", name: "theme" },
              { namespace: "unavailable", name: "theme" },
              { namespace: "closed", name: "theme" },
              { namespace: "unverified", name: "theme" },
              { namespace: "huge", name: "theme" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/icons/theme")) {
        return new Response(
          JSON.stringify(
            extensionDetail({
              namespace: "icons",
              files: {
                ...extensionDetail().files,
                manifest: `${ASSET_ROOT.replace("demo/theme", "icons/theme")}/package.json`,
              },
            }),
          ),
          { status: 200 },
        );
      }
      if (url.endsWith("/oversized/theme")) {
        return new Response(
          JSON.stringify(
            extensionDetail({
              namespace: "oversized",
              files: {
                ...extensionDetail().files,
                download: `${ASSET_ROOT.replace("demo/theme", "oversized/theme")}/oversized.vsix`,
              },
            }),
          ),
          { status: 200 },
        );
      }
      if (url.endsWith("/unlicensed/theme")) {
        return new Response(
          JSON.stringify(
            extensionDetail({
              namespace: "unlicensed",
              files: {
                ...extensionDetail().files,
                manifest: `${ASSET_ROOT.replace("demo/theme", "unlicensed/theme")}/package.json`,
              },
            }),
          ),
          { status: 200 },
        );
      }
      if (url.endsWith("/unavailable/theme")) {
        return new Response(
          JSON.stringify(
            extensionDetail({
              namespace: "unavailable",
              files: {
                ...extensionDetail().files,
                download: `${ASSET_ROOT.replace("demo/theme", "unavailable/theme")}/unavailable.vsix`,
                manifest: `${ASSET_ROOT.replace("demo/theme", "unavailable/theme")}/package.json`,
              },
            }),
          ),
          { status: 200 },
        );
      }
      if (url.endsWith("/closed/theme")) {
        return new Response(
          JSON.stringify(extensionDetail({ namespace: "closed", license: "All Rights Reserved" })),
          { status: 200 },
        );
      }
      if (url.endsWith("/unverified/theme")) {
        return new Response(
          JSON.stringify(extensionDetail({ namespace: "unverified", verified: false })),
          { status: 200 },
        );
      }
      if (url.endsWith("/huge/theme")) {
        return new Response(JSON.stringify({ padding: "x".repeat(256 * 1024) }), { status: 200 });
      }
      if (url.endsWith("/oversized/theme/1.0.0/file/oversized.vsix")) {
        return new Response(null, {
          headers: { "content-length": String(20 * 1024 * 1024 + 1) },
          status: 200,
        });
      }
      if (url.endsWith("/unavailable/theme/1.0.0/file/unavailable.vsix")) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith(".vsix")) {
        return new Response(null, { headers: { "content-length": "1024" }, status: 200 });
      }
      if (url.endsWith("/icons/theme/1.0.0/file/package.json")) {
        return new Response(JSON.stringify({ contributes: { iconThemes: [{}] } }), { status: 200 });
      }
      if (url.endsWith("/unlicensed/theme/1.0.0/file/package.json")) {
        return new Response(
          JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }),
          { status: 200 },
        );
      }
      if (url.endsWith("/unavailable/theme/1.0.0/file/package.json")) {
        return new Response(
          JSON.stringify({ license: "MIT", contributes: { themes: [{ path: "./theme.json" }] } }),
          { status: 200 },
        );
      }
      if (url.endsWith("/demo/theme/1.0.0/file/package.json")) {
        return new Response(
          JSON.stringify({ license: "MIT", contributes: { themes: [{ path: "./theme.json" }] } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(extensionDetail()), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchOpenVsxThemes("  dracula  ");

    expect(results).toEqual([
      expect.objectContaining({
        id: "demo.theme",
        name: "Demo Theme",
        publisher: "demo",
        downloadCount: 123456,
        iconUrl: `${ASSET_ROOT}/icon.png`,
        sourceUrl: "https://github.com/demo/theme",
        license: "MIT",
        publishedBy: "demo-publisher",
        verified: true,
      }),
    ]);
    const searchUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(searchUrl.searchParams.get("query")).toBe("dracula");
    expect(searchUrl.searchParams.get("category")).toBe("Themes");
    expect(searchUrl.searchParams.get("sortBy")).toBe("downloadCount");
    expect(searchUrl.searchParams.get("sortOrder")).toBe("desc");
    expect(searchUrl.searchParams.get("size")).toBe("16");
  });

  it("supports sorting theme searches", async () => {
    const fetchMock = vi.fn(
      async (..._args: unknown[]) =>
        new Response(JSON.stringify({ extensions: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await searchOpenVsxThemes("nord", { sortBy: "rating" });

    const searchUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(searchUrl.searchParams.get("sortBy")).toBe("rating");
    expect(searchUrl.searchParams.get("sortOrder")).toBe("desc");
  });

  it("rejects malformed search responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 200 })),
    );

    await expect(searchOpenVsxThemes("nord")).rejects.toThrow(
      "Open VSX returned an unreadable search response.",
    );
  });

  it("reports an unavailable search when every detail request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/-/search?")) {
          return new Response(
            JSON.stringify({ extensions: [{ namespace: "demo", name: "theme" }] }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 429 });
      }),
    );

    await expect(searchOpenVsxThemes("dracula")).rejects.toThrow(
      "Open VSX theme details are unavailable",
    );
  });

  it("reports an unavailable search when every detail response is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/-/search?")) {
          return new Response(
            JSON.stringify({ extensions: [{ namespace: "demo", name: "theme" }] }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await expect(searchOpenVsxThemes("dracula")).rejects.toThrow(
      "Open VSX theme details are unavailable",
    );
  });

  it("returns no results when every theme package is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/-/search?")) {
          return new Response(
            JSON.stringify({ extensions: [{ namespace: "demo", name: "theme" }] }),
            { status: 200 },
          );
        }
        if (url.endsWith("/demo/theme")) {
          return new Response(JSON.stringify(extensionDetail()), { status: 200 });
        }
        if (init?.method === "HEAD") return new Response(null, { status: 404 });
        return new Response(
          JSON.stringify({ license: "MIT", contributes: { themes: [{ path: "./theme.json" }] } }),
          { status: 200 },
        );
      }),
    );

    await expect(searchOpenVsxThemes("dracula")).resolves.toEqual([]);
  });

  it("times out a stalled search request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      ),
    );

    const search = expect(searchOpenVsxThemes("dracula")).rejects.toThrow(
      "Open VSX took too long to respond",
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await search;
  });

  it("downloads a verified VSIX, reads JSONC includes, and pairs contributed variants", async () => {
    const zip = new JSZip();
    zip.file("extension/.gitkeep", "");
    // Theme extensions sometimes publish their development dependencies too.
    // Those unused files should not prevent importing the small theme payload.
    for (let index = 0; index < 3_000; index += 1) {
      zip.file(`extension/node_modules/package-${index}.js`, "");
    }
    zip.file(
      "extension/themes/base.jsonc",
      `{
        // inherited workbench colors
        "colors": {
          "editor.foreground": "#eeeeee",
          "focusBorder": "#8b5cf6",
        },
      }`,
    );
    zip.file(
      "extension/themes/demo-dark.json",
      `{
        "include": "./base.jsonc",
        "colors": { "editor.background": "#111111" }
      }`,
    );
    zip.file(
      "extension/themes/demo-light.json",
      `{
        "colors": {
          "editor.background": "#fafafa",
          "editor.foreground": "#222222",
          "focusBorder": "#8b5cf6"
        }
      }`,
    );
    zip.file(
      "extension/themes/demo.json",
      `{
        "colors": {
          "editor.background": "#181818",
          "editor.foreground": "#eeeeee"
        }
      }`,
    );
    const packagedManifest = {
      publisher: "demo",
      name: "theme",
      version: "1.0.0",
      license: "MIT",
      contributes: {
        themes: [
          { label: "Demo Dark", uiTheme: "vs-dark", path: "./themes/demo-dark.json" },
          { label: "Demo Light", uiTheme: "vs", path: "./themes/demo-light.json" },
          { label: "Demo", uiTheme: "vs-dark", path: "./themes/demo.json" },
        ],
      },
    };
    let packageBytes = new ArrayBuffer(0);
    let checksum = "";
    const rebuildPackage = async () => {
      zip.file("extension/package.json", JSON.stringify(packagedManifest));
      packageBytes = await zip.generateAsync({
        type: "arraybuffer",
        comment: `PK\u0005\u0006${"x".repeat(26)}`,
      });
      checksum = [...sha256(new Uint8Array(packageBytes))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    };
    await rebuildPackage();
    // The public manifest is only a preflight hint. Imports must use the manifest
    // inside the checksummed VSIX rather than this inconsistent contribution.
    const manifest = {
      contributes: { themes: [{ label: "Wrong", path: "./themes/missing.json" }] },
    };
    const extension = selectedExtension();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://open-vsx.org/api/demo/theme/1.0.0") {
          return new Response(JSON.stringify(extensionDetail()), { status: 200 });
        }
        if (url === extension.manifestUrl) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (url === extension.sha256Url) return new Response(`${checksum}  demo.vsix`);
        return new Response(packageBytes, {
          status: 200,
          headers: { "Content-Length": String(packageBytes.byteLength) },
        });
      }),
    );

    const themes = await importOpenVsxThemeExtension(extension);

    expect(themes).toHaveLength(2);
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(2);
    expect(themes.every((theme) => /^ovx-[a-z0-9-]+-[0-9a-f]{12}$/.test(theme.id))).toBe(true);
    expect(themes.every((theme) => theme.collection?.id === "open-vsx:demo.theme")).toBe(true);
    const paired = themes.find(
      (theme) =>
        getThemeColorsForMode(theme, "light") !== null &&
        getThemeColorsForMode(theme, "dark") !== null,
    )!;
    expect(paired.label).toBe("Demo");
    expect(themeColorToHex(paired.colors.canvas)).toBe("#fafafa");
    expect(themeColorToHex(getThemeColorsForMode(paired, "dark")!.canvas)).toBe("#111111");
    expect(themeColorToHex(getThemeColorsForMode(paired, "dark")!.text)).toBe("#eeeeee");

    packagedManifest.contributes.themes[0]!.label = "Renamed Dark";
    packagedManifest.contributes.themes[1]!.label = "Renamed Light";
    packagedManifest.contributes.themes[2]!.label = "Renamed Solo";
    await rebuildPackage();
    const renamedThemes = await importOpenVsxThemeExtension(extension);
    expect(renamedThemes.map((theme) => theme.id)).toEqual(themes.map((theme) => theme.id));

    packagedManifest.contributes.themes.push({
      label: "Duplicate Demo",
      uiTheme: "vs-dark",
      path: "./themes/demo.json",
    });
    await rebuildPackage();
    const duplicatePathThemes = await importOpenVsxThemeExtension(extension);
    expect(new Set(duplicatePathThemes.map((theme) => theme.id)).size).toBe(
      duplicatePathThemes.length,
    );
    expect(themes.every(({ id }) => duplicatePathThemes.some((theme) => theme.id === id))).toBe(
      true,
    );
    packagedManifest.contributes.themes.pop();

    packagedManifest.contributes.themes[2]!.path = "./themes/missing.json";
    await rebuildPackage();
    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow(
      "could not be imported safely",
    );
    packagedManifest.contributes.themes[2]!.path = "./themes/demo.json";

    packagedManifest.license = "Proprietary";
    await rebuildPackage();
    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow(
      "does not match its advertised license",
    );

    Reflect.deleteProperty(packagedManifest, "license");
    await rebuildPackage();
    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow(
      "does not match its advertised license",
    );
  });

  it("stops import work when the request is cancelled", async () => {
    const packageBytes = new Uint8Array([1, 2, 3]);
    const checksum = [...sha256(packageBytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const controller = new AbortController();
    const extension = selectedExtension();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://open-vsx.org/api/demo/theme/1.0.0") {
          return new Response(JSON.stringify(extensionDetail()), { status: 200 });
        }
        if (url === extension.manifestUrl) {
          return new Response(
            JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }),
          );
        }
        if (url === extension.sha256Url) {
          controller.abort();
          return new Response(checksum);
        }
        return new Response(packageBytes);
      }),
    );

    await expect(importOpenVsxThemeExtension(extension, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects a package whose Open VSX checksum does not match", async () => {
    const extension = selectedExtension();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://open-vsx.org/api/demo/theme/1.0.0") {
          return new Response(JSON.stringify(extensionDetail()), { status: 200 });
        }
        if (url === extension.manifestUrl) {
          return new Response(
            JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }),
          );
        }
        if (url === extension.sha256Url) return new Response("0".repeat(64));
        return new Response(new Uint8Array([1, 2, 3]));
      }),
    );

    await expect(importOpenVsxThemeExtension(extension)).rejects.toThrow("integrity check");
  });

  it("revalidates publisher identity before downloading an extension", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify(extensionDetail({ publishedBy: { loginName: "replacement-publisher" } })),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(importOpenVsxThemeExtension(selectedExtension())).rejects.toThrow(
      "changed publisher identity",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an extension that is no longer verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(extensionDetail({ verified: false })), { status: 200 }),
      ),
    );

    await expect(importOpenVsxThemeExtension(selectedExtension())).rejects.toThrow(
      "no longer published by a verified source",
    );
  });

  it("rejects resources redirected outside official Open VSX origins", async () => {
    const fixture = await buildThemePackage();
    stubThemeImport(fixture, {
      finalUrls: { manifest: "https://packages.example/extension/package.json" },
    });

    await expect(importOpenVsxThemeExtension(selectedExtension())).rejects.toThrow(
      "redirected to an untrusted resource URL",
    );
  });

  it("accepts package redirects to the official Open VSX asset origin", async () => {
    const fixture = await buildThemePackage();
    const cdnRoot = "https://openvsx.eclipsecontent.org/demo/theme/1.0.0";
    stubThemeImport(fixture, {
      finalUrls: {
        manifest: `${cdnRoot}/package.json`,
        package: `${cdnRoot}/demo.theme-1.0.0.vsix`,
        checksum: `${cdnRoot}/demo.theme-1.0.0.sha256`,
      },
    });

    await expect(importOpenVsxThemeExtension(selectedExtension())).resolves.toHaveLength(1);
  });

  it("times out a stalled import request", async () => {
    vi.useFakeTimers();
    const requestSignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) requestSignals.push(init.signal);
        return new Promise<Response>(() => undefined);
      }),
    );

    const importing = expect(importOpenVsxThemeExtension(selectedExtension())).rejects.toThrow(
      "took too long to import",
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await importing;
    expect(requestSignals).toHaveLength(1);
    expect(requestSignals[0]!.aborted).toBe(true);
  });

  it("rejects theme paths that escape the extension package", async () => {
    const fixture = await buildThemePackage({ contributionPath: "../../theme.json" });
    stubThemeImport(fixture);

    await expect(importOpenVsxThemeExtension(selectedExtension())).rejects.toThrow(
      "could not be imported safely",
    );
  });

  it("rejects cyclic theme includes", async () => {
    const fixture = await buildThemePackage({
      contributionPath: "./themes/a.json",
      files: {
        "themes/a.json": JSON.stringify({ include: "./b.json" }),
        "themes/b.json": JSON.stringify({ include: "./a.json" }),
      },
    });
    stubThemeImport(fixture);

    await expect(importOpenVsxThemeExtension(selectedExtension())).rejects.toThrow(
      "could not be imported safely",
    );
  });

  it("rejects oversized theme files", async () => {
    const fixture = await buildThemePackage({
      files: {
        "themes/theme.json": JSON.stringify({
          colors: { "editor.background": "#181818" },
          padding: "x".repeat(256 * 1024),
        }),
      },
    });
    stubThemeImport(fixture);

    await expect(importOpenVsxThemeExtension(selectedExtension())).rejects.toThrow(
      "could not be imported safely",
    );
  });

  it("rejects packages with an unsafe compression ratio", async () => {
    const fixture = await buildThemePackage({
      files: {
        "themes/theme.json": JSON.stringify({ colors: { "editor.background": "#181818" } }),
        "padding.txt": "x".repeat(300_000),
      },
      compression: "DEFLATE",
    });
    stubThemeImport(fixture);

    await expect(importOpenVsxThemeExtension(selectedExtension())).rejects.toThrow(
      "unsafe compression ratio",
    );
  });

  it("rejects packages with too many files", async () => {
    const files = Object.fromEntries([
      ["themes/theme.json", JSON.stringify({ colors: { "editor.background": "#181818" } })],
      ...Array.from({ length: 4_999 }, (_, index) => [`unused/${index}.txt`, ""]),
    ]);
    const fixture = await buildThemePackage({ files });
    stubThemeImport(fixture);

    await expect(importOpenVsxThemeExtension(selectedExtension())).rejects.toThrow(
      "too many files",
    );
  });
});
