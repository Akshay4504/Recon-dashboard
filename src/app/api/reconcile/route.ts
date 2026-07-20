import { NextResponse } from "next/server";
import { auth } from "@/lib/auth-config";
import { runReconciliation } from "@/lib/reconciliation/service";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

function d(v: Prisma.Decimal | null | undefined): string {
  return v?.toFixed(2) ?? "0.00";
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // Run engine
  const summary = await runReconciliation(userId);

  // Return fresh aggregate summary inline so the UI can update in one round-trip
  const [byType, totalInDisputeAgg, atRiskAgg, discrepancyOrderIdRows] =
    await Promise.all([
      prisma.discrepancy.groupBy({
        by: ["type"],
        where: { userId },
        _count: { id: true },
        _sum: { amountAtRisk: true },
        orderBy: { _sum: { amountAtRisk: "desc" } },
      }),
      prisma.discrepancy.aggregate({
        where: { userId },
        _sum: { amountAtRisk: true },
      }),
      prisma.discrepancy.aggregate({
        where: { userId, severity: { in: ["CRITICAL", "HIGH"] } },
        _sum: { amountAtRisk: true },
      }),
      prisma.discrepancy.findMany({
        where: { userId, orderId: { not: null } },
        select: { orderId: true },
      }),
    ]);

  const discrepancyOrderIds = [
    ...new Set(
      discrepancyOrderIdRows
        .map((r) => r.orderId)
        .filter((id): id is string => id !== null)
    ),
  ];

  const reconciledWhere: Prisma.OrderWhereInput = {
    userId,
    status: "COMPLETED",
    ...(discrepancyOrderIds.length > 0 && {
      id: { notIn: discrepancyOrderIds },
    }),
  };

  const [reconciledAgg, totalOrders, totalPayments] = await Promise.all([
    prisma.order.aggregate({ where: reconciledWhere, _sum: { netAmount: true } }),
    prisma.order.count({ where: { userId } }),
    prisma.payment.count({ where: { userId } }),
  ]);

  return NextResponse.json({
    ok: true,
    discrepanciesFound: summary.total,
    summary: {
      totalOrders,
      totalPayments,
      totalValueReconciled: d(reconciledAgg._sum.netAmount),
      totalValueInDispute: d(totalInDisputeAgg._sum.amountAtRisk),
      totalAtRisk: d(atRiskAgg._sum.amountAtRisk),
      byType: byType.map((row) => ({
        type: row.type,
        count: row._count.id,
        amountAtRisk: d(row._sum.amountAtRisk),
      })),
    },
  });
}
