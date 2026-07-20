/**
 * Reconciliation engine — Vitest unit tests.
 *
 * Two suites:
 *  1. Hand-built fixtures covering every individual branch.
 *  2. Fixture-file suite: data matching orders.csv / payments.csv asserting
 *     exact discrepancy counts and two explicit control cases.
 */

import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { reconcile } from "@/lib/reconciliation/engine";
import type { OrderRecord, PaymentRecord, DiscrepancyResult } from "@/lib/reconciliation/types";

// ─── Builders ─────────────────────────────────────────────────────────────────

let _seq = 0;
function uid() {
  return `uuid-${++_seq}`;
}

function order(
  orderId: string,
  status: string,
  currency: string,
  netAmount: string | number,
  id = uid()
): OrderRecord {
  return {
    id,
    orderId,
    currency,
    netAmount: new Decimal(String(netAmount)),
    status,
  };
}

function payment(
  transactionRef: string,
  orderReference: string,
  currency: string,
  amount: string | number,
  type: "CHARGE" | "REFUND",
  status: "SETTLED" | "PENDING" | "FAILED",
  id = uid()
): PaymentRecord {
  return {
    id,
    transactionRef,
    orderReference,
    currency,
    amount: new Decimal(String(amount)),
    type,
    status,
  };
}

function countByType(results: DiscrepancyResult[]) {
  const counts: Record<string, number> = {};
  for (const r of results) {
    counts[r.type] = (counts[r.type] ?? 0) + 1;
  }
  return counts;
}

// ─── Suite 1: Branch-by-branch unit tests ────────────────────────────────────

describe("reconcile — ORPHAN_PAYMENT", () => {
  it("flags a payment whose orderReference matches no order", () => {
    const orders: OrderRecord[] = [];
    const payments = [
      payment("TXN-X1", "ORD-GHOST", "USD", "100", "CHARGE", "SETTLED"),
    ];
    const results = reconcile(orders, payments);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("ORPHAN_PAYMENT");
    expect(results[0].severity).toBe("CRITICAL");
    expect(results[0].orderDbId).toBeNull();
    expect(results[0].amountAtRisk.toNumber()).toBe(100);
  });

  it("emits one ORPHAN_PAYMENT per orphan payment row", () => {
    const orders = [order("ORD-A", "COMPLETED", "USD", 50)];
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "50", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-GHOST-1", "USD", "10", "CHARGE", "SETTLED"),
      payment("TXN-3", "ORD-GHOST-2", "USD", "20", "CHARGE", "SETTLED"),
    ];
    const results = reconcile(orders, payments);
    const orphans = results.filter((r) => r.type === "ORPHAN_PAYMENT");
    expect(orphans).toHaveLength(2);
  });

  it("amountAtRisk equals the full payment amount", () => {
    const payments = [
      payment("TXN-X2", "ORD-NONE", "USD", "250", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([], payments);
    expect(results[0].amountAtRisk.toNumber()).toBe(250);
  });
});

describe("reconcile — MISSING_PAYMENT", () => {
  it("flags a COMPLETED order with zero payments", () => {
    const orders = [order("ORD-A", "COMPLETED", "USD", "100")];
    const results = reconcile(orders, []);
    expect(results[0].type).toBe("MISSING_PAYMENT");
    expect(results[0].severity).toBe("HIGH");
    expect(results[0].amountAtRisk.toNumber()).toBe(100);
  });

  it("does NOT flag a COMPLETED order that has payments", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED")];
    const results = reconcile([o], payments);
    expect(results.find((r) => r.type === "MISSING_PAYMENT")).toBeUndefined();
  });

  it("does NOT flag a PENDING order with zero payments", () => {
    const orders = [order("ORD-A", "PENDING", "USD", "100")];
    const results = reconcile(orders, []);
    expect(results).toHaveLength(0);
  });
});

describe("reconcile — PAYMENT_FAILED", () => {
  it("flags when ALL matched payments are FAILED", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "FAILED"),
      payment("TXN-2", "ORD-A", "USD", "100", "CHARGE", "FAILED"),
    ];
    const results = reconcile([o], payments);
    expect(results[0].type).toBe("PAYMENT_FAILED");
    expect(results[0].severity).toBe("CRITICAL");
    expect(results[0].amountAtRisk.toNumber()).toBe(100);
  });

  it("does NOT flag when at least one payment is SETTLED", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "FAILED"),
      payment("TXN-2", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results.find((r) => r.type === "PAYMENT_FAILED")).toBeUndefined();
  });
});

