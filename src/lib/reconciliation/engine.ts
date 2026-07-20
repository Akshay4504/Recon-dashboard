/**
 * Deterministic reconciliation engine.
 *
 * Pure function — no I/O, no randomness, no LLM.
 * Given a user's orders and payments (already normalised), returns every
 * discrepancy that should be recorded.
 *
 * Classification priority for COMPLETED orders
 * (first match wins; later checks are skipped):
 *   1. MISSING_PAYMENT
 *   2. PAYMENT_FAILED
 *   3. PAYMENT_PENDING
 *   4. DUPLICATE_CHARGE
 *   5. CURRENCY_MISMATCH
 *   6. REFUND_STATUS_MISMATCH
 *   7. AMOUNT_MISMATCH  ← skipped if any above fired
 *   8. CLEAN (no discrepancy emitted)
 */

import { Decimal } from "@prisma/client/runtime/library";
import type {
  DiscrepancyResult,
  DiscrepancyType,
  OrderRecord,
  PaymentRecord,
  Severity,
} from "./types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the tolerance used for both AMOUNT_MISMATCH and ≈-zero checks. */
function epsilon(netAmount: Decimal): number {
  return Math.max(0.05, 0.001 * Math.abs(netAmount.toNumber()));
}

function severityFor(type: DiscrepancyType): Severity {
  switch (type) {
    case "PAYMENT_FAILED":
    case "ORPHAN_PAYMENT":
      return "CRITICAL";
    case "MISSING_PAYMENT":
    case "DUPLICATE_CHARGE":
    case "CURRENCY_MISMATCH":
      return "HIGH";
    case "AMOUNT_MISMATCH":
    case "REFUND_STATUS_MISMATCH":
      return "MEDIUM";
    case "PAYMENT_PENDING":
      return "LOW";
  }
}

function dec(n: number): Decimal {
  // Round to 2dp to avoid floating-point noise in stored values
  return new Decimal(Math.round(n * 100) / 100);
}

// ─── Per-order classifier ─────────────────────────────────────────────────────

/**
 * Classify a single order and its matched payments.
 * Returns one DiscrepancyResult or null (CLEAN / intentionally unflagged).
 */
