import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth-config";
import prisma from "@/lib/prisma";
import {
  parseCsvStream,
  parseDecimal,
  normaliseRef,
  dedupeRows,
} from "@/lib/csv-parse";
import { parseProcessedAt } from "@/lib/date-parse";
import { Prisma } from "@prisma/client";

// Expected CSV columns (case-sensitive, must match exactly)
const REQUIRED_HEADERS = [
  "transaction_ref",
  "processed_at",
  "order_reference",
  "currency",
  "amount",
  "fee",
  "net_settled",
  "type",
  "status",
];

type PaymentRow = {
  transactionRef: string;
  processedAt: Date | null;
  orderReference: string;
  currency: string;
  amount: Prisma.Decimal;
  fee: Prisma.Decimal;
  netSettled: Prisma.Decimal;
  type: string;
  status: string;
};

function parseType(raw: string | undefined, row: number): string {
  if (!raw || raw.trim() === "") {
    throw new Error(`Field "type" is required but was empty at row ${row}`);
  }
  const t = raw.trim().toUpperCase();
  const valid = ["CHARGE", "REFUND"] as const;
  if (!valid.includes(t as (typeof valid)[number])) {
    throw new Error(
      `Field "type" value "${raw.trim()}" is not valid. Expected one of ${valid.join(", ")}`
    );
  }
  return t;
}

function parsePaymentStatus(raw: string | undefined, row: number): string {
  if (!raw || raw.trim() === "") {
    throw new Error(`Field "status" is required but was empty at row ${row}`);
  }
  const s = raw.trim().toUpperCase();
  const valid = ["SETTLED", "PENDING", "FAILED"] as const;
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
  let parseResult: Awaited<ReturnType<typeof parseCsvStream<PaymentRow>>>;
  try {
    parseResult = await parseCsvStream<PaymentRow>(
      csvText,
      REQUIRED_HEADERS,
      (row, rowIndex, warnings) => {
        // transaction_ref is required, no fallback
        if (!row.transaction_ref || row.transaction_ref.trim() === "") {
          throw new Error(`Field "transaction_ref" is required but was empty at row ${rowIndex}`);
        }
        const transactionRef = row.transaction_ref.trim();

        // processed_at — nullable, format DD/MM/YYYY HH:MM
        let processedAt: Date | null = null;
        if (!row.processed_at || row.processed_at.trim() === "") {
          warnings.push({
            row: rowIndex,
            field: "processed_at",
            message: "processed_at is empty — stored as null",
          });
        } else {
          try {
            processedAt = parseProcessedAt(row.processed_at);
          } catch (err) {
            throw new Error((err as Error).message);
          }
        }

        // Normalise order_reference — trims and uppercases, so whitespace/
        // case noise (' ord-1801 ', 'ord-1802') matches the order side.
        const orderReference = normaliseRef(row.order_reference, "order_reference");

        // Currency
        if (!row.currency || row.currency.trim() === "") {
          throw new Error(`Field "currency" is required but was empty`);
        }
        const currency = row.currency.trim().toUpperCase();

        // Decimal money fields
        const amount = parseDecimal(row.amount, "amount");
        if (!amount) throw new Error(`Field "amount" is required`);

        const fee = parseDecimal(row.fee, "fee") ?? new Prisma.Decimal(0);

        const netSettled = parseDecimal(row.net_settled, "net_settled");
        if (!netSettled) throw new Error(`Field "net_settled" is required`);

        const type = parseType(row.type, rowIndex);
        const status = parsePaymentStatus(row.status, rowIndex);

        return {
          transactionRef,
          processedAt,
          orderReference,
          currency,
          amount,
          fee,
          netSettled,
          type,
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

  // ── Persist — NOT wrapped in prisma.$transaction. Neon's pooled connection
  //    (PgBouncer, transaction-pooling mode) does not reliably support
  //    Prisma interactive transactions — connections can get reassigned
  //    mid-transaction, which surfaces as "transaction already closed"
  //    regardless of the timeout configured. createMany is already a single
  //    atomic statement on its own, so we don't need an interactive
  //    transaction for that part. We just manually clean up the ImportBatch
  //    if the payment insert fails, instead of relying on DB rollback. ─────
  let batchId: string | undefined;
  try {
    const batch = await prisma.importBatch.create({
      data: {
        userId,
        source: "PAYMENTS",
        filename: file.name,
        rowCount: rows.length,
        warningCount: warnings.length,
      },
    });
    batchId = batch.id;

    const created = await prisma.payment.createMany({
      data: rows.map((r) => ({
        userId,
        importBatchId: batch.id,
        transactionRef: r.transactionRef,
        processedAt: r.processedAt,
        orderReference: r.orderReference,
        currency: r.currency,
        amount: r.amount,
        fee: r.fee,
        netSettled: r.netSettled,
        type: r.type as Prisma.$Enums.PaymentType,
        status: r.status as Prisma.$Enums.PaymentStatus,
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

    const finalBatch = await prisma.importBatch.update({
      where: { id: batch.id },
      data: { warningCount: warnings.length },
    });

    return NextResponse.json({
      success: true,
      batchId: finalBatch.id,
      importedCount: created.count,
      dedupedCount,
      warningCount: warnings.length,
      warnings,
    });
  } catch (err) {
    console.error("Payments import DB error:", err);

    if (batchId) {
      await prisma.importBatch.delete({ where: { id: batchId } }).catch((cleanupErr) => {
        console.error("Failed to clean up orphaned ImportBatch:", cleanupErr);
      });
    }

    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Database error during import",
      },
      { status: 500 }
    );
  }
}