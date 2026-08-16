export type ServerView = {
  title: string;
  currentStatus: string;
  diff: string | null;
  danger: boolean;
};

export type ChatEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; result: unknown }
  | {
      type: "approval-required";
      approvalId: string;
      action: string;
      ticketId: string;
      serverView: ServerView;
    }
  | { type: "done" }
  | { type: "error"; message: string };

/** An abort is a deliberate cancel, not a failure — it must never reach the UI as an error. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function readSse(
  res: Response,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    // Checked before every read and before every dispatch: a stream cancelled mid-buffer must
    // not flush the frames it has already decoded into whatever tenant is on screen now.
    if (signal?.aborted) return;
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (isAbort(err)) return;
      throw err;
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      if (signal?.aborted) return;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const type = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
      const data = /^data:\s*(.*)$/m.exec(block)?.[1];
      if (type && data !== undefined) {
        try {
          onEvent({ type, ...JSON.parse(data) } as ChatEvent);
        } catch {
          // A malformed frame is dropped rather than surfaced as content.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

async function post(
  url: string,
  tenantId: string,
  body: unknown,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tenant-ID": tenantId },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbort(err)) return;
    throw err;
  }

  if (!res.ok) {
    if (signal?.aborted) return;
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    onEvent({ type: "error", message: `${res.status} ${detail.error ?? "request_failed"}` });
    return;
  }
  await readSse(res, onEvent, signal);
}

/** The client sends only the session id and the user's text — never history or state. */
export async function postChat(
  tenantId: string,
  sessionId: string,
  text: string,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return post("/chat", tenantId, { sessionId, text }, onEvent, signal);
}

/** Carries a decision and nothing else; the server executes its own frozen args. */
export async function postApproval(
  tenantId: string,
  sessionId: string,
  approvalId: string,
  approved: boolean,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return post(`/approvals/${approvalId}`, tenantId, { sessionId, approved }, onEvent, signal);
}
