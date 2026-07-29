# Terminal renderers

Terminal sessions remain server-owned PTYs. Clients receive the existing raw byte stream and send
input and resize events over the existing terminal contracts; renderer choices never cross the
wire.

## Ghostty alignment

Android and web use the official `libghostty-vt` C ABI for parsing, terminal state, grapheme
boundaries, keyboard encoding, selection, and scrollback:

- Android links the native shared library and converts render state into a compact JNI snapshot.
- Web loads a separately cached WebAssembly build and reads render state into a Canvas 2D surface.
- Both artifacts are built from the revision in
  `apps/mobile/modules/t3-terminal/Vendor/libghostty-vt/VERSION`.

The platform adapters deliberately own only platform behavior. Android owns its Kotlin Canvas and
touch integration. Web owns browser font shaping, the hidden IME textarea, clipboard and DOM input,
and its Canvas renderer. React does not participate in terminal frames.

The web runtime is singleton-scoped per browser tab so split terminals share one compiled module
and memory. Each visible terminal owns and frees its own terminal, render state, row iterator, cell
iterator, key encoder, and key event handles.

## Updating Ghostty

Update and rebuild Android first, because mobile's `VERSION` file is canonical. Then run:

```sh
pnpm --dir apps/web build:ghostty-wasm
```

Commit the web `wasm`, `VERSION`, and `LICENSE` together. The focused web ABI test verifies that the
pins match, enforces the artifact budget, and exercises repeated create/write/free cycles with
multi-codepoint graphemes.
