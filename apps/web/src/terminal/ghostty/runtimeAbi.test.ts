import { describe, expect, it } from "vite-plus/test";

import wasmDataUrl from "./vendor/ghostty-vt.wasm?inline";
import writePtyWasmDataUrl from "./vendor/ghostty-write-pty.wasm?inline";
import webVersion from "./vendor/VERSION?raw";
import mobileVersion from "../../../../mobile/modules/t3-terminal/Vendor/libghostty-vt/VERSION?raw";

type WasmFunction = (...args: number[]) => number;

function decodeWasmDataUrl(dataUrl: string): Uint8Array {
  const encoded = dataUrl.split(",", 2)[1];
  if (!encoded) throw new Error("The vendored Ghostty WASM data URL is invalid");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

describe("vendored libghostty-vt WebAssembly", () => {
  it("stays pinned to mobile's canonical revision and size budget", () => {
    const wasm = decodeWasmDataUrl(wasmDataUrl);
    expect(webVersion.trim()).toBe(mobileVersion.trim());
    expect(wasm.byteLength).toBeLessThan(750_000);
  });

  it("creates, writes multi-codepoint graphemes, and frees repeated terminals", async () => {
    const bytes = decodeWasmDataUrl(wasmDataUrl);
    let memory: WebAssembly.Memory | null = null;
    const instantiated = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer, {
      env: {
        log: () => {},
      },
    });
    const instance =
      instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
    const exports = instance.exports;
    memory = exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) => (exports[name] as WasmFunction)(...args);
    const jsonPointer = call("ghostty_type_json");
    const jsonBytes = new Uint8Array(memory.buffer, jsonPointer);
    const jsonEnd = jsonBytes.indexOf(0);
    const layouts = JSON.parse(new TextDecoder().decode(jsonBytes.subarray(0, jsonEnd))) as Record<
      string,
      { size: number }
    >;
    const optionsSize = layouts.GhosttyTerminalOptions?.size;
    expect(optionsSize).toBe(8);
    if (optionsSize === undefined) throw new Error("GhosttyTerminalOptions layout is missing");

    for (let iteration = 0; iteration < 25; iteration += 1) {
      const options = call("ghostty_wasm_alloc_u8_array", optionsSize);
      const optionsView = new DataView(memory.buffer, options, optionsSize);
      optionsView.setUint16(0, 80, true);
      optionsView.setUint16(2, 24, true);
      optionsView.setUint32(4, 5_000, true);
      const terminalSlot = call("ghostty_wasm_alloc_opaque");
      expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
      const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);

      const input = new TextEncoder().encode("e\u0301 👨‍👩‍👧‍👦 العربية\r\n");
      const inputPointer = call("ghostty_wasm_alloc_u8_array", input.length);
      new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
      call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);
      call("ghostty_wasm_free_u8_array", inputPointer, input.length);
      call("ghostty_terminal_free", terminal);
      call("ghostty_wasm_free_opaque", terminalSlot);
      call("ghostty_wasm_free_u8_array", options, optionsSize);
    }
  });

  it("routes terminal-generated replies through the shared callback table", async () => {
    const mainResult = await WebAssembly.instantiate(
      decodeWasmDataUrl(wasmDataUrl).buffer as ArrayBuffer,
      { env: { log: () => {} } },
    );
    const main = mainResult instanceof WebAssembly.Instance ? mainResult : mainResult.instance;
    const memory = main.exports.memory as WebAssembly.Memory;
    let reply = "";
    const trampolineResult = await WebAssembly.instantiate(
      decodeWasmDataUrl(writePtyWasmDataUrl).buffer as ArrayBuffer,
      {
        env: {
          t3_write_pty: (_terminal: number, _userdata: number, pointer: number, length: number) => {
            reply += new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length));
          },
        },
      },
    );
    const trampoline =
      trampolineResult instanceof WebAssembly.Instance
        ? trampolineResult
        : trampolineResult.instance;
    const table = main.exports.__indirect_function_table as WebAssembly.Table;
    const callbackIndex = table.length;
    table.grow(1, trampoline.exports.ghostty_write_pty as CallableFunction);
    const call = (name: string, ...args: number[]) => (main.exports[name] as WasmFunction)(...args);
    const options = call("ghostty_wasm_alloc_u8_array", 8);
    const optionsView = new DataView(memory.buffer, options, 8);
    optionsView.setUint16(0, 80, true);
    optionsView.setUint16(2, 24, true);
    const terminalSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
    const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);
    call("ghostty_terminal_set", terminal, 0, 1);
    call("ghostty_terminal_set", terminal, 1, callbackIndex);
    const query = new TextEncoder().encode("\u001b[5n");
    const queryPointer = call("ghostty_wasm_alloc_u8_array", query.length);
    new Uint8Array(memory.buffer, queryPointer, query.length).set(query);
    call("ghostty_terminal_vt_write", terminal, queryPointer, query.length);

    expect(reply).toBe("\u001b[0n");
    call("ghostty_wasm_free_u8_array", queryPointer, query.length);
    call("ghostty_terminal_free", terminal);
    call("ghostty_wasm_free_opaque", terminalSlot);
    call("ghostty_wasm_free_u8_array", options, 8);
  });

  it("formats the active selection with Ghostty's copy semantics", async () => {
    const result = await WebAssembly.instantiate(
      decodeWasmDataUrl(wasmDataUrl).buffer as ArrayBuffer,
      { env: { log: () => {} } },
    );
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) =>
      (instance.exports[name] as WasmFunction)(...args);
    const options = call("ghostty_wasm_alloc_u8_array", 8);
    const optionsView = new DataView(memory.buffer, options, 8);
    optionsView.setUint16(0, 80, true);
    optionsView.setUint16(2, 24, true);
    const terminalSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
    const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);
    const input = new TextEncoder().encode("a\r\n\r\nb");
    const inputPointer = call("ghostty_wasm_alloc_u8_array", input.length);
    new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
    call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);

    const selection = call("ghostty_wasm_alloc_u8_array", 32);
    new DataView(memory.buffer, selection, 32).setUint32(0, 32, true);
    expect(call("ghostty_terminal_select_all", terminal, selection)).toBe(0);
    expect(call("ghostty_terminal_set", terminal, 21, selection)).toBe(0);
    const formatOptions = call("ghostty_wasm_alloc_u8_array", 16);
    const formatView = new DataView(memory.buffer, formatOptions, 16);
    formatView.setUint32(0, 16, true);
    formatView.setUint8(8, 1);
    formatView.setUint8(9, 1);
    const written = call("ghostty_wasm_alloc_usize");
    expect(
      call("ghostty_terminal_selection_format_buf", terminal, formatOptions, 0, 0, written),
    ).toBe(-3);
    const outputSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const output = call("ghostty_wasm_alloc_u8_array", outputSize);
    expect(
      call(
        "ghostty_terminal_selection_format_buf",
        terminal,
        formatOptions,
        output,
        outputSize,
        written,
      ),
    ).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, output, outputSize))).toBe(
      "a\n\nb",
    );

    call("ghostty_wasm_free_u8_array", output, outputSize);
    call("ghostty_wasm_free_usize", written);
    call("ghostty_wasm_free_u8_array", formatOptions, 16);
    call("ghostty_wasm_free_u8_array", selection, 32);
    call("ghostty_wasm_free_u8_array", inputPointer, input.length);
    call("ghostty_terminal_free", terminal);
    call("ghostty_wasm_free_opaque", terminalSlot);
    call("ghostty_wasm_free_u8_array", options, 8);
  });
});
