import { useState } from "react";
import { SafeMarkdown } from "../render/safeMarkdown.js";

/** `bubble` identifies which assistant bubble a delta belongs to; App sets it, nothing renders it. */
export type ChatMessage = { role: "user" | "assistant"; text: string; bubble?: string };

export function ChatPane({
  messages,
  busy,
  blocked,
  onSend,
}: {
  messages: ChatMessage[];
  busy: boolean;
  blocked: boolean;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || blocked) return;
    setDraft("");
    onSend(text);
  }

  return (
    <section className="chat-pane">
      <ol className="messages" data-testid="messages">
        {messages.map((m, i) => (
          <li key={i} className={`message message-${m.role}`}>
            <span className="role">{m.role === "user" ? "You" : "Assistant"}</span>
            {/* Assistant text is attacker-influenced — always via SafeMarkdown. */}
            {m.role === "assistant" ? <SafeMarkdown>{m.text}</SafeMarkdown> : <p>{m.text}</p>}
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="composer">
        <input
          data-testid="chat-input"
          value={draft}
          placeholder={blocked ? "Decide on the pending approval first" : "Ask about your tickets…"}
          disabled={busy || blocked}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={busy || blocked || draft.trim() === ""}>
          Send
        </button>
      </form>
    </section>
  );
}
