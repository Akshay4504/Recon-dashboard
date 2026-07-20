# Payment Reconciliation Dashboard

A high-performance, deterministic payment reconciliation engine and dashboard designed to bridge the gap between order systems and payment gateways.

## 🚀 Local Setup

1. **Clone the repository:**
   ```bash
   git clone <repo-url>
   cd recon-dashboard
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Setup:**
   Copy the example environment file and fill in your details:
   ```bash
   cp .env.example .env
   ```
   - Set `DATABASE_URL` to your local or remote PostgreSQL instance.
   - Generate a secure random string for `NEXTAUTH_SECRET` (e.g., using `openssl rand -base64 32`).
   - Provide an `OPENAI_API_KEY` to enable the AI explanation feature (optional but recommended).

4. **Database Migration:**
   Apply the database schema:
   ```bash
   npx prisma migrate dev
   ```

5. **Start the Development Server:**
   ```bash
   npm run dev
   ```
   Navigate to `http://localhost:3000` to log in, upload your CSV files, and run the reconciliation engine.

   **Demo Credentials:**
   - **Email:** `example@gmail.com`
   - **Password:** `Password`

---

## 🏗️ Architecture Overview

**Tech Stack:** Next.js 14 (App Router), TypeScript, Tailwind CSS, Prisma, PostgreSQL, Vitest, Recharts, OpenAI.

**Why this stack for a 24-hour scope?**
- **Next.js App Router:** Consolidates frontend UI and backend API routes in a single repository, dramatically accelerating feature velocity without context-switching between separate microservices.
- **Prisma + PostgreSQL:** Provides immediate type safety and autocompletion straight from the database schema to the frontend. The deterministic engine relies heavily on strict types, and Prisma's generated types guarantee we never query fields that don't exist.
- **Tailwind CSS & Recharts:** Enables rapid, utility-driven UI construction and out-of-the-box data visualization without wrestling with complex CSS files or D3.js configurations.
- **Vitest:** Extremely fast, Vite-powered testing that allows instant feedback during test-driven development of the core mathematical engine.

---

## ⚙️ Reconciliation Logic

The core engine is a **pure, deterministic function**. It takes normalized orders and payments, matches them, and emits discrepancies based on a strict, priority-ordered taxonomy. It performs zero I/O and uses zero LLMs during the classification phase to guarantee mathematical accuracy and idempotency.

### Matching Algorithm
Payments are matched to orders using the `orderReference` (from the payment gateway) mapped against the `orderId` (from the internal system). Prior to matching, both identifiers are strictly normalized (whitespace trimmed and transformed to uppercase) to eliminate common ingestion noise.

### Discrepancy Taxonomy (Priority Ordered)
When an order is `COMPLETED`, the engine evaluates it against these rules in sequence. The first rule to fire "wins" to avoid double-counting the root cause of an error.

1. **`MISSING_PAYMENT` (Critical):** Zero matching payments found.
2. **`PAYMENT_FAILED` (Critical):** All matching payments have a `FAILED` status.
3. **`PAYMENT_PENDING` (Low):** No settled charges yet, but a `PENDING` payment exists in the pipeline.
4. **`DUPLICATE_CHARGE` (High):** Multiple settled charges exist for a single order without sufficient offsetting refunds.
5. **`CURRENCY_MISMATCH` (High):** A settled charge was processed in a different currency than the order.
6. **`REFUND_STATUS_MISMATCH` (Medium):** The net collected amount is approximately zero (e.g., charge offset by refund), but the order status is still `COMPLETED` rather than `REFUNDED`.
7. **`AMOUNT_MISMATCH` (Medium):** The net collected amount differs from the expected net amount beyond the acceptable tolerance.
8. **`ORPHAN_PAYMENT` (Critical):** A payment exists with an `orderReference` that matches no known order in the system. (Evaluated independently of the order loop).

