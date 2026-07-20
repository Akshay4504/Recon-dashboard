import { auth } from "@/lib/auth-config";
import { redirect } from "next/navigation";
import { signOut } from "@/lib/auth-config";
import DashboardClient from "./dashboard-client";

export const metadata = {
  title: "Recon Dashboard",
  description: "Payment reconciliation overview",
};

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <DashboardClient
      userEmail={session.user.email ?? ""}
      signOutAction={handleSignOut}
    />
  );
}
