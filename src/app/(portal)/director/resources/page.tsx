import { FileIcon, LinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { isImage, SECTION_KEYS, SECTIONS } from "@/lib/resources";
import { scopeFor } from "@/lib/scope";
import { AddResourceForm, DeleteResourceButton } from "./resource-controls";

export default async function DirectorResourcesPage() {
  const user = await requireRole("DIRECTOR");
  const [models, resources] = await Promise.all([
    db.model.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.resource.findMany({
      where: scopeFor(user).resource,
      orderBy: [{ section: "asc" }, { category: "asc" }, { sort: "asc" }, { createdAt: "asc" }],
      include: { model: { select: { name: true } } },
    }),
  ]);
  const categories = [...new Set(resources.filter((r) => r.section === "MEDIA_POOL" && r.category).map((r) => r.category!))].sort();

  return (
    <>
      <TopBar title="Resources" emoji="📚" />
      <AddResourceForm models={models} categories={categories} />

      <div className="mt-6 space-y-4">
        {SECTION_KEYS.map((section) => {
          const items = resources.filter((r) => r.section === section);
          return (
            <Card key={section}>
              <CardHeader>
                <CardTitle className="text-base">
                  {SECTIONS[section].label} · {items.length}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                <ul className="divide-y">
                  {items.length === 0 && <li className="px-6 py-2 text-sm text-muted-foreground">Nothing yet.</li>}
                  {items.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-6 py-2">
                      <div className="flex min-w-0 items-center gap-3">
                        {isImage(r.filePath) ? (
                          // eslint-disable-next-line @next/next/no-img-element -- signed URL via our own redirect
                          <img src={`/files/${r.id}?inline=1`} alt="" className="size-10 shrink-0 rounded object-cover" loading="lazy" />
                        ) : r.filePath ? (
                          <FileIcon className="size-5 shrink-0 text-muted-foreground" />
                        ) : (
                          <LinkIcon className="size-5 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{r.title}</p>
                          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                            <Badge variant="outline">{r.model?.name ?? "All models"}</Badge>
                            {r.category && <Badge variant="secondary">{r.category}</Badge>}
                            {r.url && <span className="truncate">{r.url}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {r.filePath && (
                          <a href={`/files/${r.id}`} className="rounded-md px-2 py-1 text-xs font-medium hover:bg-muted">
                            Download
                          </a>
                        )}
                        <DeleteResourceButton id={r.id} title={r.title} />
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
