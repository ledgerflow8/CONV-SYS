// PLAN.md §3 scoping rule. Every data read filters through scopeFor(user).
// Never hand-write scoping in a page.
import type { Prisma, Role } from "@prisma/client";

export type ScopeUser = { id: string; role: Role; modelId: string | null };

export type Scope = {
  convo: Prisma.ConvoWhereInput;
  user: Prisma.UserWhereInput;
  tgAccount: Prisma.TgAccountWhereInput;
  payout: Prisma.PayoutWhereInput;
  resource: Prisma.ResourceWhereInput;
};

// Matches nothing. Used where a scope can't be built (e.g. a Lead VA with no model).
const NONE = { id: { in: [] as string[] } };

// Shared resources (modelId null) plus the user's own model. No model → shared only, never everything.
function forModel(modelId: string | null): Prisma.ResourceWhereInput {
  return modelId ? { OR: [{ modelId: null }, { modelId }] } : { modelId: null };
}

export function scopeFor(user: ScopeUser): Scope {
  switch (user.role) {
    case "DIRECTOR":
      return { convo: {}, user: {}, tgAccount: {}, payout: {}, resource: {} };

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
        // shared resources + the models their teams run
        resource: { OR: [{ modelId: null }, { model: { users: { some: { role: "LEAD_VA", parentId: user.id } } } }] },
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
        resource: forModel(user.modelId),
      };
    }

    case "VA":
      return {
        convo: { vaId: user.id },
        user: { id: user.id },
        tgAccount: { vaId: user.id },
        payout: { userId: user.id },
        resource: forModel(user.modelId),
      };
  }
}
