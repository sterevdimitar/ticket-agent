export const TENANTS = ["tenant-a", "tenant-b"] as const;
export type TenantId = (typeof TENANTS)[number];

export function TenantSwitcher({
  tenantId,
  onChange,
}: {
  tenantId: TenantId;
  onChange: (t: TenantId) => void;
}) {
  return (
    <label className="tenant-switcher">
      Acting as{" "}
      <select
        data-testid="tenant-switcher"
        value={tenantId}
        onChange={(e) => onChange(e.target.value as TenantId)}
      >
        {TENANTS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}
