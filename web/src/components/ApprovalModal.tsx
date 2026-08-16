import type { ServerView } from "../api/streamClient.js";

export type PendingApproval = {
  approvalId: string;
  action: string;
  ticketId: string;
  serverView: ServerView;
};

/**
 * Every fact shown here comes from the server's `serverView`, not from the model's
 * description of what it is about to do. The modal blocks the rest of the UI until
 * the human decides — there is no dismiss and no default.
 */
export function ApprovalModal({
  pending,
  busy,
  onDecide,
}: {
  pending: PendingApproval;
  busy: boolean;
  onDecide: (approved: boolean) => void;
}) {
  const { serverView, action, ticketId } = pending;
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className={`modal${serverView.danger ? " modal-danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-heading"
        data-testid="approval-modal"
      >
        <h2 id="approval-heading">
          {serverView.danger ? "Confirm deletion" : "Confirm change"}
        </h2>
        <dl>
          <dt>Ticket</dt>
          <dd data-testid="approval-ticket">
            {ticketId} — {serverView.title}
          </dd>
          <dt>Current status</dt>
          <dd>{serverView.currentStatus}</dd>
          <dt>Action</dt>
          <dd data-testid="approval-action">{action}</dd>
          <dt>Change</dt>
          <dd>
            <pre data-testid="approval-diff">
              {serverView.diff ?? "This ticket will be permanently deleted."}
            </pre>
          </dd>
        </dl>
        <p className="modal-note">
          These details come from the server record, not from the assistant's message.
        </p>
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => onDecide(false)}>
            Decline
          </button>
          <button
            type="button"
            disabled={busy}
            className={serverView.danger ? "danger" : "primary"}
            onClick={() => onDecide(true)}
          >
            {serverView.danger ? "Delete ticket" : "Approve change"}
          </button>
        </div>
      </div>
    </div>
  );
}
