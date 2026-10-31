import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore, conversationTitle, isConversationId } from "./history.js";

type Event = { type: string; text?: string };

const ID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002";

let dirs: string[] = [];
function store(): ConversationStore<Event> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyeda-history-"));
  dirs.push(dir);
  return new ConversationStore<Event>(dir);
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("conversationTitle", () => {
  it("uses the first user message, collapsed and shortened", () => {
    expect(conversationTitle([{ type: "assistant_text", text: "hi" }, { type: "user_message", text: "  Kiểm tra\n nguồn U3  " }])).toBe("Kiểm tra nguồn U3");
    expect(conversationTitle([{ type: "user_message", text: "x".repeat(200) }]).length).toBe(70);
    expect(conversationTitle([])).toBe("New conversation");
  });
});

describe("ConversationStore", () => {
  it("saves, lists newest first, loads and deletes conversations", async () => {
    const history = store();
    expect(history.save({ id: ID_A, createdAt: "2026-01-01T00:00:00.000Z", events: [{ type: "user_message", text: "first" }] }).created).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    history.save({ id: ID_B, createdAt: "2026-01-01T00:00:00.000Z", events: [{ type: "user_message", text: "second" }] });
    expect(history.save({ id: ID_A, createdAt: "2026-01-01T00:00:00.000Z", events: [{ type: "user_message", text: "first" }] }).created).toBe(false);

    expect(history.list().map((item) => item.title)).toEqual(["first", "second"]);
    expect(history.latest()?.id).toBe(ID_A);
    expect(history.load(ID_B)?.events).toEqual([{ type: "user_message", text: "second" }]);

    expect(history.delete(ID_A)).toBe(true);
    expect(history.list().map((item) => item.id)).toEqual([ID_B]);
  });

  it("rejects ids that are not Claude session ids, so paths cannot escape the folder", () => {
    const history = store();
    expect(isConversationId("../../etc/passwd")).toBe(false);
    expect(() => history.save({ id: "../x", createdAt: "", events: [] })).toThrow(/Invalid/);
    expect(history.load("../x")).toBeUndefined();
    expect(history.delete("../x")).toBe(false);
  });

  it("returns an empty list when nothing was saved yet", () => {
    expect(new ConversationStore(path.join(os.tmpdir(), "easyeda-history-missing-dir")).list()).toEqual([]);
  });
});
