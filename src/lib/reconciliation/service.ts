/**
 * Reconciliation service — DB I/O wrapper around the pure engine.
 *
 * Loads a user's orders and payments from the database, runs the
 * deterministic engine, then atomically clears and replaces that user's
 * Discrepancy rows (idempotent on re-run).
 */

import prisma from "@/lib/prisma";
import { reconcile } from "./engine";
import type { OrderRecord, PaymentRecord } from "./types";
import { DiscrepancyType, Severity } from "@prisma/client";

export interface ReconciliationSummary {
  /** Total discrepancies written */
  total: number;
  /** Breakdown by type */
  byType: Partial<Record<DiscrepancyType, number>>;
}

export async function runReconciliation(
  userId: string
): Promise<ReconciliationSummary> {
  // ── Load data ──────────────────────────────────────────────────────────────
  const [dbOrders, dbPayments] = await Promise.all([
    prisma.order.findMany({ where: { userId } }),
    prisma.payment.findMany({ where: { userId } }),
  ]);

  // ── Map to pure records ────────────────────────────────────────────────────
  const orders: OrderRecord[] = dbOrders.map((o) => ({
    id: o.id,
    orderId: o.orderId, // already normalised at ingestion time
    currency: o.currency,
    netAmount: o.netAmount,
    status: o.status,   // OrderStatus enum value — "COMPLETED" | "CANCELLED" etc.
  }));

  const payments: PaymentRecord[] = dbPayments.map((p) => ({
    id: p.id,
    transactionRef: p.transactionRef,
    orderReference: p.orderReference, // already normalised
    currency: p.currency,
    amount: p.amount,
    type: p.type,   // "CHARGE" | "REFUND"
    status: p.status, // "SETTLED" | "PENDING" | "FAILED"
  }));

  // ── Run pure engine ────────────────────────────────────────────────────────
  const results = reconcile(orders, payments);

  // ── Atomically clear + replace discrepancies ───────────────────────────────
  // deleteMany + createMany inside a transaction guarantees idempotency:
  // a concurrent re-run cannot observe a half-written state.
  await prisma.$transaction([
    prisma.discrepancy.deleteMany({ where: { userId } }),
    prisma.discrepancy.createMany({
      data: results.map((r) => ({
        userId,
        orderId: r.orderDbId,   // FK to Order.id (UUID PK), null for orphans
        type: r.type as DiscrepancyType,
        severity: r.severity as Severity,
        amountAtRisk: r.amountAtRisk,
        details: r.details as import("@prisma/client/runtime/library").JsonObject,
      })),
    }),
  ]);

  // ── Build summary ──────────────────────────────────────────────────────────
  const byType: Partial<Record<DiscrepancyType, number>> = {};
  for (const r of results) {
    byType[r.type as DiscrepancyType] = (byType[r.type as DiscrepancyType] ?? 0) + 1;
  }

  return { total: results.length, byType };
}
