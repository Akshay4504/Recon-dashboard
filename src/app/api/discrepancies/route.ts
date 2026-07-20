import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth-config";
import prisma from "@/lib/prisma";
import { Prisma, DiscrepancyType, Severity } from "@prisma/client";

const PAGE_SIZE = 20;

function d(v: Prisma.Decimal | null | undefined): string {
  return v?.toFixed(2) ?? "0.00";
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = req.nextUrl;
  const type = searchParams.get("type") ?? undefined;
  const severity = searchParams.get("severity") ?? undefined;
  const search = searchParams.get("search")?.trim() ?? undefined;
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const sortField = searchParams.get("sort") ?? "createdAt";
  const sortDir = (searchParams.get("order") ?? "desc") as "asc" | "desc";

  // ── txnRef pre-query: find Order DB IDs that have matching payments ──────
  let txnRefOrderDbIds: string[] = [];
  if (search) {
    const matchingPmts = await prisma.payment.findMany({
      where: {
        userId,
        transactionRef: { contains: search, mode: "insensitive" },
      },
      select: { orderReference: true },
      distinct: ["orderReference"],
    });
    if (matchingPmts.length > 0) {
      const refs = matchingPmts.map((p) => p.orderReference);
      const matchingOrders = await prisma.order.findMany({
        where: { userId, orderId: { in: refs } },
        select: { id: true },
      });
      txnRefOrderDbIds = matchingOrders.map((o) => o.id);
    }
  }

  // ── Main WHERE clause ────────────────────────────────────────────────────
  const where: Prisma.DiscrepancyWhereInput = {
    userId,
    ...(type && { type: type as DiscrepancyType }),
    ...(severity && { severity: severity as Severity }),
    ...(search && {
      OR: [
        { order: { orderId: { contains: search, mode: "insensitive" } } },
        {
          order: {
            customerEmail: { contains: search, mode: "insensitive" },
          },
        },
        // txnRef via pre-query
        ...(txnRefOrderDbIds.length > 0
          ? [{ orderId: { in: txnRefOrderDbIds } }]
          : []),
        // Orphan payment: transactionRef is stored in details JSON
        {
          AND: [
            { orderId: null },
            {
              details: {
                path: ["transactionRef"],
                string_contains: search,
              },
            },
          ],
        },
      ],
    }),
  };

  // ── ORDER BY ─────────────────────────────────────────────────────────────
  const validSorts: Record<
    string,
    Prisma.DiscrepancyOrderByWithRelationInput
  > = {
    type: { type: sortDir },
    severity: { severity: sortDir },
    amountAtRisk: { amountAtRisk: sortDir },
    createdAt: { createdAt: sortDir },
  };
  const orderBy =
    validSorts[sortField] ?? ({ createdAt: "desc" } as const);

  // ── Paginated query + count ───────────────────────────────────────────────
  const [total, discrepancies] = await Promise.all([
    prisma.discrepancy.count({ where }),
    prisma.discrepancy.findMany({
      where,
      orderBy,
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
      include: {
        order: {
          select: {
            id: true,
            orderId: true,
            orderDate: true,
            customerEmail: true,
            currency: true,
            grossAmount: true,
            discount: true,
            netAmount: true,
            status: true,
          },
        },
      },
    }),
  ]);

  // ── Batch-fetch matched payments for all returned orders ──────────────────
  const orderRefs = discrepancies
    .filter((d) => d.order !== null)
    .map((d) => d.order!.orderId);

  const matchedPayments = orderRefs.length
    ? await prisma.payment.findMany({
        where: { userId, orderReference: { in: orderRefs } },
        select: {
          id: true,
          transactionRef: true,
          orderReference: true,
          processedAt: true,
          currency: true,
          amount: true,
          fee: true,
          netSettled: true,
          type: true,
          status: true,
        },
      })
    : [];

  // Group payments by orderReference
  const paymentsByRef = new Map<string, typeof matchedPayments>();
  for (const p of matchedPayments) {
    const list = paymentsByRef.get(p.orderReference) ?? [];
    list.push(p);
    paymentsByRef.set(p.orderReference, list);
  }

  // ── Serialize ─────────────────────────────────────────────────────────────
  const data = discrepancies.map((disc) => ({
    id: disc.id,
    type: disc.type,
    severity: disc.severity,
    amountAtRisk: d(disc.amountAtRisk),
    details: disc.details,
    createdAt: disc.createdAt.toISOString(),
    order: disc.order
      ? {
          id: disc.order.id,
          orderId: disc.order.orderId,
          orderDate: disc.order.orderDate.toISOString(),
          customerEmail: disc.order.customerEmail,
          currency: disc.order.currency,
          grossAmount: d(disc.order.grossAmount),
          discount: disc.order.discount ? d(disc.order.discount) : null,
          netAmount: d(disc.order.netAmount),
          status: disc.order.status,
        }
      : null,
    matchedPayments: disc.order
      ? (paymentsByRef.get(disc.order.orderId) ?? []).map((p) => ({
          id: p.id,
          transactionRef: p.transactionRef,
          processedAt: p.processedAt?.toISOString() ?? null,
          currency: p.currency,
          amount: d(p.amount),
          fee: d(p.fee),
          netSettled: d(p.netSettled),
          type: p.type,
          status: p.status,
        }))
      : [],
  }));

  return NextResponse.json({
    data,
    pagination: {
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
    },
  });
}
