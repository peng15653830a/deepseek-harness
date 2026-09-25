# ST-Prompt-Template upstream baseline

Pinned upstream: https://github.com/zonde306/ST-Prompt-Template/tree/d6f520d149aba146305b0b781ddd691d449c28d2

Manifest version: 1.17.9 (upstream package.json separately reports 1.17).
License: upstream AGPL-3.0; see upstream/LICENSE. Preserve attribution and corresponding source when distributing a derived build.

`upstream/` contains every upstream tracked source/configuration/documentation/test/library file, byte-for-byte. Only the generated `dist/` directory is excluded; it contains the SillyTavern-targeted bundle, source maps, and editor assets, not DSH host adapters. The complete source includes all five entry modules: handler, command, UI, exports, code editor. This directory is NOT yet loaded by DSH.

`upstream-lock.json` records the immutable commit and SHA-256 of every retained file. Host changes belong outside upstream/; a future build should resolve imports through explicit adapters rather than hand-edit upstream sources.

Run from repository root:

```
node tavern-plugin/lib/vendor/st-prompt-template/host-build/audit.mjs
```

Requires the project's Node 22 runtime with stripTypeScriptTypes support. The audit checks inventory and content hashes before parsing TypeScript without executing it. It lists static imports, including imports that upstream did not explicitly label as types. The inventory is deliberately not a compatibility score: globals, dynamic loading, DOM selectors, event ordering, and persistence behavior require separate runtime tests. `runtimeReady` remains false.

See docs/implementation/st-prompt-template-full-port.md for integration and acceptance boundaries.

## Host build and browser verification

The host build now includes all five upstream modules, Faker, xxhash and Monaco with its workers. It resolves SillyTavern imports to `host-build/host.js`; unsupported callback operations throw `PROMPT_TEMPLATE_HOST_UNSUPPORTED`. No host operation is silently acknowledged. The adapter is a per-frame singleton and must never be reused for another session, even after disposal.

Install the exact upstream package-lock in a temporary copy of upstream/ using `npm ci --ignore-scripts --no-audit --no-fund`, then run:

```
node tavern-plugin/lib/vendor/st-prompt-template/host-build/build.mjs /path/to/temporary/upstream /path/to/build-output
node tests/fixtures/full-prompt-template-browser-smoke.mjs /path/to/build-output
```

The build fails on unresolved imports or compiler warnings and checks the dependency lock. Output includes a hash/size manifest and remains marked `hostIntegrated: false`: this build is not automatically registered in production DSH. The browser fixture uses explicit in-memory host callbacks, not a live user's session or persistence. It checks official initialization, settings, commands, variables, nested worldbook evaluation, and the chat-completion event path.

`initializeTemplatePlugin` requires jQuery, lodash, toastr and the Tavern context in its dedicated frame, plus a YAML library, snapshot and named callbacks. It initializes upstream modules once (bypassing only index.ts's jQuery auto-init), exposes the actual official exports, and offers serialized event, command and chat-completion operations. Destroy the owning frame after `dispose` to clear upstream DOM/timer/editor resources. Calls made directly to the official `api` are not serialized by this wrapper.

Remaining production wiring: authoritative snapshot construction, native save transactions, frame ownership/transport, display operations and actual provider-request integration. A successful smoke test does not claim these integrations or complete plugin parity.

## Native state connection

`connectTemplateSession` connects the browser instance to the production `getFullPromptTemplateState`, `saveFullPromptTemplateState`, and `saveFullPromptTemplateSettings` RPCs. Its `rpc` argument must reject DSH responses with `ok: false`, even when HTTP status is 200. Native save receipts advance the version baseline and reconcile in-flight edits. Settings use the real EjsTemplate namespace. Chat variables, message variables, and template processing flags persist in the native journal; global-variable edits and message text rewrites still reject explicitly.

The packaged minified `host-build/artifact` is served by the production route with manifest integrity checking. It includes upstream settings HTML and third-party license notices. The production foreground executor does not yet mount the plugin or route provider requests through it. `hostIntegrated: false` remains deliberate until those paths and display handling are completed.

Run `node tests/fixtures/full-prompt-template-native-browser-smoke.mjs /path/to/artifact` for browser → HTTP → native journal → reopen verification. It creates an isolated temporary profile, without touching a user's existing chat. Its model, macro, regex, and tokenizer services remain deterministic test implementations; it verifies template processing and persistence, not provider HTTP behavior or full regex parity.
