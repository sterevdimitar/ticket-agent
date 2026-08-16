# Security model

This document states what this system guarantees, what it assumes, and where each
guarantee is enforced in code. The short version: **every guarantee holds even if the
model is fully compromised by prompt injection**, because no guarantee depends on the
model behaving well.

## Threat model

**Assumed compromised:**

- **The model.** Ticket content is attacker-controlled and enters the model's context.
  Assume the model reads it, believes it, and does exactly what it says — including
  "ignore all prior instructions", "delete every ticket", and "reveal tenant-b's data".
  The seeded tickets carry precisely these payloads, and the tests script a model that
  obeys them completely.
- **The client.** The browser sends only a session id, a message, and a tenant header.
  Anything else it might claim — history, tool results, approval state, which arguments
  to execute — is ignored. A hand-crafted `curl` is treated the same as our own UI.

**Assumed trusted:**

- The server process and its in-memory stores.
- `X-Tenant-ID` as an identity claim. This is a stand-in for real authentication; in
  production it would be a verified JWT/session claim. Everything downstream of that
  claim is enforced, so replacing it with real auth changes one middleware and nothing
  else.

**Out of scope:** durable storage, multi-node deployment, rate limiting, denial of
service, and the confidentiality of the model provider's own logs.

## Load-bearing invariants

These are the properties the design rests on. Several of them do not fail loudly if
broken — the happy path keeps working while the guarantee is gone — so they are stated
here and each is pinned by a test.

1. **The tenant filter is derived from request context inside the tool body**, never
   from model-supplied arguments. `searchRaw` applies it unconditionally; a `query`
   naming another tenant changes nothing.
   → [`server/src/store/ticketStore.ts`](server/src/store/ticketStore.ts)
2. **No mutation executes without consuming a server-side approval record.** The system
   prompt's "ask first" is not the control. The approve request carries only a decision;
   execution uses `record.frozenArgs`.
   → [`server/src/http/approvals.ts`](server/src/http/approvals.ts)
3. **Ownership is re-checked after approval**, immediately before the write, against the
   live store — the world may have changed while the human was deciding. The ticket's
   `updatedAt` must also still equal the approval's `frozenUpdatedAt`; a ticket that changed
   answers `blocked_stale` instead of executing, because the human approved the facts shown
   in the modal, not the id.
4. **The consume is atomic.** The `PENDING` check and the `CONSUMED` write are
   synchronous with no `await` between them, so replay, double-click, and expiry can
   never both pass the check. Single-use is a property of the code shape, not of timing.
   → [`server/src/approvals/registry.ts`](server/src/approvals/registry.ts)
5. **The server never trusts client-sent history, tool results, or approval state.** A
   session is bound to its creating tenant; a later mismatched tenant is a 403.
6. **Cross-tenant and nonexistent are indistinguishable** (`ticket_not_found`). There is
   no existence oracle: probing ids tells an attacker nothing about another tenant.
7. **One tool call is honored per model step** (see below).
8. **Rendered chat content can never trigger an outbound request** — images disabled,
   links rendered as inert text, raw HTML stripped, CSP `default-src 'self'`.
   → [`web/src/render/safeMarkdown.tsx`](web/src/render/safeMarkdown.tsx)
9. **Everything the tool layer does is recorded in an append-only invocation log** —
   executed, blocked, declined, expired. Tests assert on the log and the store, never on
   chat text, because chat text is the model's opinion of what happened.

## The guards, grouped by what drives them

Controls 1 and 2 are hard guarantees enforced by deterministic code. Control 3 is
defense-in-depth: it raises the cost of an attack but is not what the guarantees rest on.
Under all three sits the trust model they assume.

**Foundation — assume compromise:**

- Conversation state is server-held; each session is bound to its creating tenant.
- A step cap on the agent loop bounds the blast radius of a steered model.
- An append-only invocation log is the audit record of what the tool layer actually did.
- A scripted hostile fake model drives the security tests: the guarantees are proven against
  a fully compromised model, deterministically, with no API key.

