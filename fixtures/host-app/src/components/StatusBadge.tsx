interface StatusBadgeProps {
  status: "draft" | "open" | "paid";
}

const colors = {
  draft: "#6b7280",
  open: "#b45309",
  paid: "#047857",
} as const;

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      style={{
        background: colors[status],
        borderRadius: "999px",
        color: "white",
        fontSize: "0.75rem",
        padding: "0.2rem 0.55rem",
      }}
    >
      {status}
    </span>
  );
}
