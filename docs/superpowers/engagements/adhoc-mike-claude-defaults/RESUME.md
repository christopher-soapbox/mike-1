# Adhoc-Mike-ClaudeDefaults: resume note

**Engine pin:** none -- Mike, not an engine engagement

Stood down by Sophie 2026-10-02 ~21:35 PDT. Nothing of this seat's is open.

## Live state

| Service | Revision | Built from |
|---|---|---|
| mike-backend | mike-backend-00009-9th | mike-1 `main` at 88c89106 (#5). Production now runs `main`, not `feature/chat-external-ref`. |
| mike-integrations | mike-integrations-00020-skm | agent-tooling `main` at b110e127 (#1072) |

Rollbacks: mike-backend-00008-lxl, mike-integrations-00019-884.

Merged and live:
- **mike-1 #3:** Claude defaults (main claude-opus-5-5, tabular claude-sonnet-5-5, title claude-haiku-4-5-20251001). Retired Claude ids map to current ones. An unknown model id gets a 400.
- **mike-1 #4:** `feature/chat-external-ref` synced into `main`; claude-fable-5 maps to claude-fable-5-1.
- **mike-1 #5:** one `[llm/turn]` log line per turn (model, finish reason, tokens; no content). A cut-off empty turn throws `EmptyReplyError`.
- **agent-tooling #1068:** `list_chats`, and a stream failure carries its chatId.
- **agent-tooling #1069:** 330 s client timeout, optional `model` argument, `list_chats` statuses answered / incomplete / failed / awaiting_reply / empty.
- **agent-tooling #1072:** an empty reply is a `MikeChatStreamError` carrying the chatId.

## Open: the 9658bd66 empty reply, cause UNREAD

Chat 9658bd66: `POST /projects/1e52a654.../chat`, 2026-10-03 01:05:03Z, 170.2 s, 200, on mike-backend-00008-lxl. It saved reasoning only, and the client got ok with empty text.
- It ran on the 330 s client. There was no client-abort line and no stream-error line, so it is not the cancellation path.
- The same review later came back readable, so the defect is intermittent.
- 00008 logged no model or finish reason, so the cause was never recorded.
- A watch on 00009 from 01:30Z to 04:30Z saw one turn (a probe) and no long review, so no sample exists.
- Sophie's ruling (2026-10-02 21:33): leave it. The next empty turn surfaces as an error with a chatId.

### On recurrence: what to read

Find that chat's `[llm/turn]` line on the serving revision:

    gcloud logging read 'resource.labels.service_name="mike-backend" AND textPayload:"[llm/turn]"' --project=soapbox-tools --freshness=1d

Readings, pre-registered with the Gate before any data:
- **A, output cap.** The empty turn shows `finishReason` length / max_tokens, and `outputTokens` / `maxOutputTokens` near 1. Judge on that ratio, not on reasoningTokens, which can read 0. Fix: raise `MAX_OUTPUT_TOKENS` (16,384, `backend/src/lib/llm/aiSdk.ts`) for Claude, or lower its reasoning setting ("high").
- **B, step cap.** The empty turn shows `tool-calls` with steps = 10. Fix: raise `stepCountIs(10)`.
- **C, instrument not enough.** The turn shows `stop` with replyChars 0 and output well under the cap. Gate ruling: reproduce with a SYNTHETIC long input, never a client document. If a real turn is unavoidable: one turn, raw logging to a local path that is deleted after reading, never Cloud Logging, and Sophie approves first.
- **D, no `[llm/turn]` line.** The turn threw before the log; read the error line for it.

## Corrections on the record

These were wrong when first stated; the record has been corrected:
- "Mike finished the 173 s review server-side" (b5606fca) was WRONG. A client disconnect cancels the turn (`projectChat.ts` res "close" then abort) and saves a partial. The correction is on agent-tooling #1068 and in #1069's body.
- A scope count of 32 files for the #5 deploy came from a three-dot diff. The real change against the live upload was 4 backend files.
