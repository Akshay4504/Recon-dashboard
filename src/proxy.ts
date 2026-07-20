import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth-config";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const session = await auth();
  const isAuthenticated = !!session?.user?.id;

  const isProtectedApi =
    pathname.startsWith("/api/orders") ||
    pathname.startsWith("/api/payments") ||
    pathname.startsWith("/api/discrepancies") ||
    pathname.startsWith("/api/explain") ||
    pathname.startsWith("/api/import") ||
    pathname.startsWith("/api/summary") ||
    pathname.startsWith("/api/reconcile");

  if (isProtectedApi) {
    if (!isAuthenticated) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/dashboard")) {
    if (!isAuthenticated) {
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/api/orders/:path*",
    "/api/payments/:path*",
    "/api/discrepancies/:path*",
    "/api/explain/:path*",
    "/api/import/:path*",
    "/api/summary/:path*",
    "/api/summary",
    "/api/reconcile",
  ],
};