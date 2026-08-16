import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolTrace } from "./ToolTrace.js";

/**
 * Ground truth for the user, independent of the model's prose. The assistant
 * decides what to say about a description; the trace shows what the tool
 * actually returned. A model that claims text is unavailable while holding all
 * of it — the bug that motivated the `truncated` flag — is contradicted here.
 *
 * Characterization, not red-green: the trace already renders whole results, so
 * these guard that a later switch to a curated field list cannot silently drop
 * the flag.
 */
describe("ToolTrace", () => {
  it("shows the truncated flag for each search hit", () => {
    render(
      <ToolTrace
        entries={[
          {
            kind: "result",
            toolCallId: "c1",
            result: [
              { id: "TA-1", title: "Login returns 500", status: "open", snippet: "x", truncated: false },
              { id: "TA-9", title: "Long one", status: "open", snippet: "y", truncated: true },
            ],
          },
        ]}
      />,
    );

    const trace = screen.getByTestId("tool-trace").textContent ?? "";
    expect(trace).toContain('"truncated": false');
    expect(trace).toContain('"truncated": true');
  });

  it("shows a get_ticket description in full rather than re-clipping it", () => {
    const long = "z".repeat(600);
    render(
      <ToolTrace
        entries={[
          { kind: "call", toolCallId: "c1", toolName: "get_ticket", args: { id: "TA-9" } },
          { kind: "result", toolCallId: "c1", result: { id: "TA-9", description: long } },
        ]}
      />,
    );

    expect(screen.getByTestId("tool-trace").textContent).toContain(long);
  });

  it("renders an injected description as text, never as markup", () => {
    render(
      <ToolTrace
        entries={[
          {
            kind: "result",
            toolCallId: "c1",
            result: { id: "TA-5", description: "<img src=x onerror=alert(1)>" },
          },
        ]}
      />,
    );

    const trace = screen.getByTestId("tool-trace");
    expect(trace.querySelector("img")).toBeNull();
    expect(trace.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