describe("reconcile — PAYMENT_PENDING", () => {
  it("flags COMPLETED order with no settled charge but a PENDING payment", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "PENDING"),
    ];
    const results = reconcile([o], payments);
    expect(results[0].type).toBe("PAYMENT_PENDING");
    expect(results[0].severity).toBe("LOW");
    expect(results[0].amountAtRisk.toNumber()).toBe(0);
  });

  it("does NOT flag when a settled charge is already present alongside PENDING", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-A", "USD", "100", "CHARGE", "PENDING"),
    ];
    const results = reconcile([o], payments);
    expect(results.find((r) => r.type === "PAYMENT_PENDING")).toBeUndefined();
  });

  it("PAYMENT_PENDING takes priority over AMOUNT_MISMATCH", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "200");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "200", "CHARGE", "PENDING"),
    ];
    const results = reconcile([o], payments);
    expect(results[0].type).toBe("PAYMENT_PENDING");
  });
});

describe("reconcile — DUPLICATE_CHARGE", () => {
  it("flags 2 settled charges with no offsetting refund", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results[0].type).toBe("DUPLICATE_CHARGE");
    expect(results[0].severity).toBe("HIGH");
    // amountAtRisk = the extra charge beyond the first
    expect(results[0].amountAtRisk.toNumber()).toBe(100);
  });

  it("does NOT flag when a refund brings netCollected back to ~one charge value", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
      payment("TXN-3", "ORD-A", "USD", "100", "REFUND", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    // extraAmount = 100 (second charge) - 100 (refund) = 0 → no DUPLICATE_CHARGE
    expect(results.find((r) => r.type === "DUPLICATE_CHARGE")).toBeUndefined();
  });

  it("does NOT flag with only 1 settled charge", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results.find((r) => r.type === "DUPLICATE_CHARGE")).toBeUndefined();
  });

  it("amountAtRisk equals sum of extra charges minus refunds", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-A", "USD", "80", "CHARGE", "SETTLED"), // extra $80
      payment("TXN-3", "ORD-A", "USD", "30", "REFUND", "SETTLED"), // partial refund
    ];
    // sortedAmounts = [100, 80]; extra = 80 - 30 = 50
    const results = reconcile([o], payments);
    expect(results[0].type).toBe("DUPLICATE_CHARGE");
    expect(results[0].amountAtRisk.toNumber()).toBe(50);
  });
});

describe("reconcile — CURRENCY_MISMATCH", () => {
  it("flags a settled charge in a different currency than the order", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "EUR", "95", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results[0].type).toBe("CURRENCY_MISMATCH");
    expect(results[0].severity).toBe("HIGH");
  });

  it("amountAtRisk is the absolute diff between netAmount and netCollected", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "EUR", "95", "CHARGE", "SETTLED"),
    ];
    // netCollected = 95 (EUR treated numerically); diff = |100 - 95| = 5
    const results = reconcile([o], payments);
    expect(results[0].amountAtRisk.toNumber()).toBe(5);
  });

  it("does NOT flag when all settled charges match the order currency", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results.find((r) => r.type === "CURRENCY_MISMATCH")).toBeUndefined();
  });

  it("CURRENCY_MISMATCH takes priority over AMOUNT_MISMATCH", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "EUR", "50", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    // AMOUNT_MISMATCH would fire (diff=50) but CURRENCY_MISMATCH fires first
    expect(results[0].type).toBe("CURRENCY_MISMATCH");
    expect(results.filter((r) => r.type === "AMOUNT_MISMATCH")).toHaveLength(0);
  });
});

describe("reconcile — REFUND_STATUS_MISMATCH", () => {
  it("flags COMPLETED order where netCollected ≈ 0 (charge + equal refund)", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-A", "USD", "100", "REFUND", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results[0].type).toBe("REFUND_STATUS_MISMATCH");
    expect(results[0].severity).toBe("MEDIUM");
    expect(results[0].amountAtRisk.toNumber()).toBe(0);
  });

  it("does NOT flag a REFUNDED order where netCollected ≈ 0", () => {
    const o = order("ORD-A", "REFUNDED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-A", "USD", "100", "REFUND", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results).toHaveLength(0);
  });

  it("does NOT flag when netCollected is significantly non-zero", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results.find((r) => r.type === "REFUND_STATUS_MISMATCH")).toBeUndefined();
  });

  it("REFUND_STATUS_MISMATCH takes priority over AMOUNT_MISMATCH", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-A", "USD", "100", "REFUND", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results[0].type).toBe("REFUND_STATUS_MISMATCH");
    expect(results.filter((r) => r.type === "AMOUNT_MISMATCH")).toHaveLength(0);
  });
});

