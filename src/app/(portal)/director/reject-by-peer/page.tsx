import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { RejectByPeerControls } from "./reject-controls";

export default async function RejectByPeerPage() {
  await requireRole("DIRECTOR");
  return (
    <>
      <TopBar title="Reject by list" emoji="🧹" />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reject convos from a list</CardTitle>
          <CardDescription>
            Correct convos the panel audit flagged as qualified with no real reply. Paste or upload the (tgAccount, peerId) pairs, preview, then
            reject. Convos in locked weeks are never changed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RejectByPeerControls />
        </CardContent>
      </Card>
    </>
  );
}
