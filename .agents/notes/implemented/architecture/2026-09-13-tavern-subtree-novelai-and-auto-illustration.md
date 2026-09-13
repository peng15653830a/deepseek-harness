# Agent Note: Tavern subtree with a NovelAI channel and automatic illustration batches

Status: implemented

English | [中文](2026-09-13-tavern-subtree-novelai-and-auto-illustration.zh.md)

## Problem

This repository is the DeepSeek Harness (DSH) source, upgraded continuously; the Tavern experience (character-card roleplay with scene illustrations) lives in a separate project that must run inside it. Two needs could not be met by configuration alone: scene illustrations had to come from a third-party NovelAI relay that speaks the official `/ai/generate-image` protocol, and a roleplay turn had to produce several illustrations on its own instead of one per click. Both had to survive future DSH upgrades without a rewrite, because only the DSH body keeps moving; the Tavern upstream is not re-ported.

## Decision

The Tavern ships as a subtree at `packages/tavern/`: `tavern-plugin/` holds the runtime host as plain JavaScript (`lib/**` plus an assembled `lib/client.js`), `image-gen/` holds the image plugin source whose `src/tavern/` channel layer the host calls in-process, and `presets/` holds the profile composition. The subtree is part of the root pnpm workspace and the Host/Client TypeScript faces; lefthook and the third-party-notice generator exclude it because it is imported source, not harness source.

`dsh-image-gen` gains a NovelAI provider. `image-gen/src/novelai.ts` posts the official V4.x payload (`params_version: 3`, `v4_prompt`/`v4_negative_prompt` captions, 64-pixel-grid sizes) and unpacks the ZIP answer by reading the central directory, so a deferred data descriptor works. Queue-full and rate-limit answers (`503`, `429`) are retried twice with fixed waits under a single `novelaiTimeoutMs` deadline; every other status fails once, and provider response text never reaches an error. The provider registers through the existing seams only: `IMAGE_PROVIDERS`, `Config` fields, `resolveProvider`, the tool branch, the studio profile, and the settings card. `edit_image` refuses NovelAI because the relay rejects `action: img2img`.

The Tavern runtime adds automatic illustration batches. `scene-images/settings.json` gains a Tavern-owned `auto` policy (`enabled`, `minPerTurn`, `charsPerImage`, `maxPerTurn`); the channel configuration and its credential stay module-owned. After a settlement commits, `lib/index.js` calls `sceneIllustrations.autoRun(sessionId, turn)`; the batch serves only the newest settled turn, sizes itself as `clamp(ceil(projected characters / charsPerImage), minPerTurn, maxPerTurn)`, tops up only the missing shots, and serializes batches and image requests. Each shot plans its own moment under a shot-qualified frame key (`profile#shotN`) while tag blocks stay shared, so a later shot submits only what changed. One paid attempt per shot: only a relay rejection before rendering (`503`/`429` on the NovelAI channel) earns one automatic retry, and any other failure keeps the "result unconfirmed, never auto-resend" rule and stops the batch. The client renders every version of a turn as a stacked strip and keeps repaint, adjust, and reference actions on the selected one.

## Alternatives considered

**A standalone plugin or a patch set.** Rejected: the automatic batch must read the chat, the historical snapshot, the attachment service, and the credential store, all of which the harness hands to in-process plugins; "settlement finished" has no public event today, so exposing one would itself be a harness change.

**Automatic batches in the image plugin instead of the Tavern host.** Rejected: the plugin knows providers, not turns, settlements, or the Tavern's chat document, so the policy would have to cross that boundary anyway.

**Storing the auto policy with the channel configuration.** Rejected: `scene-images/settings.json` is the Tavern's document and `providers.json` is the module's; keeping the split lets a host upgrade read either without a migration.

**Retrying every provider failure.** Rejected: a timeout or an unknown 5xx may already be billed, so only a rejection that provably happens before rendering may retry.

## Consequences

Configurations, credentials, and rendered images live in the Tavern data directory, so a DSH or subtree upgrade keeps them; only the harness's own settings surfaces need a re-save after a major API move. The changes are concentrated rather than scattered: three host domain files, six lines in `lib/index.js`, one prompt paragraph, two client files plus the rebuilt `lib/client.js`, the provider registration points, and tests — a re-port replays them instead of re-deriving them. The regression tests (`tests/scene-illustration.test.mjs`, `tests/scene-image-auto.test.mjs`, `image-gen/tests/novelai.spec.ts`) are the acceptance check after any replay. The known cost is that the automatic batch issues several paid requests per turn by design, bounded by `maxPerTurn` and by the single-retry rule; and that the hooks that make the batch run live in the ported tree, so a wholesale re-port of the Tavern upstream would drop them until replayed.