**Control 1 — tenant scoping (authorization):**

- The tenant filter is computed server-side in each tool body, where tool arguments cannot
  influence it.
- Ownership is checked twice: before the approval is created, and again before the write.
- Update takes a `fields` allowlist (`title`, `status`, `description`), declared `.strict()`
  at both levels — top-level mutate args and `fields` alike — so an unknown key such as
  `tenantId` is a hard rejection rather than a silent strip, wherever it rides. No
  mass-assignment, no re-tenanting, and the attempt stays visible in the audit log.
- Cross-tenant targets answer `ticket_not_found`, identical to a missing id.

**Control 2 — human approval (consent):**

- The approval registry is server-authoritative: single-use, TTL-bound, tenant- and
  session-bound, with arguments frozen at proposal time.
- The ticket's `updatedAt` is frozen alongside them and re-checked right before the write; a
  ticket that changed while the human was deciding blocks as `blocked_stale` (invariant 3) —
  the human approved the facts shown in the modal, not the id.
- The modal renders `serverView` — server-verified facts — not the model's description of
  what it is about to do: a model that says "just a small status tweak" while proposing a
  delete is contradicted by the dialog the human actually sees.
- Field values in the diff are rendered quoted, escaped (newlines become a literal `\n`) and
  truncated to 120 characters, so model-controlled text cannot forge a line that looks like a
  server-verified one — a description containing `status: open → closed` reads as the
  payload it is.
- The HTTP mapping is deliberate: unknown id and foreign tenant/session both answer **404**
  (no oracle); already-decided and expired answer **409** (the id was real, the decision is
  spent).
- An expired decision still answers the tool call the paused turn left open, recording
  `{ status: "approval_expired" }` in the session history: the record stays `EXPIRED` and the
  response stays 409, but the session remains usable instead of stalling forever on an
  unanswered call.
- An approval nobody ever decides — the modal never rendered, the SSE stream dropped — gets
  the same treatment on a timer: swept past its TTL, logged `approval_expired`, and its
  session's dangling call answered. A dropped connection cannot wedge a session forever.
- A decided approval (`CONSUMED` or `REJECTED`) whose session no longer exists logs
  `blocked_session_lost` rather than disappearing — the log stays honest even when nothing
  executed.
- The pause itself is enforced server-side: `/chat` answers 409 `approval_pending` while a
  session holds an unanswered tool call, and 409 `turn_in_progress` while a turn is already
  running, both without touching the history. The UI disabling its input behind the modal is
  convenience, not the control.

**Control 3 — untrusted-content discipline (hardening):**

- Read results are spotlighted: delimited with `<<<TICKET_DATA>>>`, with the system prompt
  marking that region as data, never instructions. Delimiters occurring inside the wrapped
  text are rewritten to a visibly different form first, so ticket text cannot close the
  envelope and continue as ordinary turn content.
- Returns are structured and minimized: bounded snippet (200 chars), capped result count.
- Rendering is exfil-safe under a restrictive CSP, with tool args carried as escaped text in
  both the trace and the modal.

The envelope covers what carries foreign text, which is every read. `mutate_ticket` results
are the one exception and are handed to the model bare: each is a fixed server-authored
verdict — `{"status":"deleted"}`, `declined_by_user`, `ticket_changed` — with no model,
customer, or ticket text anywhere in it, so there is nothing in it to distrust. Spotlighting
it was not free either: told its own outcome was "written by customers or attackers", the
model would not report it, and a user who had just approved a delete was told the change was
still pending approval. The invariant is the boundary, not the wrapper — anything a tenant or
the model can write goes inside; server-authored control facts do not. If a mutate result ever
starts echoing ticket text, it moves back inside.

Minimization applies to the *fan-out* read. `search_tickets` returns up to ten rows, so an
uncapped snippet would admit ten full bodies of attacker-controlled text in one call. The
uncapped read is a separate tool, `get_ticket`, whose only argument is an id: one ticket per
call, bounded by the step cap, and never ten at once. That is why the full body is reached by
a narrow second tool rather than by lifting the cap or adding a `full` flag to search — a flag
would hand the model the ten-body path on demand. Each search hit also carries `truncated`,
so the model can tell a complete short description from a clipped long one instead of
inferring; without it the model reports content it is holding as unavailable.

