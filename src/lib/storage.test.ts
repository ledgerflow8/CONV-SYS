import { describe, expect, it } from "vitest";
import { safeFileName } from "./storage";

describe("safeFileName", () => {
  it("keeps a clean name and lowercases the extension", () => {
    expect(safeFileName("My Template (final).PSD")).toBe("My-Template-final.psd");
    expect(safeFileName("pfp_01.jpg")).toBe("pfp_01.jpg");
  });

  it("strips directories and traversal", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\x\\evil.png")).toBe("evil.png");
    expect(safeFileName("....png")).toBe("file.png");
  });

  it("handles accents, emoji and missing extensions", () => {
    expect(safeFileName("Café 🎉.png")).toBe("Cafe.png");
    expect(safeFileName("README")).toBe("README");
    expect(safeFileName("")).toBe("file");
  });
});
