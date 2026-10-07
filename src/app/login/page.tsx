import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ROLE_HOME } from "@/lib/auth/roles";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect(ROLE_HOME[user.role]);

  return (
    <div className="grid min-h-dvh place-items-center bg-linear-to-br from-indigo-500 via-purple-500 to-pink-500 px-4">
      <Card className="w-full max-w-sm shadow-xl">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-2 grid size-14 place-items-center rounded-2xl bg-primary text-primary-foreground">
            <Users className="size-7" />
          </div>
          <CardTitle className="text-xl">VA Portal</CardTitle>
          <CardDescription>Log in to your dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </div>
  );
}
