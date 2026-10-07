import { Card, CardContent } from "@/components/ui/card";

export function ComingSoon({ block }: { block?: number }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-sm text-muted-foreground">
        Not built yet{block ? ` (Block ${block})` : ""}.
      </CardContent>
    </Card>
  );
}