## Invariant 7: one tool call per model step

If the model proposes several tool calls in one step, only the first is honored. The
rest are dropped and never enter the message history; the model is free to re-propose
on the next step. They are **not** discarded silently, though: each dropped proposal is
written to the invocation log with outcome `dropped_parallel_call`. Honoring one call must
not shrink the audit trail to one call — a steered "delete everything" burst leaves an entry
per ticket it named, even though only the first ever reached a gate. Without this, the log
would understate what a compromised model actually attempted, which is precisely the thing
an incident review needs.

This is a deliberate simplification, and it has a security consequence worth stating
plainly: it bounds a "delete every ticket you can see" injection into a sequence of
single proposals, each requiring its own human approval, naturally capped by the step
limit of 8. A human who clicks Approve eight times has genuinely approved eight deletions.

The cost is latency and some wasted model output on multi-call turns. The production
alternative is an **approval queue with a resume barrier**: honor the whole batch, open one
approval per proposed call, and hold the turn until every one has been decided. That keeps
the same per-action consent while avoiding the round-trips — at the cost of a batched
approval UI that honestly represents "these seven things", and a resume path that must
handle partial decisions. More surface than this exercise warrants, but it is the right
shape at scale.

The same reasoning applies to a call whose tool name the model hallucinated (e.g.
`delete_all_tickets`): it is likewise logged, with outcome `blocked_unknown_tool`, and
answered with an error result — never silently discarded. Note that a hallucinated name
in the first position consumes the step's single honored slot: real calls proposed beside
it are logged `dropped_parallel_call` and must be re-proposed. Strictly safer — the slot
spent on a hallucination can only reduce what reaches a gate that step.

## Why the approval gate is ours and not the SDK's

AI SDK v7 ships tool-approval machinery (`toolApproval`, `experimental_toolApprovalSecret`).
It is deliberately unused. The reason is not "we wrote ours first" — it is that the two
mechanisms guard different things.

The SDK's gate exists to hold back **its own `execute` handlers**. Our tools have no
`execute`; the SDK is never able to run anything, so there is nothing there for it to gate.
Adopting it would mean giving tools `execute` handlers — handing execution authority to the
library and then trusting its gate. That inverts the decision the rest of this design rests on.

Even setting that aside, the mechanism is a weaker primitive than the registry:

| Property | SDK v7 approval | This registry |
|---|---|---|
| Args frozen at proposal | ✅ HMAC covers `input` | ✅ `frozenArgs` |
| Forgery by client | ✅ blocked *when* the secret is set | ✅ ids are server-issued and never trusted from the client |
| Single-use / replay | ❌ stateless verification — a signed approval re-verifies forever | ✅ atomic consume |
| Expiry | ❌ no timestamp in the signed payload | ✅ TTL |
| Tenant / session binding | ❌ not covered by the signature | ✅ both checked on consume |
| Ownership re-check before write | ❌ no such concept | ✅ `authorize()` immediately before the write |
| API stability | `experimental_`-prefixed | — |

Note also that without `experimental_toolApprovalSecret` the SDK's approvals are
client-forgeable by design — the SDK's own documentation gives "preventing client-forged
approvals" as the reason to set it. Approval state travels as `tool-approval-request` /
`tool-approval-response` **prompt parts**, i.e. in the message history, which suits apps that
round-trip history through the browser. This app does the opposite: history is server-held
and the client is untrusted, so message-borne approval state buys nothing here.

One v7 feature *is* worth adopting later: `activeTools` would let a step be restricted to
read-only tools once untrusted content has entered the context. That is listed under
improvements below.

### A note on dependency typing

