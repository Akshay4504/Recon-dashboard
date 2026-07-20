import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth-config";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // TODO: query orders scoped to session.user.id
  return NextResponse.json({ orders: [], userId: session.user.id });
}
