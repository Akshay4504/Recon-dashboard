"use client";

import { useState, useRef, type ChangeEvent, type FormEvent } from "react";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ImportWarning {
  row: number;
  field: string;
  message: string;
}

interface ImportResult {
  success: boolean;
  batchId: string;
  importedCount: number;
  dedupedCount: number;
  warningCount: number;
  warnings: ImportWarning[];
}

type UploadType = "orders" | "payments";

// ─── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({ result, type }: { result: ImportResult; type: UploadType }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-6 rounded-xl border border-green-200 bg-green-50 p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-green-800 uppercase tracking-wide">
            ✓ Import complete — {type === "orders" ? "Orders" : "Payments"}
          </p>
          <p className="mt-1 text-xs text-green-700">Batch ID: {result.batchId}</p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-lg bg-white border border-green-100 p-3">
          <dt className="text-xs text-gray-500">Imported</dt>
          <dd className="mt-1 text-2xl font-bold text-gray-900">{result.importedCount}</dd>
        </div>
        <div className="rounded-lg bg-white border border-yellow-100 p-3">
          <dt className="text-xs text-gray-500">Deduped</dt>
          <dd className="mt-1 text-2xl font-bold text-yellow-600">{result.dedupedCount}</dd>
        </div>
        <div className="rounded-lg bg-white border border-orange-100 p-3">
          <dt className="text-xs text-gray-500">Warnings</dt>
          <dd className="mt-1 text-2xl font-bold text-orange-600">{result.warningCount}</dd>
        </div>
      </dl>

      {result.warnings.length > 0 && (
        <div className="mt-4">
          <button
            id={`toggle-warnings-${type}`}
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-sm font-medium text-orange-700 hover:underline focus:outline-none"
          >
            {expanded ? "▲ Hide warnings" : "▼ Show warnings"}
          </button>

          {expanded && (
            <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-orange-200 bg-orange-50">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-orange-100">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-orange-800">Row</th>
                    <th className="px-3 py-2 text-left font-semibold text-orange-800">Field</th>
                    <th className="px-3 py-2 text-left font-semibold text-orange-800">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {result.warnings.map((w, i) => (
                    <tr
                      key={i}
                      className="border-t border-orange-100 hover:bg-orange-100/50"
                    >
                      <td className="px-3 py-1.5 text-gray-600">
                        {w.row === -1 ? "—" : w.row}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-orange-700">{w.field}</td>
                      <td className="px-3 py-1.5 text-gray-700">{w.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UploadPanel({
  type,
  label,
  accept,
  expectedColumns,
}: {
  type: UploadType;
  label: string;
  accept: string;
  expectedColumns: string[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    setFile(picked);
    setError(null);
    setResult(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult(null);

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await fetch(`/api/import/${type}`, {
        method: "POST",
        body: fd,
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? "Upload failed");
      } else {
        setResult(json as ImportResult);
      }
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900 mb-1">{label}</h2>
      <p className="text-xs text-gray-500 mb-4 font-mono">
        Expected columns: {expectedColumns.join(", ")}
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div
          className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 cursor-pointer transition-colors
            ${file ? "border-blue-400 bg-blue-50" : "border-gray-300 bg-gray-50 hover:border-blue-300 hover:bg-blue-50/40"}`}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            id={`file-input-${type}`}
            type="file"
            accept={accept}
            className="hidden"
            onChange={handleFileChange}
          />
          <svg
            className="w-8 h-8 text-gray-400 mb-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
            />
          </svg>
          {file ? (
            <p className="text-sm font-medium text-blue-700">{file.name}</p>
          ) : (
            <p className="text-sm text-gray-500">Click to select a CSV file</p>
          )}
          {file && (
            <p className="text-xs text-gray-400 mt-1">
              {(file.size / 1024).toFixed(1)} KB
            </p>
          )}
        </div>

        {error && (
          <div
            id={`error-${type}`}
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            <strong>Error:</strong> {error}
          </div>
        )}

        <button
          id={`upload-btn-${type}`}
          type="submit"
          disabled={!file || loading}
          className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Importing…
            </span>
          ) : (
            `Import ${label}`
          )}
        </button>
      </form>

      {result && <SummaryCard result={result} type={type} />}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function UploadPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700">
            ← Dashboard
          </a>
          <span className="text-gray-300">|</span>
          <h1 className="text-base font-semibold text-gray-900">CSV Upload</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900">Import Data</h2>
          <p className="mt-1 text-sm text-gray-500">
            Upload orders and payments CSV files. Files are parsed server-side.
            Duplicate rows are deduplicated automatically.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <UploadPanel
            type="orders"
            label="Orders CSV"
            accept=".csv,text/csv"
            expectedColumns={[
              "order_id",
              "order_date",
              "customer_email",
              "currency",
              "gross_amount",
              "discount",
              "net_amount",
              "status",
            ]}
          />
          <UploadPanel
            type="payments"
            label="Payments CSV"
            accept=".csv,text/csv"
            expectedColumns={[
              "transaction_ref",
              "processed_at",
              "order_reference",
              "currency",
              "amount",
              "fee",
              "net_settled",
              "type",
              "status",
            ]}
          />
        </div>

        <div className="mt-8 rounded-xl border border-gray-200 bg-white p-5 text-xs text-gray-500 space-y-1">
          <p className="font-semibold text-gray-700 text-sm mb-2">Format notes</p>
          <p>• <strong>order_date</strong> format: <code className="font-mono bg-gray-100 px-1 rounded">YYYY-MM-DD HH:MM:SS</code></p>
          <p>• <strong>processed_at</strong> format: <code className="font-mono bg-gray-100 px-1 rounded">DD/MM/YYYY HH:MM</code></p>
          <p>• <strong>order_id / order_reference</strong> are trimmed and upper-cased automatically</p>
          <p>• <strong>customer_email, discount, processed_at</strong> may be empty — stored as null with a warning</p>
          <p>• Exact-duplicate rows are silently removed before import and counted in the summary</p>
        </div>
      </main>
    </div>
  );
}
