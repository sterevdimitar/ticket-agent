export type TraceEntry =
  | { kind: "call"; toolCallId: string; toolName: string; args: unknown }
  | { kind: "result"; toolCallId: string; result: unknown };

/**
 * Everything here is rendered as escaped text inside <pre>. Tool args and results
 * are attacker-influenced; they are shown, never interpreted.
 */
export function ToolTrace({ entries }: { entries: TraceEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <aside className="tool-trace" data-testid="tool-trace">
      <h2>Tool trace</h2>
      <ol>
        {entries.map((e, i) => (
          <li key={`${e.toolCallId}-${e.kind}-${i}`} className={`trace-${e.kind}`}>
            {e.kind === "call" ? (
              <>
                <strong>→ {e.toolName}</strong>
                <pre>{JSON.stringify(e.args, null, 2)}</pre>
              </>
            ) : (
              <>
                <strong>← result</strong>
                <pre>{JSON.stringify(e.result, null, 2)}</pre>
              </>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}
