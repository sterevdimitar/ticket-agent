import { describe, expect, it } from "vitest";
import { parseModelProvider } from "../../src/config.js";

describe("parseModelProvider", () => {
  it("defaults to the scripted model when unset", () => {
    expect(parseModelProvider(undefined)).toBe("fake");
    expect(parseModelProvider("")).toBe("fake");
  });

  it("accepts the two supported providers", () => {
    expect(parseModelProvider("gemini")).toBe("gemini");
    expect(parseModelProvider("fake")).toBe("fake");
  });

  it("tolerates casing and surrounding whitespace", () => {
    expect(parseModelProvider("Gemini")).toBe("gemini");
    expect(parseModelProvider("GEMINI")).toBe("gemini");
    expect(parseModelProvider("  gemini  ")).toBe("gemini");
    expect(parseModelProvider("\tFake\n")).toBe("fake");
  });

  it("rejects a typo loudly instead of silently falling back to fake", () => {
    expect(() => parseModelProvider("gemeni")).toThrow(/Invalid MODEL_PROVIDER/);
    expect(() => parseModelProvider("openai")).toThrow(/Invalid MODEL_PROVIDER/);
  });

  it("names the offending value so the error is actionable", () => {
    expect(() => parseModelProvider("gemeni")).toThrow(/"gemeni"/);
    expect(() => parseModelProvider("gemeni")).toThrow(/gemini.*fake|fake.*gemini/);
  });
});
