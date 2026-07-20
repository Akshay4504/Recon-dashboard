import { describe, it, expect } from "vitest";
import { parseOrderDate, parseProcessedAt } from "@/lib/date-parse";

describe("parseOrderDate (YYYY-MM-DD HH:MM:SS)", () => {
  it("parses a valid date string", () => {
    const d = parseOrderDate("2024-03-15 09:30:00");
    expect(d.toISOString()).toBe("2024-03-15T09:30:00.000Z");
  });

  it("parses a date with fractional seconds", () => {
    const d = parseOrderDate("2024-03-15 09:30:00.123");
    expect(d.getUTCFullYear()).toBe(2024);
  });

  it("throws on empty string", () => {
    expect(() => parseOrderDate("")).toThrow("order_date is required");
  });

  it("throws on wrong format", () => {
    expect(() => parseOrderDate("15/03/2024 09:30")).toThrow(
      "does not match expected format YYYY-MM-DD HH:MM:SS"
    );
  });

  it("throws on null", () => {
    expect(() => parseOrderDate(null)).toThrow("order_date is required");
  });
});

describe("parseProcessedAt (DD/MM/YYYY HH:MM)", () => {
  it("parses a valid date string", () => {
    const d = parseProcessedAt("15/03/2024 14:05");
    expect(d!.toISOString()).toBe("2024-03-15T14:05:00.000Z");
  });

  it("returns null for empty string", () => {
    expect(parseProcessedAt("")).toBeNull();
  });

  it("returns null for null", () => {
    expect(parseProcessedAt(null)).toBeNull();
  });

  it("throws on wrong format", () => {
    expect(() => parseProcessedAt("2024-03-15 14:05")).toThrow(
      "does not match expected format DD/MM/YYYY HH:MM"
    );
  });

  it("throws on invalid date components", () => {
    // month 99 is out of range [1..12]
    expect(() => parseProcessedAt("15/99/2024 14:05")).toThrow(
      "has invalid month"
    );
  });
});
