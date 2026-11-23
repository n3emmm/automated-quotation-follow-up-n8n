# Verification record

Executed on 2026-11-22, Node.js v24.22.3. **20 passed, 0 failed, 0 skipped.** Reproduce from the repository root with `node --test tests/workflow.test.cjs`.

| # | Executed check | Result |
|---|---|---|
| 1 | safe defaults, graph closure and valid expression syntax | Pass |
| 2 | required headers checked before work | Pass |
| 3 | three quotations preserve recipient, draft, row and WA ID across rerun | Pass |
| 4 | sheet outage after successful Gmail create recovers real draft resource ID | Pass |
| 5 | negative lookup after an ambiguous create cannot create again | Pass |
| 6 | pagination prevents creation | Pass |
| 7 | multiple prevents creation | Pass |
| 8 | search outage prevents creation | Pass |
| 9 | legacy exact draft recovers, foreign recipient and similar subject held | Pass |
| 10 | invalid calendar date, duplicate IDs, missing ID, future and terminal rows isolated | Pass |
| 11 | invalid credentials block retries until explicitly requeued | Pass |
| 12 | rate limit retries on later runs and stops at three attempts | Pass |
| 13 | WA response lost or final sheet write fails: no automatic resend | Pass |
| 14 | failed reservation prevents Gmail POST; failed alert claim prevents WA POST | Pass |
| 15 | disabled WhatsApp queues draft and preserves customer fields | Pass |
| 16 | legacy Sent and ambiguous blank alert do not resend; explicit Retry recovers | Pass |
| 17 | summary exposes row-level failures after processing | Pass |
| 18 | approved template uses owner destination and three ordered fields | Pass |
| 19 | date boundary, malformed email and inconsistent draft state | Pass |
| 20 | configuration derives the day in Amman across UTC midnight boundary | Pass |

## Node.js suite boundary

The harness loads the released JSON. It executes the embedded validation, dispatch, transition and summary JavaScript and evaluates the HTTP expressions and switch index in Node. An in-memory sheet and mailbox preserve state across fresh runs. Requests synchronously return synthetic bodies, errors and timeouts. The harness supplies n8n-style item contexts; it does not execute n8n's scheduler, item-link resolver or HTTP nodes. The Amman clock test uses a synthetic instant and an Intl-backed clock adapter.

## Actual n8n engine run

Executed on 2026-11-22 using the official n8nio/n8n:2.20.0 Linux amd64 image filesystem, the native n8n CLI, its JavaScript task runner and a disposable SQLite database. The workstation at localhost:5678 could not be reached from the remote environment. Its build and its imported workflow were not inspected.

The engine suite imported the shipped export unchanged and observed the expected live-access guard. A second import changed only the test workflow ID, the configuration values, and HTTP destinations/authentication. Actual HTTP Request v4.2 nodes called a loopback server. Loop Over Items v3, Switch v3.2, Code v2, MIME generation, expressions, item links and both loop outputs ran inside n8n. After the final corrections, both imports and all five CLI executions produced their expected outcomes.

| Execution | Checks and observed outcomes |
| --- | --- |
| 1. Released configuration | Import succeeded. Manual execution stopped in Configuration with the expected guard message. Zero fixture requests. |
| 2. Three due quotations | Each fake mailbox draft had the correct address and UTF-8 customer name. All three sheet rows acquired their own draft and WhatsApp IDs. Run result reported three processed and zero skipped. |
| 3. Same sheet, fresh run | No further search, create, write or notification requests. |
| 4. Mixed failures and a healthy final row | The eight rows included a Sheets 503 after Gmail create, Meta code 190, HTTP 429, a dropped WhatsApp connection, a lost sheet checkpoint after acceptance, a candidate with a foreign recipient, a dropped Gmail connection after storing its draft, and a healthy final customer. The final customer completed. The workflow then reported the expected batch error. |
| 5. Restart after faults cleared | Both missing draft IDs were recovered through real list/get HTTP nodes without a second create. Only the rate-limited notification retried. The expired token, dropped alert response and lost acceptance checkpoint stayed held. The summary still reported rows needing human review. |

The suite inspected n8n's structured execution records and confirmed coverage of **14 out of 14 enabled nodes**. The fifteenth node was the disabled 09:00 daily trigger. Its type version (1.3) exists in the tested distribution, and its timezone and settings passed static checks. The clock was never activated.

### Defects reproduced and corrected

1. The earlier V2 export lacked a workflow ID. On CLI import the SQLite insertion failed with a NOT NULL constraint on workflow_entity.id. The release includes a public workflow ID and version UUID. Import of the release was re-run successfully.
2. The runner shortened the batch error message at an internal colon, dropping its count and heading from the recorded message. Updated the wording, asserted the expected message in the structured execution error and re-ran the failure/recovery sequence.

### Reproduce

Run `python3 tests/engine.py` with the n8n CLI available. The fixture script validates row state and operation counts against actual requests. Deliberate error executions are expected and verified by the driver. See README.md for prerequisites.

### Outside this verification

The owner's local n8n build, browser UI import on that machine, Google OAuth permissions, actual Gmail indexing, actual Sheets quotas and write responses, approved WhatsApp templates, Meta delivery and wall-clock scheduling were not exercised. The provider fixtures validate client behavior for the modeled responses. The single-writer and stable-row requirements still apply.

Tested workflow SHA-256: `cbb6dde537b116d83587b15c382d2c1dffc4c405166c0f6eb983426f60b968bd`.
