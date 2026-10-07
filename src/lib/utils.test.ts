import { describe, expect, it } from "vitest";
import { cn } from "./utils";

// Components pass className overrides through cn(); later Tailwind classes must win.
describe("cn", () => {
  it("resolves conflicting Tailwind classes in favour of the last one", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
    expect(cn("bg-primary text-white", "bg-destructive")).toBe("text-white bg-destructive");
  });

  it("drops falsy values and supports conditional objects", () => {
    expect(cn("a", false, null, undefined, { b: true, c: false })).toBe("a b");
  });
});
