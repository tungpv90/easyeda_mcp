import fs from "node:fs";
import path from "node:path";

/**
 * Saved chat panel conversations, one JSON file per Claude Code session id. The panel
 * transcript lives here; Claude's own context is restored by `claude --resume <id>`.
 */

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type StoredConversation<TEvent> = ConversationSummary & {
  createdAt: string;
  model?: string;
  events: TEvent[];
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LISTED = 100;
const TITLE_CHARS = 70;

export function isConversationId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID.test(id);
}

export function conversationTitle(events: Array<{ type: string; text?: unknown }>): string {
  const first = events.find((event) => event.type === "user_message" && typeof event.text === "string");
  const text = typeof first?.text === "string" ? first.text.replace(/\s+/g, " ").trim() : "";
  if (!text) {
    return "New conversation";
  }
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1)}…` : text;
}

export class ConversationStore<TEvent extends { type: string }> {
  constructor(private readonly dir: string) {}

  save(conversation: Omit<StoredConversation<TEvent>, "title" | "updatedAt">): { created: boolean; title: string } {
    if (!isConversationId(conversation.id)) {
      throw new Error(`Invalid conversation id: ${conversation.id}`);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(conversation.id);
    const created = !fs.existsSync(file);
    const title = conversationTitle(conversation.events as Array<{ type: string; text?: unknown }>);
    const record: StoredConversation<TEvent> = { ...conversation, title, updatedAt: new Date().toISOString() };
    // Write then rename so a crash mid-write never leaves a truncated file.
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record));
    fs.renameSync(temp, file);
    return { created, title };
  }

  load(id: string): StoredConversation<TEvent> | undefined {
    if (!isConversationId(id)) {
      return undefined;
    }
    try {
      return JSON.parse(fs.readFileSync(this.file(id), "utf8")) as StoredConversation<TEvent>;
    } catch {
      return undefined;
    }
  }

  delete(id: string): boolean {
    if (!isConversationId(id)) {
      return false;
    }
    try {
      fs.unlinkSync(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  list(): ConversationSummary[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const summaries: ConversationSummary[] = [];
    for (const name of names) {
      const stored = this.load(name.slice(0, -".json".length));
      if (stored) {
        summaries.push({ id: stored.id, title: stored.title, updatedAt: stored.updatedAt });
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_LISTED);
  }

  latest(): StoredConversation<TEvent> | undefined {
    const [first] = this.list();
    return first ? this.load(first.id) : undefined;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }
}