### Tolerances
Financial arithmetic often suffers from floating-point noise or minor gateway fee discrepancies. 
- **Epsilon (ε):** Tolerance is defined dynamically as `max(0.05, 0.001 * netAmount)`. 
- **Reasoning:** A flat 5-cent tolerance absorbs basic rounding or float precision errors for small orders. The 0.1% relative tolerance protects large volume orders (e.g., $10,000) where a minor $1 variance is a systemic rounding artifact, not a missing charge worth manual human review. 

---

## 📊 Data Findings & Business Impact

Upon processing the data, several critical patterns emerged, each carrying specific business implications:

- **Normalization Noise:** The raw payments data contained leading/trailing spaces and mismatched casing on references. Normalizing these keys automatically resolved a significant portion of false "missing payment" flags.
- **Missing / Failed Payments:** Represent **immediate lost revenue**. The business provided a product/service to a customer whose payment ultimately never cleared or didn't exist.
- **Orphan Payments:** Represent **liability**. Money was collected, but no service/order is attached. This could lead to chargebacks if the customer isn't provided what they paid for.
- **Duplicate Charges:** Represent **customer friction and liability**. Charging a customer twice requires immediate refund action to prevent chargebacks and brand damage.
- **Currency Mismatches:** Generally represent **bookkeeping and FX exposure risks**, where the gateway collected EUR but the order expected USD, complicating tax and net-revenue calculations.
- **Refund-Status Mismatches & Pending Payments:** These represent **unresolved bookkeeping**. They do not require emergency financial intervention, but indicate the order management system is out of sync with reality (e.g., a refund was issued, but the order remains "Active").

---

## 🤖 LLM Explanation Layer

While the classification engine is strictly deterministic, interpreting *why* a discrepancy occurred can be time-consuming for non-technical operations staff. We built `POST /api/explain` to translate raw SQL/JSON data into plain English.

- **Prompt Structure:** The system prompt explicitly informs the model that the discrepancy has *already* been classified. It is provided with the exact math, the order JSON, and the payment JSON, and is strictly instructed *not* to recalculate or guess the match, but simply to translate the facts.
- **Temperature (0.2):** Set deliberately low. This is a grounded summarization task, not a creative writing exercise. We want the explanation to be highly factual and stable across reruns.
- **Structured Output:** We leverage OpenAI's JSON mode alongside a strict `Zod` schema (`{ summary, likelyCause, recommendedAction, confidence }`).
- **Safe Fallbacks:** The LLM is an enhancement, not a dependency. If the API key is missing, or if the OpenAI API goes down (the system automatically retries once on failure), the backend seamlessly catches the error and returns a locally generated deterministic explanation derived directly from the discrepancy fields, ensuring the UI never breaks.

---

## 🔮 Future Improvements

Given more than 24 hours, the following enhancements would be prioritized:
1. **Background Job Processing:** Moving the CSV parsing and reconciliation engine into a resilient background queue (e.g., Inngest or BullMQ) to support massive datasets without risking HTTP timeout limits.
2. **Audit Logging & Status Workflows:** Allowing operations staff to mark discrepancies as `RESOLVED` or `IGNORED`, accompanied by an immutable audit log tracking *who* resolved it and *when*.
3. **Role-Based Access Control (RBAC):** Implementing fine-grained permissions so only financial admins can trigger reconciliation, while support agents can only view discrepancies.
4. **Automated Gateway Actions:** Providing a button in the UI to automatically trigger a refund API call via Stripe/PayPal for flagged duplicate charges.

---

## 💡 A Note on AI Tooling
This application was rapidly prototyped and developed with the assistance of advanced agentic AI coding tools. AI was leveraged heavily for scaffolding boilerplate, writing unit tests, parsing complex CSV streams, and rapidly iterating on the Tailwind UI. However, the core architectural decisions—specifically the strict separation between the deterministic math engine and the generative LLM explanation layer, as well as the dynamic tolerance logic—were driven entirely by strict human-led engineering requirements to ensure financial integrity.
