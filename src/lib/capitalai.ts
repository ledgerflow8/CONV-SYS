// CapitalAI (capitalbot.ai) — the AI chat engine running the models' Telegram accounts.
// It doesn't push events, so we pull: list recently updated conversations, read transcripts,
// and turn each into a ConvoEvent for ingestConvoEvent(). SERVER ONLY (license key).
// Endpoints used (see CapitalAI_Docs.md): POST /api/dashboard/search, POST /api/conversation.

const API = "https://api.capitalbot.ai";
const TIMEOUT_MS = 20_000;

export type SearchRow = {
  conversation_id: number;
  identifier: string;
  accountId: string;
  updated_at: string;
  conversation_started_at?: string | null;
};

export type TranscriptMessage = { role: string; content?: string; timestamp: string | null };
export type Conversation = {
  conversation: { id: number; identifier: string; accountId: string; platform?: string | null; startedAt?: string | null };
  transcript: TranscriptMessage[];
};

export class CapitalAIError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface CapitalAIClient {
  search(opts: { startDate: Date; offset: number }): Promise<{ rows: SearchRow[]; hasMore: boolean }>;
  conversation(conversationId: number): Promise<Conversation | null>;
}

function licenseKey(): string {
  const key = process.env.CAPITALAI_LICENSE_KEY;
  if (!key) throw new CapitalAIError("CAPITALAI_LICENSE_KEY isn't set.", 0);
  return key;
}

async function post<T>(path: string, body: object): Promise<T> {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ licensekey: licenseKey(), ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    const msg = typeof json.error === "string" ? json.error : typeof json.message === "string" ? json.message : text.slice(0, 200);
    throw new CapitalAIError(`CapitalAI ${path}: ${res.status} ${msg}`, res.status);
  }
  return json as T;
}

const httpClient: CapitalAIClient = {
  async search({ startDate, offset }) {
    // ctaReceived defaults to true on their side; we need every conversation.
    const r = await post<{ conversations?: SearchRow[]; hasMore?: boolean }>("/api/dashboard/search", {
      startDate: startDate.toISOString(),
      ctaReceived: false,
      offset,
    });
    return { rows: r.conversations ?? [], hasMore: !!r.hasMore };
  },
  async conversation(conversationId) {
    try {
      return await post<Conversation>("/api/conversation", { conversationId });
    } catch (e) {
      if (e instanceof CapitalAIError && e.status === 404) return null;
      throw e;
    }
  },
};

let impl: CapitalAIClient = httpClient;
export const capitalAI = (): CapitalAIClient => impl;
/** Tests only. */
export function setCapitalAIForTests(c: CapitalAIClient | null) {
  impl = c ?? httpClient;
}

const FAN = new Set(["user"]);
const MODEL = new Set(["assistant", "bot"]);

/**
 * PLAN.md §4 event from a CapitalAI transcript:
 * firstMsgAt = the fan's first message; repliedAt = the account's first message after it.
 * Works whether the fan or the AI (opener) wrote first. Null if the fan never wrote.
 */
export function toConvoEvent(conv: Conversation, tgAccount: string) {
  const timed = conv.transcript
    .filter((m) => m.timestamp && !Number.isNaN(Date.parse(m.timestamp)))
    .map((m) => ({ role: m.role.toLowerCase(), at: new Date(m.timestamp!) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const firstFan = timed.find((m) => FAN.has(m.role));
  if (!firstFan) return null;
  const reply = timed.find((m) => MODEL.has(m.role) && m.at >= firstFan.at);

  return {
    tgAccount,
    peerId: String(conv.conversation.identifier),
    firstMsgAt: firstFan.at.toISOString(),
    repliedAt: reply?.at.toISOString(),
  };
}

/** CapitalAI accountId → our pool's lowercase username form. */
export function normalizeAccountId(accountId: string): string {
  return accountId.trim().replace(/^@/, "").toLowerCase();
}