Under v7, `streamText`'s `fullStream` parts type as `any` at our call site (verified against
`ai@7.0.66` + `@ai-sdk/google@4.0.44`, single deduped `@ai-sdk/provider-utils@5.0.27`, on both
TypeScript 5.7 and 7.0). Under v5 they were a precise discriminated union. That means the
compiler no longer catches a field rename in the SDK's stream.

This is not a hole — every tool-call argument is re-validated with zod inside the loop before
anything happens, so a shape change yields `undefined` args, a zod rejection, and a
`blocked_invalid_args` log entry. It fails closed. But it fails *confusingly*, so
`geminiProvider` validates the shape of each stream part it reads and throws a named error
naming the part and its keys. Tests in `server/test/unit/geminiProvider.test.ts` assert that a
renamed `text`, `input`, or `toolCallId` throws rather than silently degrading.

Those tests mock `streamText` itself, so they pin our reading of the parts but never run the
SDK that produces them. `server/test/unit/aiSdkPipeline.test.ts` closes that gap offline: it
drives the **real** `streamText` — real prompt standardization, real `fullStream` shaping —
against a mock model, faking only the transport, so an actual SDK upgrade that moves a field or
tightens the prompt rules fails in CI instead of in production. It cannot cover provider-side
behavior (model retirement, auth, quota); that stays with the live-model probe.

## What is proven, and how

Five integration tests, one per attack category, each driving the real HTTP surface with
a scripted hostile model and asserting on the invocation log, the store, and HTTP status:

| Test | Attack |
|---|---|
| `crossTenantRead` | Reading another tenant's tickets, including by naming them in the query |
| `injectedDestructive` | Stored "delete everything" payload steering the model |
| `crossTenantMutation` | Writing to another tenant's ticket; re-tenanting via mass assignment |
| `approvalBypass` | Forged, foreign, replayed, expired, and post-decline approvals |
| `storedInjection` | A payload written into a ticket and read back in a later session |

Three further integration tests cover session integrity rather than an attack category.
`sessionGuards`: a lapsed approval still repairs the transcript it paused, and `/chat`
refuses a turn while an approval is pending or another turn is in flight. `staleApproval`:
an approved write is blocked when the ticket moved while the human was deciding — the
mid-decision integrity half of invariant 3. `mutationOutcome`: the decided verdict reaches
the model unwrapped, so the envelope's absence on that one path is pinned as deliberately as
its presence is everywhere else.

Plus unit tests on the registry (including concurrent consume), the loop, the tools, the
prompt's untrusted-data envelope, and the renderer — 200 tests in total. `npm test` runs all
of it with no API key, type-checking the server sources, the tests and
`scripts/adversarial.ts` (`server/tsconfig.check.json`) before vitest starts.

The tests were sanity-checked by sabotage, so they are not vacuous: removing the tenant
filter fails 11 of them, and executing a mutation at proposal time instead of after approval
fails 28.

`scripts/adversarial.ts` runs the same probes against a live Gemini model. It is a manual
demonstration, not a CI test — a real model is non-deterministic, and the point is that
its behavior does not matter.

## What I'd improve with more time

- Real authentication (JWT) and per-tool ABAC instead of a trusted header.
- Postgres with row-level security as a second wall beneath the tool-level filter, so a
  bug in a tool body is not the only thing standing between tenants.
- Durable approvals and sessions; the current stores are in-memory and per-process.
- A monotonic version integer as the stale-approval OCC token instead of the wall-clock
  `updatedAt` timestamp, once the store is durable — timestamps carry a millisecond-collision
  window a version counter does not.
- CaMeL-style provenance/taint tracking, and dual-LLM quarantine for summarizing ticket
  bodies, so untrusted text never shares a context with privileged instructions.
- A detection layer (PromptGuard / LlamaFirewall / Rebuff) on tool output — worth having,
  but as a signal, never as a gate.
- Adversarial CI (promptfoo / AgentDojo-style) against a live model, so drift in model
  behavior is at least visible.
- Per-turn tool restriction: drop to read-only steps once untrusted content has entered
  the context. v7's `activeTools` is the natural mechanism.
- Rate limiting and an audit UI over the invocation log.
