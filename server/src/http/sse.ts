export type SseEventType =
  | "text-delta"
  | "tool-call"
  | "tool-result"
  | "approval-required"
  | "done";

export function sseEvent(type: SseEventType | string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
