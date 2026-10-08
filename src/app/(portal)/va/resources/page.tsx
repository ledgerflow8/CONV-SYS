import { ChevronDown, Download, ExternalLink, FileIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { CopyButton } from "@/components/copy-button";
import { TopBar } from "@/components/shell/top-bar";
import { requireRole } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { trackingUrl } from "@/lib/links";
import { isImage, SECTIONS, type Section } from "@/lib/resources";
import { scopeFor } from "@/lib/scope";

type Res = { id: string; title: string; url: string | null; filePath: string | null; category: string | null };

export default async function VaResourcesPage() {
  const user = await requireRole("VA");
  const scope = scopeFor(user);
  const [account, link, resources] = await Promise.all([
    db.tgAccount.findFirst({ where: { AND: [scope.tgAccount, { status: "ASSIGNED" }] }, select: { username: true, phone: true, link: true } }),
    db.trackingLink.findFirst({ where: { vaId: user.id, active: true }, select: { slug: true } }),
    db.resource.findMany({
      where: scope.resource,
      orderBy: [{ category: "asc" }, { sort: "asc" }, { createdAt: "asc" }],
      select: { id: true, section: true, title: true, url: true, filePath: true, category: true },
    }),
  ]);
  const of = (s: Section) => resources.filter((r) => r.section === s);
  const pool = of("MEDIA_POOL");
  const poolCategories = [...new Set(pool.map((r) => r.category ?? "Other"))];

  return (
    <>
      <TopBar title="Resources" emoji="📚" />

      <Card className="mb-4">
        <CardContent className="space-y-3">
          {account ? (
            <>
              <Row label="Your Telegram" value={`@${account.username}`} />
              <Row label="Number" value={account.phone} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No Telegram account assigned right now.</p>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <Section title={SECTIONS.SOP.label} count={of("SOP").length} open>
          <ItemList items={of("SOP")} />
        </Section>

        <Section title="VA-specific links" count={link ? 1 : 0}>
          {link ? <Row label="Your tracking link" value={trackingUrl(link.slug)} /> : <Empty />}
        </Section>

        <Section title="TG-specific links" count={account ? 1 : 0}>
          {account ? (
            <div className="flex items-center justify-between gap-2">
              <a href={account.link} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sm font-medium hover:underline">
                {account.link} <ExternalLink className="size-3" />
              </a>
              <CopyButton value={account.link} />
            </div>
          ) : (
            <Empty />
          )}
        </Section>

        <Section title={SECTIONS.TG_MEDIA.label} count={of("TG_MEDIA").length}>
          <MediaGrid items={of("TG_MEDIA")} />
        </Section>

        <Section title={SECTIONS.CREATOR_TEMPLATE.label} count={of("CREATOR_TEMPLATE").length}>
          <ItemList items={of("CREATOR_TEMPLATE")} />
        </Section>

        <Section title={SECTIONS.MEDIA_POOL.label} count={pool.length}>
          {pool.length === 0 && <Empty />}
          <div className="space-y-4">
            {poolCategories.map((c) => (
              <div key={c}>
                <h3 className="mb-2 text-sm font-semibold">{c}</h3>
                <MediaGrid items={pool.filter((r) => (r.category ?? "Other") === c)} />
              </div>
            ))}
          </div>
        </Section>
      </div>
    </>
  );
}

function Section({ title, count, open, children }: { title: string; count: number; open?: boolean; children: React.ReactNode }) {
  return (
    <Card className="py-0">
      <details className="group" open={open}>
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4">
          <span className="font-semibold">
            {title} <span className="text-sm font-normal text-muted-foreground">· {count}</span>
          </span>
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="border-t px-5 py-4">{children}</div>
      </details>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-medium break-all">{value}</div>
      </div>
      <CopyButton value={value} />
    </div>
  );
}

const Empty = () => <p className="text-sm text-muted-foreground">Nothing here yet.</p>;

function ItemList({ items }: { items: Res[] }) {
  if (items.length === 0) return <Empty />;
  return (
    <ul className="space-y-2">
      {items.map((r) => (
        <li key={r.id}>
          <a
            href={r.url ?? `/files/${r.id}`}
            {...(r.url ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted"
          >
            <span className="flex min-w-0 items-center gap-2">
              {r.url ? <ExternalLink className="size-4 shrink-0" /> : <FileIcon className="size-4 shrink-0" />}
              <span className="truncate">{r.title}</span>
            </span>
            {!r.url && <Download className="size-4 shrink-0 text-muted-foreground" />}
          </a>
        </li>
      ))}
    </ul>
  );
}

function MediaGrid({ items }: { items: Res[] }) {
  if (items.length === 0) return <Empty />;
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {items.map((r) => (
        <li key={r.id} className="overflow-hidden rounded-lg border">
          {isImage(r.filePath) ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed URL via our own scoped redirect
            <img src={`/files/${r.id}?inline=1`} alt={r.title} className="aspect-square w-full object-cover" loading="lazy" />
          ) : (
            <div className="grid aspect-square place-items-center bg-muted">
              <FileIcon className="size-8 text-muted-foreground" />
            </div>
          )}
          <a href={`/files/${r.id}`} className="flex items-center justify-between gap-1 px-2 py-1.5 text-xs font-medium hover:bg-muted">
            <span className="truncate">{r.title}</span>
            <Download className="size-3.5 shrink-0" />
          </a>
        </li>
      ))}
    </ul>
  );
}
