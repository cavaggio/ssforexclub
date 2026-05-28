/**
 * web/components/dashboard-nav.tsx
 *
 * In-header nav links for the authenticated dashboard. Lives in a small
 * client component so it can read `usePathname()` to highlight the active
 * route — the parent layout stays a Server Component.
 */

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard',          label: 'Dashboard' },
  { href: '/dashboard/settings', label: 'Settings'  },
];

export function DashboardNav() {
  const pathname = usePathname();
  return (
    <nav style={{ display: 'flex', gap: 8 }}>
      {LINKS.map((l) => {
        // Treat the dashboard root as exact-match to avoid both items
        // lighting up when on /dashboard/settings.
        const isActive = l.href === '/dashboard'
          ? pathname === '/dashboard'
          : pathname?.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 700,
              textDecoration: 'none',
              color: isActive ? 'var(--text)' : 'var(--muted)',
              background: isActive ? 'var(--border)' : 'transparent',
              border: '1px solid transparent',
            }}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
