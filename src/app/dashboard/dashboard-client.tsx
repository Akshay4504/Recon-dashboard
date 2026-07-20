"use client";

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ByTypeRow {
  type: string;
  count: number;
  amountAtRisk: string;
}

interface Summary {
  totalOrders: number;
  totalPayments: number;
  totalValueReconciled: string;
  totalValueInDispute: string;
  totalAtRisk: string;
  byType: ByTypeRow[];
}

interface MatchedPayment {
  id: string;
  transactionRef: string;
  processedAt: string | null;
  currency: string;
  amount: string;
  fee: string;
  netSettled: string;
  type: "CHARGE" | "REFUND";
  status: "SETTLED" | "PENDING" | "FAILED";
}

interface OrderContext {
  id: string;
  orderId: string;
  orderDate: string;
  customerEmail: string | null;
  currency: string;
  grossAmount: string;
  discount: string | null;
  netAmount: string;
  status: string;
}

interface Discrepancy {
  id: string;
  type: string;
  severity: string;
  amountAtRisk: string;
  details: Record<string, unknown>;
  createdAt: string;
  order: OrderContext | null;
  matchedPayments: MatchedPayment[];
}

interface ExplainResponse {
  summary: string;
  likelyCause: string;
  recommendedAction: string;
  confidence: "low" | "medium" | "high";
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  MISSING_PAYMENT: "Missing Payment",
  ORPHAN_PAYMENT: "Orphan Payment",
  DUPLICATE_CHARGE: "Duplicate Charge",
  PAYMENT_FAILED: "Payment Failed",
  PAYMENT_PENDING: "Payment Pending",
  AMOUNT_MISMATCH: "Amount Mismatch",
  CURRENCY_MISMATCH: "Currency Mismatch",
  REFUND_STATUS_MISMATCH: "Refund Status",
};

const TYPE_SHORT: Record<string, string> = {
  MISSING_PAYMENT: "Missing",
  ORPHAN_PAYMENT: "Orphan",
  DUPLICATE_CHARGE: "Duplicate",
  PAYMENT_FAILED: "Failed",
  PAYMENT_PENDING: "Pending",
  AMOUNT_MISMATCH: "Amt Mismatch",
  CURRENCY_MISMATCH: "Currency",
  REFUND_STATUS_MISMATCH: "Refund",
};

const SEVERITY_BADGE: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700 border border-red-200",
  HIGH: "bg-orange-100 text-orange-700 border border-orange-200",
  MEDIUM: "bg-yellow-100 text-yellow-700 border border-yellow-200",
  LOW: "bg-blue-100 text-blue-700 border border-blue-200",
};

const TYPE_BADGE: Record<string, string> = {
  MISSING_PAYMENT: "bg-red-50 text-red-800",
  ORPHAN_PAYMENT: "bg-purple-50 text-purple-800",
  DUPLICATE_CHARGE: "bg-orange-50 text-orange-800",
  PAYMENT_FAILED: "bg-red-50 text-red-800",
  PAYMENT_PENDING: "bg-sky-50 text-sky-800",
  AMOUNT_MISMATCH: "bg-yellow-50 text-yellow-800",
  CURRENCY_MISMATCH: "bg-pink-50 text-pink-800",
  REFUND_STATUS_MISMATCH: "bg-violet-50 text-violet-800",
};

const CHART_COLORS = [
  "#6366f1", "#f97316", "#ef4444", "#eab308",
  "#14b8a6", "#a855f7", "#ec4899", "#0ea5e9",
];

const PAYMENT_STATUS_BADGE: Record<string, string> = {
  SETTLED: "bg-green-100 text-green-700",
  PENDING: "bg-yellow-100 text-yellow-700",
  FAILED: "bg-red-100 text-red-700",
};

// ─── Utils ────────────────────────────────────────────────────────────────────

