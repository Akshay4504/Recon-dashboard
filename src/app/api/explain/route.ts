import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth-config";
import prisma from "@/lib/prisma";
import OpenAI from "openai";
import { z } from "zod";

const ExplainResponseSchema = z.object({
  summary: z.string(),
  likelyCause: z.string(),
  recommendedAction: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

type ExplainResponse = z.infer<typeof ExplainResponseSchema>;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "dummy",
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  try {
    const { discrepancyId } = await req.json();
    if (!discrepancyId) {
      return NextResponse.json({ error: "Missing discrepancyId" }, { status: 400 });
    }

    const discrepancy = await prisma.discrepancy.findUnique({
      where: { id: discrepancyId, userId },
      include: {
        order: true,
      },
    });

    if (!discrepancy) {
      return NextResponse.json({ error: "Discrepancy not found" }, { status: 404 });
    }

    let payments: any[] = [];
    if (discrepancy.order) {
      payments = await prisma.payment.findMany({
        where: { userId, orderReference: discrepancy.order.orderId },
      });
    }

    // Base fallback built from the discrepancy's own fields
    let fallbackCause = "The payment records do not align with the order's requirements.";
    if (typeof discrepancy.details === 'object' && discrepancy.details && 'reason' in discrepancy.details) {
      fallbackCause = String((discrepancy.details as Record<string, unknown>).reason);
    }

    const fallbackResponse: ExplainResponse = {
      summary: `A ${discrepancy.type} discrepancy was flagged by the reconciliation engine.`,
      likelyCause: fallbackCause,
      recommendedAction: "Review the attached order and payment records manually to verify the amounts and statuses.",
      confidence: "high",
    };

    if (!process.env.OPENAI_API_KEY) {
      console.warn("No OPENAI_API_KEY set, returning fallback explanation.");
      return NextResponse.json(fallbackResponse);
    }

    const prompt = `
You are a financial reconciliation assistant. Your job is to EXPLAIN a discrepancy that has ALREADY BEEN CLASSIFIED by a deterministic engine. 
DO NOT try to guess if the records match; accept the engine's classification as absolute fact.
Do not recommend taking action outside of the system unless necessary. Keep responses professional and brief.

Discrepancy Type: ${discrepancy.type}
Severity: ${discrepancy.severity}
Amount At Risk: ${discrepancy.amountAtRisk.toString()}
Engine Details: ${JSON.stringify(discrepancy.details)}

Context (Order):
${discrepancy.order ? JSON.stringify(discrepancy.order) : "No linked order."}

Context (Payments):
${payments.length ? JSON.stringify(payments) : "No matched payments."}

Respond ONLY with a JSON object structured exactly like this:
{
  "summary": "1-2 sentence simple explanation of what happened.",
  "likelyCause": "Why did this happen in the real world?",
  "recommendedAction": "What should the merchant do to fix it?",
  "confidence": "low" | "medium" | "high"
}
`;

    let result: ExplainResponse | null = null;
    let attempts = 0;

    while (attempts < 2 && !result) {
      attempts++;
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "You are a precise financial assistant." },
            { role: "user", content: prompt }
          ],
        });

        const content = completion.choices[0].message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          result = ExplainResponseSchema.parse(parsed);
        }
      } catch (err) {
        console.error(`OpenAI explanation attempt ${attempts} failed:`, err);
      }
    }

    if (result) {
      return NextResponse.json(result);
    } else {
      console.warn("Falling back to deterministic explanation after API failures.");
      return NextResponse.json(fallbackResponse);
    }

  } catch (error) {
    console.error("Explain API fatal error:", error);
    return NextResponse.json({
      summary: "System encountered an error generating the explanation.",
      likelyCause: "Unknown internal error",
      recommendedAction: "Review manually or try again later.",
      confidence: "low",
    });
  }
}