describe("reconcile — AMOUNT_MISMATCH", () => {
  it("flags when netCollected differs from netAmount beyond threshold", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "85", "CHARGE", "SETTLED"),
    ];
    // diff = |100 - 85| = 15, threshold = max(0.05, 0.1) = 0.1 → flag
    const results = reconcile([o], payments);
    expect(results[0].type).toBe("AMOUNT_MISMATCH");
    expect(results[0].severity).toBe("MEDIUM");
    expect(results[0].amountAtRisk.toNumber()).toBe(15);
  });

  it("does NOT flag when diff is within threshold", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100.05", "CHARGE", "SETTLED"),
    ];
    // diff = 0.05, threshold = 0.1 → no flag
    const results = reconcile([o], payments);
    expect(results.find((r) => r.type === "AMOUNT_MISMATCH")).toBeUndefined();
  });

  it("uses relative threshold for large orders (0.1% of netAmount)", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "10000");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "9995", "CHARGE", "SETTLED"),
    ];
    // threshold = max(0.05, 0.001*10000) = 10; diff = 5 → within threshold
    const results = reconcile([o], payments);
    expect(results.find((r) => r.type === "AMOUNT_MISMATCH")).toBeUndefined();
  });

  it("flags AMOUNT_MISMATCH for large order where diff exceeds 0.1% threshold", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "10000");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "9980", "CHARGE", "SETTLED"),
    ];
    // threshold = 10; diff = 20 → flag
    const results = reconcile([o], payments);
    expect(results[0].type).toBe("AMOUNT_MISMATCH");
    expect(results[0].amountAtRisk.toNumber()).toBe(20);
  });

  it("is NOT emitted when CURRENCY_MISMATCH already fired (priority rule)", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "EUR", "50", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results.some((r) => r.type === "AMOUNT_MISMATCH")).toBe(false);
  });
});

describe("reconcile — CANCELLED orders", () => {
  it("does NOT flag a cancelled order with zero payments", () => {
    const orders = [order("ORD-1701", "CANCELLED", "USD", "100")];
    const results = reconcile(orders, []);
    expect(results).toHaveLength(0);
  });

  it("flags a cancelled order that has a settled charge", () => {
    const o = order("ORD-A", "CANCELLED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results).toHaveLength(1);
    // amountAtRisk = netCollected (the unexpected charge)
    expect(results[0].amountAtRisk.toNumber()).toBeGreaterThan(0);
  });
});

describe("reconcile — REFUNDED orders", () => {
  it("does NOT flag a refunded order with a partial refund (normal case)", () => {
    // ORD-1702 control case: charge $100, refund $50 → netCollected=$50 ≤ netAmount=$100
    const o = order("ORD-1702", "REFUNDED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-1702", "USD", "100", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-1702", "USD", "50", "REFUND", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results).toHaveLength(0);
  });

  it("flags a refunded order where netCollected exceeds netAmount", () => {
    const o = order("ORD-A", "REFUNDED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "150", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-A", "USD", "10", "REFUND", "SETTLED"),
    ];
    // netCollected = 140 > 100 + epsilon → flag
    const results = reconcile([o], payments);
    expect(results).toHaveLength(1);
  });
});

describe("reconcile — CLEAN order", () => {
  it("emits nothing for a completed order with exact matching payment", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
    ];
    const results = reconcile([o], payments);
    expect(results).toHaveLength(0);
  });

  it("emits nothing for a completed order within the tolerance band", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const payments = [
      payment("TXN-1", "ORD-A", "USD", "100.08", "CHARGE", "SETTLED"),
    ];
    // diff = 0.08; threshold = max(0.05, 0.1) = 0.10 → within band
    const results = reconcile([o], payments);
    expect(results).toHaveLength(0);
  });

  it("emits nothing for a PENDING order with zero payments", () => {
    const orders = [order("ORD-A", "PENDING", "USD", "100")];
    expect(reconcile(orders, [])).toHaveLength(0);
  });
});

