import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

function sseResponse(frames: Array<[string, unknown]>): Response {
  const body = frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const APPROVAL_FRAME: [string, unknown] = [
  "approval-required",
  {
    approvalId: "ap-1",
    action: "delete",
    ticketId: "TA-1",
    serverView: {
      title: "Login returns 500",
      currentStatus: "open",
      diff: null,
      danger: true,
    },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

function callAt(mock: { mock: { calls: unknown[] } }, i: number): [string, RequestInit] {
  return mock.mock.calls[i] as unknown as [string, RequestInit];
}

async function sendMessage(text = "delete TA-1") {
  fireEvent.change(screen.getByTestId("chat-input"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("chat-input").closest("form")!);
}

describe("App approval flow", () => {
  it("blocks further chat until the pending approval is decided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([["tool-call", { toolCallId: "tc-1", toolName: "mutate_ticket", args: { id: "TA-1", action: "delete" } }], APPROVAL_FRAME])),
    );

    render(<App />);
    await sendMessage();

    await screen.findByTestId("approval-modal");
    expect(screen.getByTestId("approval-ticket").textContent).toContain("Login returns 500");
    expect(screen.getByTestId("approval-action").textContent).toBe("delete");
    await waitFor(() => expect(screen.getByTestId("chat-input")).toBeDisabled());
  });

  it("renders the server's facts, not the assistant's claim about them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          ["text-delta", { text: "Just a harmless status tweak, nothing is deleted." }],
          APPROVAL_FRAME,
        ]),
      ),
    );

    render(<App />);
    await sendMessage();

    const modal = await screen.findByTestId("approval-modal");
    expect(modal.textContent).toContain("Confirm deletion");
    expect(modal.textContent).toContain("permanently deleted");
    expect(modal.textContent).not.toContain("harmless");
  });

  it("sends only a decision — never the arguments to execute", async () => {
    const fetchMock = vi.fn(async () => sseResponse([APPROVAL_FRAME]));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await sendMessage();
    await screen.findByTestId("approval-modal");

    fetchMock.mockImplementation(async () => sseResponse([["done", {}]]));
    fireEvent.click(screen.getByText("Delete ticket"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = callAt(fetchMock, 1);
    expect(url).toBe("/approvals/ap-1");
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: expect.any(String), approved: true });
    expect(String(init.body)).not.toContain("TA-1");
  });

  it("closes the modal and re-enables chat after a decision", async () => {
    const fetchMock = vi.fn(async () => sseResponse([APPROVAL_FRAME]));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await sendMessage();
    await screen.findByTestId("approval-modal");

    fetchMock.mockImplementation(async () => sseResponse([["text-delta", { text: "Left it alone." }], ["done", {}]]));
    fireEvent.click(screen.getByText("Decline"));

    await waitFor(() => expect(screen.queryByTestId("approval-modal")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("chat-input")).not.toBeDisabled());
  });

  it("drops the assistant's proposal preamble in favour of the modal", async () => {
    // The model narrates its own proposal in the same step as the tool call. Shown, it
    // sits beside the modal describing the same change in the model's words rather than
    // the server's — and because the modal covers the chat, the user meets it only after
    // deciding, where "pending approval" is already false. The modal is the account of a
    // pending mutation; this bubble is not.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          ["text-delta", { text: "I have proposed deleting ticket TA-1. " }],
          ["text-delta", { text: "This change is currently pending human approval." }],
          ["tool-call", { toolCallId: "tc-1", toolName: "mutate_ticket", args: { id: "TA-1", action: "delete" } }],
          APPROVAL_FRAME,
        ]),
      ),
    );

    render(<App />);
    await sendMessage();
    await screen.findByTestId("approval-modal");

    await waitFor(() =>
      expect(screen.getByTestId("messages").textContent).not.toContain("pending human approval"),
    );
    expect(screen.getByTestId("messages").textContent).toContain("delete TA-1");
  });

  it("drops only the proposing step's text, keeping what an earlier step said", async () => {
    // The cut is one bubble wide, not the whole turn. Text belonging to the step that
    // emitted the mutate call is the preamble and goes; text from a step before it is
    // ordinary conversation and stays. Each tool call opens a new bubble, which is what
    // keeps those two apart — so this is only sound while every step's text lands in its
    // own bubble.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          ["text-delta", { text: "Looking that up." }],
          ["tool-call", { toolCallId: "tc-1", toolName: "search_tickets", args: { query: "login" } }],
          ["tool-result", { toolCallId: "tc-1", result: [{ id: "TA-1" }] }],
          ["text-delta", { text: "I have proposed deleting TA-1, pending human approval." }],
          ["tool-call", { toolCallId: "tc-2", toolName: "mutate_ticket", args: { id: "TA-1", action: "delete" } }],
          APPROVAL_FRAME,
        ]),
      ),
    );

    render(<App />);
    await sendMessage();
    await screen.findByTestId("approval-modal");

    const shown = screen.getByTestId("messages").textContent ?? "";
    expect(shown).toContain("Looking that up.");
    expect(shown).not.toContain("pending human approval");
  });

  it("renders the outcome the resumed turn reports after an approval", async () => {
    // The whole point of the decision: the user is told what happened. The reply arrives
    // on the approval response's stream, in a bubble of its own.
    const fetchMock = vi.fn(async () =>
      sseResponse([
        ["text-delta", { text: "I have proposed deleting ticket TA-1." }],
        ["tool-call", { toolCallId: "tc-1", toolName: "mutate_ticket", args: { id: "TA-1", action: "delete" } }],
        APPROVAL_FRAME,
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await sendMessage();
    await screen.findByTestId("approval-modal");

    fetchMock.mockImplementation(async () =>
      sseResponse([
        ["tool-result", { toolCallId: "tc-1", result: { status: "deleted" } }],
        ["text-delta", { text: "Deleted ticket TA-1." }],
        ["done", {}],
      ]),
    );
    fireEvent.click(screen.getByText("Delete ticket"));

    await waitFor(() =>
      expect(screen.getByTestId("messages").textContent).toContain("Deleted ticket TA-1."),
    );
    expect(screen.getByTestId("messages").textContent).not.toContain("I have proposed");
  });

  it("renders the streamed reply under StrictMode's double invocation", async () => {
    // StrictMode double-invokes state updaters in dev and keeps only the second
    // result. An updater that read a ref a sibling invocation had just written
    // took a different branch the second time round, and the whole streamed reply
    // vanished. The tool call is load-bearing here: it is what advances the
    // segment ref mid-stream.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          ["tool-call", { toolCallId: "tc-1", toolName: "search_tickets", args: { query: "password" } }],
          ["tool-result", { toolCallId: "tc-1", result: [{ id: "TA-2", title: "Password reset fails" }] }],
          ["text-delta", { text: "Ticket TA-2 " }],
          ["text-delta", { text: "is still " }],
          ["text-delta", { text: "open." }],
          ["done", {}],
        ]),
      ),
    );

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await sendMessage("what is open?");

    await waitFor(() =>
      expect(screen.getByTestId("messages").textContent).toContain("Ticket TA-2 is still open."),
    );
  });

  it("aborts the in-flight stream when the tenant changes and renders nothing it emits after", async () => {
    let captured: AbortSignal | null | undefined;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      captured = init.signal;
      // A stream that never ends on its own — the test decides when frames arrive.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await sendMessage("hi");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(captured?.aborted).toBe(false);

    fireEvent.change(screen.getByTestId("tenant-switcher"), { target: { value: "tenant-b" } });
    expect(captured?.aborted).toBe(true);

    // Aborting does not un-decode frames already on the wire. Release some now:
    // they belong to tenant-a's stream and must not surface under tenant-b.
    streamController.enqueue(
      new TextEncoder().encode(
        'event: tool-call\ndata: {"toolCallId":"tc-1","toolName":"search_tickets","args":{}}\n\n' +
          'event: text-delta\ndata: {"text":"tenant-a leftovers"}\n\n',
      ),
    );
    streamController.close();

    await waitFor(() => expect(screen.getByTestId("messages").textContent).toBe(""));
    expect(screen.queryByTestId("tool-trace")).toBeNull();
    expect(screen.queryByTestId("error")).toBeNull();
    // The composer is usable again rather than stuck busy on the retired stream.
    await waitFor(() => expect(screen.getByTestId("chat-input")).not.toBeDisabled());
  });

  it("starts a fresh session and clears state when the tenant changes", async () => {
    const fetchMock = vi.fn(async () => sseResponse([["text-delta", { text: "hello" }], ["done", {}]]));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await sendMessage("hi");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstSession = JSON.parse(String(callAt(fetchMock, 0)[1].body)).sessionId;

    fireEvent.change(screen.getByTestId("tenant-switcher"), { target: { value: "tenant-b" } });
    await waitFor(() => expect(screen.getByTestId("messages").textContent).toBe(""));

    await sendMessage("hi again");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, secondInit] = callAt(fetchMock, 1);
    expect(JSON.parse(String(secondInit.body)).sessionId).not.toBe(firstSession);
    expect((secondInit.headers as Record<string, string>)["X-Tenant-ID"]).toBe("tenant-b");
  });
});
