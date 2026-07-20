/**
 * Pure types for the reconciliation engine.
 * No Prisma, no I/O — used by both the engine and the service layer.
 */

import { Decimal } from "@prisma/client/runtime/library";

// ─── Enums (mirror Prisma enums, kept local to avoid coupling) ────────────────

export type DiscrepancyType =
  | "MISSING_PAYMENT"
  | "ORPHAN_PAYMENT"
  | "DUPLICATE_CHARGE"
  | "PAYMENT_FAILED"
  | "PAYMENT_PENDING"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "REFUND_STATUS_MISMATCH";

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// ─── Input records ────────────────────────────────────────────────────────────

/**
 * Slimmed order record — only fields needed by the engine.
 * Both id (DB PK) and orderId (normalised business key) are required.
 */
export interface OrderRecord {
  /** DB primary key (UUID) — written as FK on Discrepancy rows */
  id: string;
  /** Normalised business key: trimmed + uppercased */
  orderId: string;
  currency: string;
  netAmount: Decimal;
  /** "COMPLETED" | "CANCELLED" | "REFUNDED" | "PENDING" */
  status: string;
}

/**
 * Slimmed payment record — only fields needed by the engine.
 */
export interface PaymentRecord {
  id: string;
  transactionRef: string;
  /** Normalised: trimmed + uppercased, same space as OrderRecord.orderId */
  orderReference: string;
  currency: string;
  amount: Decimal;
  type: "CHARGE" | "REFUND";
  status: "SETTLED" | "PENDING" | "FAILED";
}

// ─── Output ───────────────────────────────────────────────────────────────────

export interface DiscrepancyResult {
  /** Order.id (UUID PK). null for ORPHAN_PAYMENT (no matching order). */
  orderDbId: string | null;
  type: DiscrepancyType;
  severity: Severity;
  amountAtRisk: Decimal;
  details: Record<string, unknown>;
}
