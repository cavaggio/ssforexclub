export default function DashboardLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading trading dashboard"
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div style={{ width: 260, height: 30, borderRadius: 7, background: 'var(--panel)' }} />
      <div style={{ width: '70%', height: 16, borderRadius: 5, background: 'var(--panel)' }} />
      {[120, 170, 190].map((height) => (
        <section
          key={height}
          style={{
            height,
            borderRadius: 10,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
          }}
        />
      ))}
      <span style={{ color: 'var(--muted)', fontSize: 12 }}>Loading dashboard data…</span>
    </div>
  );
}
