import { useCallback, useRef, useState } from "react";
import type { ChatEvent } from "./api/streamClient.js";
import { postApproval, postChat } from "./api/streamClient.js";
import { ApprovalModal } from "./components/ApprovalModal.js";
import type { PendingApproval } from "./components/ApprovalModal.js";
import { ChatPane } from "./components/ChatPane.js";
import type { ChatMessage } from "./components/ChatPane.js";
import { TenantSwitcher } from "./components/TenantSwitcher.js";
import type { TenantId } from "./components/TenantSwitcher.js";
import { ToolTrace } from "./components/ToolTrace.js";
import type { TraceEntry } from "./components/ToolTrace.js";

function newSessionId(): string {
  return crypto.randomUUID();
}

/** Whatever the transport threw, the banner has to say something a person can read. */
function reason(err: unknown): string {
  const detail = err instanceof Error ? err.message.trim() : "";
  return detail === "" ? "the connection failed" : detail;
}

export function App() {
  const [tenantId, setTenantId] = useState<TenantId>("tenant-a");
  const [sessionId, setSessionId] = useState<string>(newSessionId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which assistant bubble the deltas are currently filling. Bumped per tool call so the reply
  // resumes in a fresh bubble after each one; the stream generation covers the per-stream split.
  const segment = useRef(0);

  // One stream is live at a time. The controller cancels the transport; the generation counter is
  // the belt to its braces, because aborting does not un-decode frames that already left the wire
  // — anything from a superseded stream must not render under the tenant now on screen.
  const abortRef = useRef<AbortController | null>(null);
  const generation = useRef(0);

  // State updaters must be pure: StrictMode double-invokes them in dev and keeps only the second
  // result. An updater that read a ref a sibling invocation had just written would take a
  // different branch the second time round — that is how the whole streamed reply once vanished.
  // So refs are read and advanced out here in the handler, which runs exactly once per event, and
  // the updater only compares the identity it was handed against what is already on screen.
  const handleEvent = useCallback((e: ChatEvent) => {
    switch (e.type) {
      case "text-delta": {
        const bubble = `${generation.current}:${segment.current}`;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.bubble === bubble) {
            return [...prev.slice(0, -1), { ...last, text: last.text + e.text }];
          }
          return [...prev, { role: "assistant", text: e.text, bubble }];
        });
        break;
      }
      case "tool-call":
        segment.current += 1;
        setTrace((prev) => [
          ...prev,
          { kind: "call", toolCallId: e.toolCallId, toolName: e.toolName, args: e.args },
        ]);
        break;
      case "tool-result":
        setTrace((prev) => [
          ...prev,
          { kind: "result", toolCallId: e.toolCallId, result: e.result },
        ]);
        break;
      case "approval-required": {
        // The model's prose about its own proposal is dropped rather than shown. The modal is
        // rendered from server-verified facts and is the only thing that should describe a
        // pending mutation; leaving the preamble beside it puts the model's account of the
        // change next to the server's, which is exactly the substitution the modal exists to
        // prevent. It also read as stale — the modal covers the chat, so the user met that
        // bubble only after deciding, where it claims a decision is still pending. The text
        // stays in server-held history; only the chat drops it.
        //
        // `tool-call` already advanced the segment, so the bubble the deltas were filling is
        // the one before it. Read out here, not inside the updater — see the note above.
        const preamble = `${generation.current}:${segment.current - 1}`;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "assistant" && last.bubble === preamble ? prev.slice(0, -1) : prev;
        });
        setPending({
          approvalId: e.approvalId,
          action: e.action,
          ticketId: e.ticketId,
          serverView: e.serverView,
        });
        break;
      }
      case "error":
        setError(e.message);
        break;
      case "done":
        break;
    }
  }, []);

  /** Cancels whatever is still streaming and opens a generation only this caller answers to. */
  function beginStream(): { signal: AbortSignal; onEvent: (e: ChatEvent) => void; live: () => boolean } {
    endStream();
    segment.current = 0;
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = generation.current;
    const live = () => gen === generation.current;
    return {
      signal: controller.signal,
      onEvent: (e) => {
        if (live()) handleEvent(e);
      },
      live,
    };
  }

  /** Retires the active stream: nothing it still emits belongs to the UI from here on. */
  function endStream() {
    abortRef.current?.abort();
    abortRef.current = null;
    generation.current += 1;
  }

  async function send(text: string) {
    setError(null);
    setMessages((prev) => [...prev, { role: "user", text }]);
    setBusy(true);
    const { signal, onEvent, live } = beginStream();
    try {
      await postChat(tenantId, sessionId, text, onEvent, signal);
    } catch (err) {
      // Only an HTTP response becomes an error event; a dead socket rejects instead, and with no
      // catch it used to vanish as an unhandled rejection under a reply that never arrived.
      // A deliberate abort never lands here — streamClient resolves silently on one — and the
      // live() guard keeps a superseded stream from banner-bombing the tenant now on screen.
      if (live()) setError(`Could not send your message: ${reason(err)}.`);
    } finally {
      if (live()) setBusy(false);
    }
  }

  async function decide(approved: boolean) {
    if (!pending) return;
    // Held across the request so a transport failure can put the modal back. Why: the approval may
    // still be PENDING on the server, or may have executed — the user must never be left guessing
    // whether their decision ran, with no way to retry. If it did land, the retry's 409 arrives as
    // an ordinary error event, which is the honest answer.
    const attempted = pending;
    setBusy(true);
    setPending(null);
    const { signal, onEvent, live } = beginStream();
    try {
      await postApproval(tenantId, sessionId, attempted.approvalId, approved, onEvent, signal);
    } catch (err) {
      if (live()) {
        setError(`Could not send your decision: ${reason(err)}. It may not have been recorded — try again.`);
        setPending(attempted);
      }
    } finally {
      if (live()) setBusy(false);
    }
  }

  /** A session never crosses tenants — switching tenant starts a fresh one. */
  function switchTenant(next: TenantId) {
    endStream();
    setBusy(false);
    setTenantId(next);
    setSessionId(newSessionId());
    setMessages([]);
    setTrace([]);
    setPending(null);
    setError(null);
  }

  return (
    <main className="app">
      <header>
        <h1>Ticket agent</h1>
        <TenantSwitcher tenantId={tenantId} onChange={switchTenant} />
      </header>
      {error && (
        <p className="error" role="alert" data-testid="error">
          {error}
        </p>
      )}
      <div className="columns">
        <ChatPane messages={messages} busy={busy} blocked={pending !== null} onSend={send} />
        <ToolTrace entries={trace} />
      </div>
      {pending && <ApprovalModal pending={pending} busy={busy} onDecide={decide} />}
    </main>
  );
}
