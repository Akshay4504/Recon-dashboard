import { NextResponse } from "next/server";
import { auth } from "@/lib/auth-config";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

function d(v: Prisma.Decimal | null | undefined): string {
  return v?.toFixed(2) ?? "0.00";
}

export async function GET() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const userId = session.user.id;

    // Execute queries sequentially
    const totalOrders = await prisma.order.count({
      where: { userId },
    });

    const totalPayments = await prisma.payment.count({
      where: { userId },
    });

    const byType = await prisma.discrepancy.groupBy({
      by: ["type"],
      where: { userId },
      _count: {
        id: true,
      },
      _sum: {
        amountAtRisk: true,
      },
      orderBy: {
        _sum: {
          amountAtRisk: "desc",
        },
      },
    });

    const totalInDisputeAgg = await prisma.discrepancy.aggregate({
      where: { userId },
      _sum: {
        amountAtRisk: true,
      },
    });

    const atRiskAgg = await prisma.discrepancy.aggregate({
      where: {
        userId,
        severity: {
          in: ["CRITICAL", "HIGH"],
        },
      },
      _sum: {
        amountAtRisk: true,
      },
    });

    const discrepancyOrderIdRows = await prisma.discrepancy.findMany({
      where: {
        userId,
        orderId: {
          not: null,
        },
      },
      select: {
        orderId: true,
      },
    });

    // Orders that have discrepancies
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
        id: {
          notIn: discrepancyOrderIds,
        },
      }),
    };

    const reconciledAgg = await prisma.order.aggregate({
      where: reconciledWhere,
      _sum: {
        netAmount: true,
      },
    });

    return NextResponse.json({
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
    });
  } catch (error) {
    console.error("Summary API Error:", error);

    return NextResponse.json(
      {
        error: "Failed to fetch dashboard summary",
        details:
          error instanceof Error ? error.message : "Unknown error",
      },
      {
        status: 500,
      }
    );
  }
}