function classifyOrder(
  order: OrderRecord,
  payments: PaymentRecord[]
): DiscrepancyResult | null {
  const status = order.status.toUpperCase();

  const settledCharges = payments.filter(
    (p) => p.type === "CHARGE" && p.status === "SETTLED"
  );
  const settledRefunds = payments.filter(
    (p) => p.type === "REFUND" && p.status === "SETTLED"
  );
  const pendingPayments = payments.filter((p) => p.status === "PENDING");

  const totalCharges = settledCharges.reduce(
    (s, p) => s + p.amount.toNumber(),
    0
  );
  const totalRefunds = settledRefunds.reduce(
    (s, p) => s + p.amount.toNumber(),
    0
  );
  const netCollected = totalCharges - totalRefunds;
  const netAmount = order.netAmount.toNumber();
  const eps = epsilon(order.netAmount);

  // ── CANCELLED orders ───────────────────────────────────────────────────────
  // Correct state: zero payments. Anomaly: has a settled charge (money collected
  // for an order the customer cancelled).
  if (status === "CANCELLED") {
    if (settledCharges.length > 0) {
      return {
        orderDbId: order.id,
        type: "AMOUNT_MISMATCH",
        severity: "MEDIUM",
        amountAtRisk: dec(netCollected),
        details: {
          reason: "Cancelled order has settled charges",
          netCollected,
          settledChargesCount: settledCharges.length,
        },
      };
    }
    return null; // zero payments on cancelled order is correct
  }

  // ── REFUNDED orders ────────────────────────────────────────────────────────
  // A partial refund is normal. Only flag if netCollected > netAmount.
  if (status === "REFUNDED") {
    if (netCollected > netAmount + eps) {
      return {
        orderDbId: order.id,
        type: "AMOUNT_MISMATCH",
        severity: "MEDIUM",
        amountAtRisk: dec(Math.abs(netCollected - netAmount)),
        details: {
          reason: "Refunded order: netCollected exceeds netAmount",
          netAmount,
          netCollected,
        },
      };
    }
    return null;
  }

  // ── PENDING orders ─────────────────────────────────────────────────────────
  // No expectation yet; never flag.
  if (status === "PENDING") {
    return null;
  }

  // ── Unknown status ─────────────────────────────────────────────────────────
  if (status !== "COMPLETED") {
    return null;
  }

  // ── COMPLETED: ordered checks ──────────────────────────────────────────────

  // 1. MISSING_PAYMENT — zero payments matched at all
  if (payments.length === 0) {
    return {
      orderDbId: order.id,
      type: "MISSING_PAYMENT",
      severity: severityFor("MISSING_PAYMENT"),
      amountAtRisk: order.netAmount,
      details: { reason: "No payments matched for completed order" },
    };
  }

  // 2. PAYMENT_FAILED — every matched payment is FAILED
  if (payments.every((p) => p.status === "FAILED")) {
    return {
      orderDbId: order.id,
      type: "PAYMENT_FAILED",
      severity: severityFor("PAYMENT_FAILED"),
      amountAtRisk: order.netAmount,
      details: {
        reason: "All matched payments have FAILED status",
        failedCount: payments.length,
        transactionRefs: payments.map((p) => p.transactionRef),
      },
    };
  }

  // 3. PAYMENT_PENDING — no settled charge yet, but at least one PENDING
  if (settledCharges.length === 0 && pendingPayments.length > 0) {
    return {
      orderDbId: order.id,
      type: "PAYMENT_PENDING",
      severity: severityFor("PAYMENT_PENDING"),
      amountAtRisk: dec(0),
      details: {
        reason: "No settled charge; pending payment exists",
        pendingCount: pendingPayments.length,
        transactionRefs: pendingPayments.map((p) => p.transactionRef),
      },
    };
  }

  // 4. DUPLICATE_CHARGE — 2+ settled charges not cancelled by refunds
  if (settledCharges.length >= 2) {
    // Sorted descending: first element is the "expected" charge
    const sortedAmounts = settledCharges
      .map((p) => p.amount.toNumber())
      .sort((a, b) => b - a);
    // Extra money = all charges beyond the largest, minus refunds
    const extraAmount =
      sortedAmounts.slice(1).reduce((s, a) => s + a, 0) - totalRefunds;

    if (extraAmount > eps) {
      return {
        orderDbId: order.id,
        type: "DUPLICATE_CHARGE",
        severity: severityFor("DUPLICATE_CHARGE"),
        amountAtRisk: dec(Math.max(0, extraAmount)),
        details: {
          reason: "Multiple settled charges with insufficient offsetting refunds",
          settledChargesCount: settledCharges.length,
          totalCharges,
          totalRefunds,
          extraAmount,
        },
      };
    }
  }

  // 5. CURRENCY_MISMATCH — any settled charge in a different currency
  const mismatchedCharges = settledCharges.filter(
    (p) => p.currency.toUpperCase() !== order.currency.toUpperCase()
  );
  if (mismatchedCharges.length > 0) {
    return {
      orderDbId: order.id,
      type: "CURRENCY_MISMATCH",
      severity: severityFor("CURRENCY_MISMATCH"),
      amountAtRisk: dec(Math.abs(netAmount - netCollected)),
      details: {
        reason: "Settled charge currency does not match order currency",
        orderCurrency: order.currency,
        paymentCurrencies: [
          ...new Set(mismatchedCharges.map((p) => p.currency)),
        ],
        mismatchedCount: mismatchedCharges.length,
      },
    };
  }

  // 6. REFUND_STATUS_MISMATCH — netCollected ≈ 0 but order is COMPLETED
  //    (charges and refunds cancelled out, but the order was never marked refunded)
  if (Math.abs(netCollected) <= eps) {
    return {
      orderDbId: order.id,
      type: "REFUND_STATUS_MISMATCH",
      severity: severityFor("REFUND_STATUS_MISMATCH"),
      amountAtRisk: dec(0),
      details: {
        reason:
          "Net collected is approximately zero but order status is COMPLETED (not REFUNDED/CANCELLED)",
        netCollected,
        netAmount,
        orderStatus: status,
      },
    };
  }

  // 7. AMOUNT_MISMATCH — significant delta between expected and collected
  //    Skipped if any earlier rule fired (guaranteed by the return-first structure).
  const diff = Math.abs(netAmount - netCollected);
  if (diff > eps) {
    return {
      orderDbId: order.id,
      type: "AMOUNT_MISMATCH",
      severity: severityFor("AMOUNT_MISMATCH"),
      amountAtRisk: dec(diff),
      details: {
        reason: "Collected amount differs significantly from order net amount",
        netAmount,
        netCollected,
        difference: diff,
        threshold: eps,
      },
    };
  }

  // 8. CLEAN — no discrepancy
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reconcile a full set of orders against a full set of payments.
 *
 * Assumptions (enforced by the ingestion layer):
 * - order.orderId and payment.orderReference are already normalised
 *   (trimmed, uppercased).
 * - All records belong to the same user (the caller ensures this).
 *
 * @returns Array of discrepancies — empty means everything is clean.
 */
export function reconcile(
  orders: OrderRecord[],
  payments: PaymentRecord[]
): DiscrepancyResult[] {
  const results: DiscrepancyResult[] = [];

  // Build fast lookups
  const orderByRef = new Map<string, OrderRecord>();
  for (const o of orders) {
    orderByRef.set(o.orderId, o);
  }

  const paymentsByRef = new Map<string, PaymentRecord[]>();
  for (const p of payments) {
    const ref = p.orderReference;
    if (!paymentsByRef.has(ref)) paymentsByRef.set(ref, []);
    paymentsByRef.get(ref)!.push(p);
  }

  // ── Orphan payments ────────────────────────────────────────────────────────
  for (const [ref, pmts] of paymentsByRef) {
    if (!orderByRef.has(ref)) {
      for (const p of pmts) {
        results.push({
          orderDbId: null,
          type: "ORPHAN_PAYMENT",
          severity: "CRITICAL",
          amountAtRisk: p.amount,
          details: {
            reason: "Payment order reference matches no known order",
            transactionRef: p.transactionRef,
            orderReference: ref,
            amount: p.amount.toNumber(),
            currency: p.currency,
            status: p.status,
            type: p.type,
          },
        });
      }
    }
  }

  // ── Per-order classification ───────────────────────────────────────────────
  for (const order of orders) {
    const matched = paymentsByRef.get(order.orderId) ?? [];
    const result = classifyOrder(order, matched);
    if (result !== null) {
      results.push(result);
    }
  }

  return results;
}
