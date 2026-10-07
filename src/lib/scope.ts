// PLAN.md §3 scoping rule. Every data read filters through scopeFor(user).
// Never hand-write scoping in a page.
import type { Prisma, Role } from "@prisma/client";

export type ScopeUser = { id: string; role: Role; modelId: string | null };

export type Scope = {
  convo: Prisma.ConvoWhereInput;
  user: Prisma.UserWhereInput;
  tgAccount: Prisma.TgAccountWhereInput;
  payout: Prisma.PayoutWhereInput;
};

// Matches nothing. Used where a scope can't be built (e.g. a Lead VA with no model).
const NONE = { id: { in: [] as string[] } };

export function scopeFor(user: ScopeUser): Scope {
  switch (user.role) {
    case "DIRECTOR":
      return { convo: {}, user: {}, tgAccount: {}, payout: {} };

    case "LEAD_MANAGER": {
      const people: Prisma.UserWhereInput = {
        OR: [{ id: user.id }, { parentId: user.id }, { parent: { parentId: user.id } }],
      };
      return {
        convo: { leadManagerId: user.id },
        user: people,
        tgAccount: {
          OR: [
            { va: { parent: { parentId: user.id } } },
            // pool availability for the models their teams run
            { status: "AVAILABLE", model: { users: { some: { role: "LEAD_VA", parentId: user.id } } } },
          ],
        },
        payout: { user: people },
      };
    }

    case "LEAD_VA": {
      const people: Prisma.UserWhereInput = { OR: [{ id: user.id }, { parentId: user.id }] };
      return {
        convo: { leadVaId: user.id },
        user: people,
        tgAccount: {
          OR: [
            { va: { parentId: user.id } },
            // pool availability for the team's model; a missing modelId must not widen this
            user.modelId ? { status: "AVAILABLE", modelId: user.modelId } : NONE,
          ],
        },
        payout: { user: people },
      };
    }

    case "VA":
      return {
        convo: { vaId: user.id },
        user: { id: user.id },
        tgAccount: { vaId: user.id },
        payout: { userId: user.id },
      };
  }
}