function fmt(amount: string | number, currency = "USD"): string {
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(n)) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ─── Skeleton helpers ─────────────────────────────────────────────────────────

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-gray-200 rounded ${className}`} />;
}

// ─── Summary Cards ────────────────────────────────────────────────────────────

function SummaryCards({ data, loading }: { data: Summary | null; loading: boolean }) {
  const cards = [
    {
      label: "Total Orders",
      value: loading ? null : data?.totalOrders.toLocaleString() ?? "—",
      icon: "📦",
      color: "from-violet-500 to-violet-700",
    },
    {
      label: "Total Payments",
      value: loading ? null : data?.totalPayments.toLocaleString() ?? "—",
      icon: "💳",
      color: "from-sky-500 to-sky-700",
    },
    {
      label: "Reconciled Value",
      value: loading ? null : fmt(data?.totalValueReconciled ?? "0"),
      icon: "✅",
      color: "from-emerald-500 to-emerald-700",
    },
    {
      label: "In Dispute",
      value: loading ? null : fmt(data?.totalValueInDispute ?? "0"),
      icon: "⚠️",
      color: "from-orange-500 to-orange-700",
    },
    {
      label: "Critical/High At Risk",
      value: loading ? null : fmt(data?.totalAtRisk ?? "0"),
      icon: "🚨",
      color: "from-red-500 to-red-700",
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-3"
        >
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${c.color} flex items-center justify-center text-lg`}>
            {c.icon}
          </div>
          {loading ? (
            <>
              <Skeleton className="h-7 w-24" />
              <Skeleton className="h-4 w-16" />
            </>
          ) : (
            <>
              <p className="text-2xl font-bold text-gray-900 tracking-tight">{c.value}</p>
              <p className="text-xs text-gray-500 font-medium">{c.label}</p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Charts ───────────────────────────────────────────────────────────────────

function DiscrepancyCharts({ data, loading }: { data: Summary | null; loading: boolean }) {
  const [view, setView] = useState<"count" | "amount">("count");

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <Skeleton className="h-6 w-40 mb-6" />
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }

  const byType = data?.byType ?? [];
  if (byType.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 flex items-center justify-center h-64 text-gray-400 text-sm">
        No discrepancies yet — run reconciliation to populate charts.
      </div>
    );
  }

  const chartData = byType.map((row, i) => ({
    name: TYPE_SHORT[row.type] ?? row.type,
    count: row.count,
    amount: parseFloat(row.amountAtRisk),
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-sm font-semibold text-gray-700">Discrepancies by Type</h2>
        <div className="flex rounded-lg overflow-hidden border border-gray-200 text-xs">
          <button
            onClick={() => setView("count")}
            className={`px-3 py-1.5 font-medium transition-colors ${
              view === "count"
                ? "bg-indigo-600 text-white"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            Count
          </button>
          <button
            onClick={() => setView("amount")}
            className={`px-3 py-1.5 font-medium transition-colors ${
              view === "amount"
                ? "bg-indigo-600 text-white"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            $ At Risk
          </button>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} barCategoryGap="30%">
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11, fill: "#6b7280" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "#6b7280" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={view === "amount" ? (v) => `$${v}` : undefined}
          />
          <Tooltip
            formatter={(value) =>
              view === "amount"
                ? [`$${Number(value).toFixed(2)}`, "At Risk"]
                : [Number(value), "Count"]
            }
            contentStyle={{
              fontSize: 12,
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
            }}
          />
          <Bar dataKey={view === "count" ? "count" : "amount"} radius={[4, 4, 0, 0]}>
            {chartData.map((entry, index) => (
              <Cell key={index} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Expanded Row Detail ──────────────────────────────────────────────────────

function ExpandedDetail({ disc }: { disc: Discrepancy }) {
  const [explainData, setExplainData] = useState<ExplainResponse | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);

  async function handleExplain() {
    setExplainLoading(true);
    setExplainError(null);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discrepancyId: disc.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to explain");
      setExplainData(data);
    } catch (e) {
      setExplainError((e as Error).message);
    } finally {
      setExplainLoading(false);
    }
  }

  return (
    <div className="bg-gray-50 border-t border-gray-100 px-6 py-5 space-y-6">
      {/* Explain section */}
      <div className="bg-indigo-50/50 border border-indigo-100 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-indigo-900 flex items-center gap-2">
            <span className="text-lg">✨</span> AI Explanation
          </h3>
          {!explainData && !explainLoading && (
            <button
              onClick={handleExplain}
              className="px-3 py-1.5 bg-white border border-indigo-200 text-indigo-600 text-xs font-medium rounded-lg hover:bg-indigo-50 transition-colors shadow-sm"
            >
              Explain Discrepancy
            </button>
          )}
        </div>

        {explainLoading && (
          <div className="space-y-3 animate-pulse">
            <Skeleton className="h-4 w-3/4 bg-indigo-100" />
            <Skeleton className="h-4 w-full bg-indigo-100" />
            <Skeleton className="h-4 w-5/6 bg-indigo-100" />
          </div>
        )}

        {explainError && (
          <div className="text-sm text-red-600 flex items-center justify-between">
            <span>Failed to generate explanation: {explainError}</span>
            <button onClick={handleExplain} className="underline hover:text-red-700">
              Retry
            </button>
          </div>
        )}

        {explainData && !explainLoading && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
            <div className="md:col-span-2 space-y-4">
              <div>
                <span className="text-indigo-400 font-semibold text-xs uppercase tracking-wider block mb-1">Summary</span>
                <p className="text-indigo-950">{explainData.summary}</p>
              </div>
              <div>
                <span className="text-indigo-400 font-semibold text-xs uppercase tracking-wider block mb-1">Likely Cause</span>
                <p className="text-indigo-950">{explainData.likelyCause}</p>
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <span className="text-indigo-400 font-semibold text-xs uppercase tracking-wider block mb-1">Recommended Action</span>
                <p className="text-indigo-950">{explainData.recommendedAction}</p>
              </div>
              <div>
                <span className="text-indigo-400 font-semibold text-xs uppercase tracking-wider block mb-1">Confidence</span>
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${
                  explainData.confidence === 'high' ? 'bg-emerald-100 text-emerald-700' :
                  explainData.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                  'bg-red-100 text-red-700'
                }`}>
                  {explainData.confidence}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl">
        {/* Order panel */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            {disc.order ? "Order Record" : "Discrepancy Details"}
          </p>
          {disc.order ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {[
                ["Order ID", disc.order.orderId],
                ["Status", disc.order.status],
                ["Date", fmtDate(disc.order.orderDate)],
                ["Customer", disc.order.customerEmail ?? "—"],
                ["Currency", disc.order.currency],
                ["Gross Amount", fmt(disc.order.grossAmount, disc.order.currency)],
                ["Discount", disc.order.discount ? fmt(disc.order.discount, disc.order.currency) : "—"],
                ["Net Amount", fmt(disc.order.netAmount, disc.order.currency)],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-gray-400 text-xs">{k}</dt>
                  <dd className="text-gray-800 font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {Object.entries(disc.details)
                .filter(([k]) => k !== "reason")
                .slice(0, 8)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-gray-400 text-xs capitalize">
                      {k.replace(/_/g, " ")}
                    </dt>
                    <dd className="text-gray-800 font-medium truncate">{String(v as unknown)}</dd>
                  </div>
                ))}
            </dl>
          )}
          {disc.details.reason != null && (
            <p className="mt-3 text-xs text-gray-500 italic border-l-2 border-gray-300 pl-2">
              {String(disc.details.reason)}
            </p>
          )}
        </div>

        {/* Payments panel */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Matched Payments ({disc.matchedPayments.length})
          </p>
          {disc.matchedPayments.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No payments matched.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-xs">
                <thead className="bg-gray-100">
                  <tr>
                    {["Ref", "Type", "Status", "Amount", "Date"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-semibold text-gray-500">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {disc.matchedPayments.map((p) => (
                    <tr key={p.id} className="border-t border-gray-100">
                      <td className="px-3 py-2 font-mono text-gray-700 truncate max-w-[120px]">
                        {p.transactionRef}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                            p.type === "CHARGE"
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }`}
                        >
                          {p.type}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                            PAYMENT_STATUS_BADGE[p.status] ?? ""
                          }`}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-medium text-gray-800">
                        {fmt(p.amount, p.currency)}
                      </td>
                      <td className="px-3 py-2 text-gray-500">
                        {fmtDateTime(p.processedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Discrepancy Table ────────────────────────────────────────────────────────

type SortField = "type" | "severity" | "amountAtRisk" | "createdAt";

function SortIcon({ field, current, dir }: { field: string; current: string; dir: string }) {
  if (field !== current) return <span className="text-gray-300 ml-1">↕</span>;
  return <span className="text-indigo-500 ml-1">{dir === "asc" ? "↑" : "↓"}</span>;
}

function DiscrepancyTable({
  data,
  pagination,
  loading,
  error,
  filters,
  onFiltersChange,
  onRetry,
}: {
  data: Discrepancy[];
  pagination: Pagination | null;
  loading: boolean;
  error: string | null;
  filters: {
    type: string;
    severity: string;
    search: string;
    page: number;
    sort: SortField;
    order: "asc" | "desc";
  };
  onFiltersChange: (f: Partial<typeof filters>) => void;
  onRetry: () => void;
}) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const searchRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function handleSearch(value: string) {
    clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => {
      onFiltersChange({ search: value, page: 1 });
    }, 300);
  }

  function handleSort(field: SortField) {
    if (filters.sort === field) {
      onFiltersChange({ order: filters.order === "asc" ? "desc" : "asc" });
    } else {
      onFiltersChange({ sort: field, order: "desc" });
    }
  }

  const TYPES = [
    "MISSING_PAYMENT","ORPHAN_PAYMENT","DUPLICATE_CHARGE","PAYMENT_FAILED",
    "PAYMENT_PENDING","AMOUNT_MISMATCH","CURRENCY_MISMATCH","REFUND_STATUS_MISMATCH",
  ];
  const SEVERITIES = ["CRITICAL","HIGH","MEDIUM","LOW"];

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Toolbar */}
      <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-gray-700 mr-auto">Discrepancies</h2>

        {/* Search */}
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            id="search-input"
            type="text"
            placeholder="Order ID, email, txn ref…"
            defaultValue={filters.search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 w-52"
          />
        </div>

        {/* Type filter */}
        <select
          id="type-filter"
          value={filters.type}
          onChange={(e) => onFiltersChange({ type: e.target.value, page: 1 })}
          className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-300"
        >
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
          ))}
        </select>

        {/* Severity filter */}
        <select
          id="severity-filter"
          value={filters.severity}
          onChange={(e) => onFiltersChange({ severity: e.target.value, page: 1 })}
          className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-300"
        >
          <option value="">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* Error state */}
      {error && (
        <div className="px-6 py-8 text-center">
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button
            onClick={onRetry}
            className="text-sm text-indigo-600 hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !error && (
        <div className="divide-y divide-gray-50">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="px-6 py-4 flex gap-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-20 ml-auto" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && data.length === 0 && (
        <div className="px-6 py-16 text-center">
          <div className="text-4xl mb-4">🎉</div>
          <p className="text-gray-700 font-medium">No discrepancies found</p>
          <p className="text-sm text-gray-400 mt-1">
            {filters.search || filters.type || filters.severity
              ? "Try adjusting your filters."
              : "Run reconciliation to scan your data."}
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && !error && data.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="w-8 px-6 py-3" />
                  {[
                    { label: "Type", field: "type" as SortField },
                    { label: "Severity", field: "severity" as SortField },
                    { label: "Order / Reference", field: null },
                    { label: "At Risk", field: "amountAtRisk" as SortField },
                    { label: "Detected", field: "createdAt" as SortField },
                  ].map(({ label, field }) => (
                    <th
                      key={label}
                      className={`px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide ${
                        field ? "cursor-pointer select-none hover:text-gray-700" : ""
                      }`}
                      onClick={field ? () => handleSort(field) : undefined}
                    >
                      {label}
                      {field && (
                        <SortIcon field={field} current={filters.sort} dir={filters.order} />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.map((disc) => {
                  const expanded = expandedRows.has(disc.id);
                  return (
                    <>
                      <tr
                        key={disc.id}
                        className="hover:bg-gray-50/70 cursor-pointer transition-colors"
                        onClick={() => toggleRow(disc.id)}
                      >
                        <td className="pl-6 py-4 text-gray-400 text-sm">
                          <span className="transition-transform inline-block"
                            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>
                            ▶
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-semibold ${TYPE_BADGE[disc.type] ?? "bg-gray-100 text-gray-700"}`}>
                            {TYPE_LABELS[disc.type] ?? disc.type}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${SEVERITY_BADGE[disc.severity] ?? ""}`}>
                            {disc.severity}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          {disc.order ? (
                            <div>
                              <p className="text-sm font-mono font-medium text-gray-800">
                                {disc.order.orderId}
                              </p>
                              {disc.order.customerEmail && (
                                <p className="text-xs text-gray-400">
                                  {disc.order.customerEmail}
                                </p>
                              )}
                            </div>
                          ) : (
                            <div>
                              <p className="text-sm font-mono text-gray-500">
                                {String(disc.details.orderReference ?? "—")}
                              </p>
                              <p className="text-xs text-gray-400">
                                {String(disc.details.transactionRef ?? "")}
                              </p>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-4 text-sm font-semibold text-gray-800">
                          {parseFloat(disc.amountAtRisk) > 0
                            ? fmt(disc.amountAtRisk, disc.order?.currency ?? "USD")
                            : <span className="text-gray-400 font-normal">Informational</span>}
                        </td>
                        <td className="px-4 py-4 text-xs text-gray-400">
                          {fmtDate(disc.createdAt)}
                        </td>
                      </tr>
                      {expanded && (
                        <tr key={`${disc.id}-expand`}>
                          <td colSpan={6} className="p-0">
                            <ExpandedDetail disc={disc} />
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between text-sm">
              <span className="text-gray-500">
                {(pagination.page - 1) * pagination.pageSize + 1}–
                {Math.min(pagination.page * pagination.pageSize, pagination.total)} of{" "}
                {pagination.total}
              </span>
              <div className="flex gap-2">
                <button
                  disabled={pagination.page <= 1}
                  onClick={() => onFiltersChange({ page: pagination.page - 1 })}
                  className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 disabled:opacity-40 hover:bg-gray-50 transition-colors"
                >
                  ← Prev
                </button>
                <span className="px-3 py-1.5 text-gray-500">
                  {pagination.page} / {pagination.totalPages}
                </span>
                <button
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => onFiltersChange({ page: pagination.page + 1 })}
                  className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 disabled:opacity-40 hover:bg-gray-50 transition-colors"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Notification toast ───────────────────────────────────────────────────────

function Toast({ message, type }: { message: string; type: "success" | "error" }) {
  return (
    <div
      className={`fixed bottom-6 right-6 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium flex items-center gap-2 animate-in slide-in-from-bottom-4 ${
        type === "success" ? "bg-emerald-600 text-white" : "bg-red-600 text-white"
      }`}
    >
      {type === "success" ? "✓" : "✗"} {message}
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function DashboardClient({
  userEmail,
  signOutAction,
}: {
  userEmail: string;
  signOutAction: () => Promise<void>;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [discData, setDiscData] = useState<Discrepancy[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [discLoading, setDiscLoading] = useState(true);
  const [discError, setDiscError] = useState<string | null>(null);

  const [reconciling, setReconciling] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const [filters, setFilters] = useState({
    type: "",
    severity: "",
    search: "",
    page: 1,
    sort: "createdAt" as SortField,
    order: "desc" as "asc" | "desc",
  });

  function showToast(message: string, type: "success" | "error") {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }

  // Fetch summary
  const fetchSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const res = await fetch("/api/summary");
      if (!res.ok) throw new Error("Failed to load summary");
      setSummary(await res.json());
    } catch (e) {
      setSummaryError((e as Error).message);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  // Fetch discrepancies
  const fetchDiscrepancies = useCallback(async (f: typeof filters) => {
    setDiscLoading(true);
    setDiscError(null);
    try {
      const params = new URLSearchParams({
        page: String(f.page),
        sort: f.sort,
        order: f.order,
        ...(f.type && { type: f.type }),
        ...(f.severity && { severity: f.severity }),
        ...(f.search && { search: f.search }),
      });
      const res = await fetch(`/api/discrepancies?${params}`);
      if (!res.ok) throw new Error("Failed to load discrepancies");
      const json = await res.json();
      setDiscData(json.data);
      setPagination(json.pagination);
    } catch (e) {
      setDiscError((e as Error).message);
    } finally {
      setDiscLoading(false);
    }
  }, []);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => { fetchDiscrepancies(filters); }, [filters, fetchDiscrepancies]);

  function updateFilters(patch: Partial<typeof filters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  async function handleReconcile() {
    setReconciling(true);
    try {
      const res = await fetch("/api/reconcile", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Reconciliation failed");
      // Use the inline summary from reconcile response
      setSummary(json.summary);
      // Refetch discrepancies (reset to page 1 with current filters)
      fetchDiscrepancies({ ...filters, page: 1 });
      setFilters((prev) => ({ ...prev, page: 1 }));
      showToast(`Reconciliation complete — ${json.discrepanciesFound} discrepancies found`, "success");
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setReconciling(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50/80">
      {/* Nav */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">R</div>
          <span className="font-semibold text-gray-900 text-sm">Recon Dashboard</span>
        </div>

        <nav className="flex gap-1 ml-4">
          <a href="/dashboard/upload" className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors flex items-center gap-1.5">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            Import CSV
          </a>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <button
            id="reconcile-btn"
            onClick={handleReconcile}
            disabled={reconciling}
            className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {reconciling ? (
              <>
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Running…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Run Reconciliation
              </>
            )}
          </button>

          <span className="text-xs text-gray-500 hidden sm:block">{userEmail}</span>

          <form action={signOutAction}>
            <button
              id="signout-btn"
              type="submit"
              className="text-xs text-gray-500 hover:text-red-600 transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Summary error */}
        {summaryError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 flex items-center justify-between text-sm text-red-700">
            <span>⚠ Could not load summary: {summaryError}</span>
            <button onClick={fetchSummary} className="underline">Retry</button>
          </div>
        )}

        {/* Headline cards */}
        <SummaryCards data={summary} loading={summaryLoading} />

        {/* Charts */}
        <DiscrepancyCharts data={summary} loading={summaryLoading} />

        {/* Discrepancy table */}
        <DiscrepancyTable
          data={discData}
          pagination={pagination}
          loading={discLoading}
          error={discError}
          filters={filters}
          onFiltersChange={updateFilters}
          onRetry={() => fetchDiscrepancies(filters)}
        />
      </main>

      {toast && <Toast message={toast.message} type={toast.type} />}
    </div>
  );
}
