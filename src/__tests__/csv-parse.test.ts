import { describe, it, expect } from "vitest";
import { validateHeaders, normaliseRef, dedupeRows, parseDecimal } from "@/lib/csv-parse";

describe("validateHeaders", () => {
  it("returns null when headers match exactly", () => {
    expect(validateHeaders(["a", "b", "c"], ["a", "b", "c"])).toBeNull();
  });

  it("returns error for missing columns", () => {
    const msg = validateHeaders(["a"], ["a", "b"]);
    expect(msg).toMatch(/Missing required columns/);
    expect(msg).toMatch(/b/);
  });

  it("returns error for unexpected extra columns", () => {
    const msg = validateHeaders(["a", "b", "extra"], ["a", "b"]);
    expect(msg).toMatch(/Unexpected columns/);
    expect(msg).toMatch(/extra/);
  });
});

describe("normaliseRef", () => {
  it("trims and uppercases", () => {
    expect(normaliseRef("  ord-001  ", "order_id")).toBe("ORD-001");
  });

  it("throws on empty", () => {
    expect(() => normaliseRef("", "order_id")).toThrow(
      'Field "order_id" is required'
    );
  });

  it("throws on null", () => {
    expect(() => normaliseRef(null, "order_id")).toThrow(
      'Field "order_id" is required'
    );
  });
});

describe("dedupeRows", () => {
  it("removes exact duplicates", () => {
    const rows = [
      { id: "1", val: "a" },
      { id: "1", val: "a" },
      { id: "2", val: "b" },
    ];
    const { rows: out, removed } = dedupeRows(rows);
    expect(out).toHaveLength(2);
    expect(removed).toBe(1);
  });

  it("keeps rows with same id but different values", () => {
    const rows = [
      { id: "1", val: "a" },
      { id: "1", val: "b" }, // different val — not a duplicate
    ];
    const { rows: out, removed } = dedupeRows(rows);
    expect(out).toHaveLength(2);
    expect(removed).toBe(0);
  });

  it("returns all rows if no duplicates", () => {
    const rows = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const { rows: out, removed } = dedupeRows(rows);
    expect(out).toHaveLength(3);
    expect(removed).toBe(0);
  });
});

describe("parseDecimal", () => {
  it("parses a plain number", () => {
    const d = parseDecimal("123.45", "amount");
    expect(d?.toFixed(2)).toBe("123.45");
  });

  it("parses a number with comma thousands separator", () => {
    const d = parseDecimal("1,234.56", "amount");
    expect(d?.toFixed(2)).toBe("1234.56");
  });

  it("parses negative numbers", () => {
    const d = parseDecimal("-50.00", "fee");
    expect(d?.toFixed(2)).toBe("-50.00");
  });

  it("throws on non-numeric value", () => {
    expect(() => parseDecimal("abc", "amount")).toThrow(
      '"amount" value "abc" is not a valid number'
    );
  });

  it("returns null for empty string when nullable=true", () => {
    expect(parseDecimal("", "discount", true)).toBeNull();
  });

  it("throws for empty string when not nullable", () => {
    expect(() => parseDecimal("", "amount")).toThrow(
      '"amount" is required'
    );
  });
});
