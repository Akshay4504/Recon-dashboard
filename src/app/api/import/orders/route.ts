import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth-config";
import prisma from "@/lib/prisma";
import {
  parseCsvStream,
  parseDecimal,
  normaliseRef,
  dedupeRows,
} from "@/lib/csv-parse";
import { parseOrderDate } from "@/lib/date-parse";
import { Prisma, OrderStatus } from "@prisma/client";

// Expected CSV columns (case-sensitive, must match exactly)
const REQUIRED_HEADERS = [
  "order_id",
  "order_date",
  "customer_email",
  "currency",
  "gross_amount",
  "discount",
  "net_amount",
  "status",
];

type OrderRow = {
  orderId: string;
  orderDate: Date;
  customerEmail: string | null;
  currency: string;
  grossAmount: Prisma.Decimal;
  discount: Prisma.Decimal | null;
  netAmount: Prisma.Decimal;
  status: string;
};

function parseStatus(raw: string | undefined, row: number): string {
  if (!raw || raw.trim() === "") {
    throw new Error(`Field "status" is required but was empty at row ${row}`);
  }
  const s = raw.trim().toUpperCase();
  const valid = ["PENDING", "COMPLETED", "CANCELLED", "REFUNDED"] as const;
  if (!valid.includes(s as (typeof valid)[number])) {
    throw new Error(
      `Field "status" value "${raw.trim()}" is not valid. Expected one of ${valid.join(", ")}`
    );
  }
  return s;
}

export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // ── Read file from multipart form ──────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart form data" },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'No file uploaded. Use field name "file".' },
      { status: 400 }
    );
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "Uploaded file is empty" }, { status: 400 });
  }

  const csvText = await file.text();

  // ── Server-side streaming parse ──────────────────────────────────────────
  let parseResult: Awaited<ReturnType<typeof parseCsvStream<OrderRow>>>;
  try {
    parseResult = await parseCsvStream<OrderRow>(
      csvText,
      REQUIRED_HEADERS,
      (row, rowIndex, warnings) => {
        // Normalise order_id
        const orderId = normaliseRef(row.order_id, "order_id");

        // Parse date explicitly
        let orderDate: Date;
        try {
          orderDate = parseOrderDate(row.order_date);
        } catch (err) {
          throw new Error((err as Error).message);
        }

        // Nullable fields — record warnings, don't block
        let customerEmail: string | null = null;
        if (!row.customer_email || row.customer_email.trim() === "") {
          warnings.push({
            row: rowIndex,
            field: "customer_email",
            message: "customer_email is empty — stored as null",
          });
        } else {
          customerEmail = row.customer_email.trim();
        }

        // Currency
        if (!row.currency || row.currency.trim() === "") {
          throw new Error(`Field "currency" is required but was empty`);
        }
        const currency = row.currency.trim().toUpperCase();

        // Decimal money fields
        const grossAmount = parseDecimal(row.gross_amount, "gross_amount");
        if (!grossAmount) throw new Error(`Field "gross_amount" is required`);

        let discount: Prisma.Decimal | null = null;
        if (!row.discount || row.discount.trim() === "") {
          warnings.push({
            row: rowIndex,
            field: "discount",
            message: "discount is empty — stored as null",
          });
        } else {
          discount = parseDecimal(row.discount, "discount");
        }

        const netAmount = parseDecimal(row.net_amount, "net_amount");
        if (!netAmount) throw new Error(`Field "net_amount" is required`);

        const status = parseStatus(row.status, rowIndex);

        return {
          orderId,
          orderDate,
          customerEmail,
          currency,
          grossAmount,
          discount,
          netAmount,
          status,
        };
      }
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 422 });
  }

  const { warnings } = parseResult;
  let { rows } = parseResult;

  // ── Deduplicate exact-duplicate rows ─────────────────────────────────────
  const { rows: deduped, removed: dedupedCount } = dedupeRows(rows);
  rows = deduped;

  if (dedupedCount > 0) {
    warnings.push({
      row: -1,
      field: "dedup",
      message: `${dedupedCount} exact-duplicate row(s) were removed before import`,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No valid rows to import after deduplication" },
      { status: 422 }
    );
  }

  // ── Persist — atomic: batch + orders + warning count all succeed or all
  //    roll back together. createMany keeps this to a single insert query
  //    inside the transaction, so a generous timeout is just a safety
  //    margin, not a crutch for row-by-row writes. ──────────────────────────
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const batch = await tx.importBatch.create({
          data: {
            userId,
            source: "ORDERS",
            filename: file.name,
            rowCount: rows.length,
            warningCount: warnings.length,
          },
        });

        const created = await tx.order.createMany({
          data: rows.map((r) => ({
            userId,
            importBatchId: batch.id,
            orderId: r.orderId,
            orderDate: r.orderDate,
            customerEmail: r.customerEmail,
            currency: r.currency,
            grossAmount: r.grossAmount,
            discount: r.discount,
            netAmount: r.netAmount,
            status: r.status as OrderStatus,
          })),
          skipDuplicates: true,
        });

        const skippedByDb = rows.length - created.count;
        if (skippedByDb > 0) {
          warnings.push({
            row: -1,
            field: "db_upsert",
            message: `${skippedByDb} row(s) already existed in the database and were skipped`,
          });
        }

        const finalBatch = await tx.importBatch.update({
          where: { id: batch.id },
          data: { warningCount: warnings.length },
        });

        return { batch: finalBatch, importedCount: created.count };
      },
      { timeout: 15000, maxWait: 5000 }
    );

    return NextResponse.json({
      success: true,
      batchId: result.batch.id,
      importedCount: result.importedCount,
      dedupedCount,
      warningCount: warnings.length,
      warnings,
    });
  } catch (err) {
    console.error("Orders import DB error:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Database error during import",
      },
      { status: 500 }
    );
  }
}