describe("reconcile — severity mapping", () => {
  const severityCases: [string, Parameters<typeof order>[1], Parameters<typeof payment>[4], Parameters<typeof payment>[5], string][] = [
    ["ORPHAN_PAYMENT → CRITICAL", "COMPLETED", "CHARGE", "SETTLED", "CRITICAL"],
  ];

  it("ORPHAN_PAYMENT has CRITICAL severity", () => {
    const results = reconcile(
      [],
      [payment("TXN-X", "ORD-NONE", "USD", "100", "CHARGE", "SETTLED")]
    );
    expect(results[0].severity).toBe("CRITICAL");
  });

  it("PAYMENT_FAILED has CRITICAL severity", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const results = reconcile(
      [o],
      [payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "FAILED")]
    );
    expect(results[0].severity).toBe("CRITICAL");
  });

  it("MISSING_PAYMENT has HIGH severity", () => {
    const results = reconcile([order("ORD-A", "COMPLETED", "USD", "100")], []);
    expect(results[0].severity).toBe("HIGH");
  });

  it("DUPLICATE_CHARGE has HIGH severity", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const results = reconcile([o], [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
      payment("TXN-2", "ORD-A", "USD", "100", "CHARGE", "SETTLED"),
    ]);
    expect(results[0].severity).toBe("HIGH");
  });

  it("PAYMENT_PENDING has LOW severity", () => {
    const o = order("ORD-A", "COMPLETED", "USD", "100");
    const results = reconcile([o], [
      payment("TXN-1", "ORD-A", "USD", "100", "CHARGE", "PENDING"),
    ]);
    expect(results[0].severity).toBe("LOW");
  });
});

// ─── Suite 2: Fixture-file test ───────────────────────────────────────────────
// Data matches src/__tests__/fixtures/orders.csv and payments.csv.
// Defined directly as TypeScript to keep the engine tests free of I/O.

describe("reconcile — fixture file: exact discrepancy counts", () => {
  function makeOrders(): OrderRecord[] {
    return [
      // 4 × MISSING_PAYMENT (no payments matched)
      order("ORD-1001", "COMPLETED", "USD", "100.00", "DB-1001"),
      order("ORD-1002", "COMPLETED", "USD", "200.00", "DB-1002"),
      order("ORD-1003", "COMPLETED", "USD", "150.00", "DB-1003"),
      order("ORD-1004", "COMPLETED", "USD", "75.00",  "DB-1004"),
      // 1 × PAYMENT_FAILED
      order("ORD-1101", "COMPLETED", "USD", "100.00", "DB-1101"),
      // 1 × PAYMENT_PENDING
      order("ORD-1201", "COMPLETED", "USD", "100.00", "DB-1201"),
      // 2 × DUPLICATE_CHARGE
      order("ORD-1301", "COMPLETED", "USD", "100.00", "DB-1301"),
      order("ORD-1302", "COMPLETED", "USD", "50.00",  "DB-1302"),
      // 1 × CURRENCY_MISMATCH
      order("ORD-1401", "COMPLETED", "USD", "100.00", "DB-1401"),
      // 1 × REFUND_STATUS_MISMATCH
      order("ORD-1501", "COMPLETED", "USD", "100.00", "DB-1501"),
      // Control: CANCELLED — must NOT be flagged (no payments)
      order("ORD-1701", "CANCELLED", "USD", "100.00", "DB-1701"),
      // Control: REFUNDED — must NOT be flagged (partial refund, netCollected ≤ netAmount)
      order("ORD-1702", "REFUNDED",  "USD", "100.00", "DB-1702"),
      // CLEAN completed order
      order("ORD-1801", "COMPLETED", "USD", "100.00", "DB-1801"),
    ];
  }

  function makePayments(): PaymentRecord[] {
    return [
      // ORD-1101 — all FAILED → PAYMENT_FAILED
      payment("TXN-1101-1", "ORD-1101", "USD", "100.00", "CHARGE", "FAILED"),
      // ORD-1201 — PENDING, no settled → PAYMENT_PENDING
      payment("TXN-1201-1", "ORD-1201", "USD", "100.00", "CHARGE", "PENDING"),
      // ORD-1301 — 2 settled charges → DUPLICATE_CHARGE
      payment("TXN-1301-1", "ORD-1301", "USD", "100.00", "CHARGE", "SETTLED"),
      payment("TXN-1301-2", "ORD-1301", "USD", "100.00", "CHARGE", "SETTLED"),
      // ORD-1302 — 2 settled charges → DUPLICATE_CHARGE
      payment("TXN-1302-1", "ORD-1302", "USD", "50.00",  "CHARGE", "SETTLED"),
      payment("TXN-1302-2", "ORD-1302", "USD", "50.00",  "CHARGE", "SETTLED"),
      // ORD-1401 — wrong currency (EUR vs USD) → CURRENCY_MISMATCH
      payment("TXN-1401-1", "ORD-1401", "EUR", "95.00",  "CHARGE", "SETTLED"),
      // ORD-1501 — charge + equal refund, netCollected≈0 → REFUND_STATUS_MISMATCH
      payment("TXN-1501-1", "ORD-1501", "USD", "100.00", "CHARGE", "SETTLED"),
      payment("TXN-1501-2", "ORD-1501", "USD", "100.00", "REFUND", "SETTLED"),
      // ORD-1702 — partial refund (netCollected=$50 ≤ netAmount=$100) → NOT flagged
      payment("TXN-1702-1", "ORD-1702", "USD", "100.00", "CHARGE", "SETTLED"),
      payment("TXN-1702-2", "ORD-1702", "USD", "50.00",  "REFUND", "SETTLED"),
      // ORD-1801 — perfect match → CLEAN
      payment("TXN-1801-1", "ORD-1801", "USD", "100.00", "CHARGE", "SETTLED"),
      // 3 orphan payments → ORPHAN_PAYMENT × 3
      payment("TXN-ORPH-1", "ORD-NONEXISTENT-1", "USD", "100.00", "CHARGE", "SETTLED"),
      payment("TXN-ORPH-2", "ORD-NONEXISTENT-2", "USD", "200.00", "CHARGE", "SETTLED"),
      payment("TXN-ORPH-3", "ORD-NONEXISTENT-3", "USD", "150.00", "CHARGE", "SETTLED"),
    ];
  }

  let results: DiscrepancyResult[];
  let counts: Record<string, number>;

  // Run once, share across tests in this suite
  results = reconcile(makeOrders(), makePayments());
  counts = countByType(results);

  it("produces 4 MISSING_PAYMENT discrepancies", () => {
    expect(counts["MISSING_PAYMENT"]).toBe(4);
  });

  it("produces 3 ORPHAN_PAYMENT discrepancies", () => {
    expect(counts["ORPHAN_PAYMENT"]).toBe(3);
  });

  it("produces 2 DUPLICATE_CHARGE discrepancies", () => {
    expect(counts["DUPLICATE_CHARGE"]).toBe(2);
  });

  it("produces 1 PAYMENT_FAILED discrepancy", () => {
    expect(counts["PAYMENT_FAILED"]).toBe(1);
  });

  it("produces 1 PAYMENT_PENDING discrepancy", () => {
    expect(counts["PAYMENT_PENDING"]).toBe(1);
  });

  it("produces 1 CURRENCY_MISMATCH discrepancy", () => {
    expect(counts["CURRENCY_MISMATCH"]).toBe(1);
  });

  it("produces 1 REFUND_STATUS_MISMATCH discrepancy", () => {
    expect(counts["REFUND_STATUS_MISMATCH"]).toBe(1);
  });

  it("ORD-1701 (cancelled, no payment) is NOT flagged — control case", () => {
    const forOrd1701 = results.filter(
      (r) => r.orderDbId === "DB-1701"
    );
    expect(forOrd1701).toHaveLength(0);
  });

  it("ORD-1702 (refunded, partial refund) is NOT flagged — control case", () => {
    const forOrd1702 = results.filter(
      (r) => r.orderDbId === "DB-1702"
    );
    expect(forOrd1702).toHaveLength(0);
  });

  it("total discrepancy count is exactly 13", () => {
    // 4+3+2+1+1+1+1 = 13
    expect(results).toHaveLength(13);
  });

  it("produces no AMOUNT_MISMATCH (no ambiguous cases in fixture)", () => {
    expect(counts["AMOUNT_MISMATCH"]).toBeUndefined();
  });
});
