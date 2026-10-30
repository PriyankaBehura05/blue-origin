import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '@/services';
import { useAsync } from '@/hooks/useAsync';
import { setTheme, useTheme } from '@/hooks/useTheme';
import { NETWORK_PAGES } from '@/pages/NetworkPage';
import type { HealthStatus } from '@/types';
import { clearSession, updateUser, useSession } from '@/services/session';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ChangePassword } from '@/components/ChangePassword';
import logo from '@/assets/technosport-logo.png';

const NAV = [
  { to: '/sales', label: 'Sales', icon: '₹' },
  { to: '/retailers', label: 'Retailers', icon: '🏬' },
  { to: '/distributors', label: 'Distributors', icon: '🚚' },
  { to: '/tiers', label: 'Tiers', icon: '◆' },
  { to: '/benefits', label: 'Benefits', icon: '🎁' },
  { to: '/reports', label: 'Reports', icon: '📄' },
  { to: '/data', label: 'Data', icon: '⇪' },
];

function StoreChip({ health, error }: { health: HealthStatus | undefined; error: string | null }) {
  if (error) return <span className="store-chip bad" title={error}>● API unreachable</span>;
  if (!health) return <span className="store-chip">● Connecting…</span>;
  return health.store_ok ? (
    <span className="store-chip ok" title={health.store ?? ''}>● {health.data_source === 'dropbox' ? 'Dropbox' : 'Local store'} connected</span>
  ) : (
    <span className="store-chip bad" title={health.store_error ?? ''}>● Data store unavailable</span>
  );
}

// Shown instead of the pages while the backend or the data store cannot be used.
function SetupRequired({ health, error, onRetry, retrying }: { health: HealthStatus | undefined; error: string | null; onRetry: () => void; retrying: boolean }) {
  const apiDown = Boolean(error);
  const notConfigured = !apiDown && /not configured/i.test(health?.store_error ?? '');
  return (
    <div className="card card-pad setup">
      <h2>{apiDown ? 'The backend is not running' : notConfigured ? 'Connect Dropbox to get started' : 'Dropbox could not be reached'}</h2>
      <p className="note">{apiDown ? error : health?.store_error}</p>
      {apiDown ? (
        <ol>
          <li>Open a terminal in <code>backend</code></li>
          <li>Run <code>.venv\Scripts\Activate.ps1</code> then <code>uvicorn app.main:app --reload --port 8000</code></li>
        </ol>
      ) : notConfigured ? (
        <ol>
          <li>Create a Dropbox app at <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noreferrer">dropbox.com/developers/apps</a> (Scoped access → App folder) and enable <code>files.content.read</code>, <code>files.content.write</code>, <code>files.metadata.read</code>.</li>
          <li>In <code>backend</code> run <code>python scripts/dropbox_auth.py &lt;APP_KEY&gt; &lt;APP_SECRET&gt;</code> — it saves the keys into <code>backend/.env</code>. (Or fill the <code>DROPBOX_*</code> lines in <code>backend/.env</code> yourself.)</li>
          <li>Restart the backend, then drop your Excel files into <code>Apps/&lt;your app&gt;/blue-origin/inbox/</code> in Dropbox.</li>
        </ol>
      ) : (
        <ul>
          <li>Check the internet connection and that the <code>DROPBOX_*</code> keys in <code>backend/.env</code> are still valid.</li>
          <li>A short-lived <code>DROPBOX_ACCESS_TOKEN</code> expires after ~4 hours — use <code>scripts/dropbox_auth.py</code> for a permanent refresh token.</li>
        </ul>
      )}
      <div><button className="btn primary" onClick={onRetry} disabled={retrying}>{retrying ? 'Checking…' : 'Check again'}</button></div>
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer (view only)' };

// Signed-in user in the top bar: change password, sign out.
function UserMenu() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  // refresh name / role once per visit (also signs out at once if the account was deactivated)
  useEffect(() => {
    api.getMe().then(updateUser).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  if (!session) return null;
  const u = session.user;
  const initials = u.name.split(/s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="user-menu">
      <button className="menu-btn user-btn" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} aria-haspopup="menu" aria-expanded={open}>
        <span className="avatar">{initials}</span>
        <span className="uname">{u.name}</span>
      </button>
      {open && (
        <div className="user-pop" role="menu" onClick={(e) => e.stopPropagation()}>
          <div className="who"><strong>{u.name}</strong><div className="note">{u.email} · {ROLE_LABEL[u.role] ?? u.role}</div></div>
          <button role="menuitem" onClick={() => { setOpen(false); setChanging(true); }}>Change password</button>
          <button role="menuitem" onClick={() => clearSession()}>Sign out</button>
        </div>
      )}
      {changing && <ChangePassword onClose={() => setChanging(false)} />}
    </div>
  );
}

const SIDEBAR_KEY = 'bo_sidebar_hidden';

function readHidden(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

export function Layout() {
  const [open, setOpen] = useState(false); // phone: sidebar slides over the page
  const [hidden, setHidden] = useState(readHidden); // desktop: sidebar hidden / shown
  const toggleSidebar = () => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      setOpen((o) => !o);
      return;
    }
    setHidden((h) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, h ? '0' : '1');
      } catch {
        /* preference not saved */
      }
      return !h;
    });
  };
  const theme = useTheme();
  const { pathname } = useLocation();
  const isAdmin = useSession()?.user.role === 'admin';
  const health = useAsync(() => api.getHealth(), []);
  const ready = !health.error && health.data?.store_ok === true;
  const { reload } = health;

  // Keep checking while the store is unavailable so the app recovers by itself once it is fixed.
  useEffect(() => {
    if (ready || health.loading) return;
    const t = setTimeout(reload, 10000);
    return () => clearTimeout(t);
  }, [ready, health.loading, reload]);

  return (
    <div className={`app ${hidden ? 'sidebar-hidden' : ''}`}>
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand-logo">
          <img src={logo} alt="TechnoSport" />
        </div>
        <div className="brand">BLUE ORIGIN</div>
        <div className="brand-sub">Sales & Retailer Growth</div>
        <nav className="nav-scroll" aria-label="Pages">
          <div className="nav-h">BO Dashboard</div>
          {NETWORK_PAGES.map((p) => (
            <NavLink key={p.slug} to={`/dashboard/${p.slug}`} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setOpen(false)}>
              <span className="nav-icon">{p.icon}</span>
              {p.label}
              {p.badge && <span className="nav-badge">{p.badge}</span>}
            </NavLink>
          ))}
          <div className="nav-h">Manage</div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setOpen(false)}>
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
          {isAdmin && (
            <NavLink to="/users" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setOpen(false)}>
              <span className="nav-icon">👥</span>
              Users
            </NavLink>
          )}
        </nav>
        <div className="sidebar-foot">TechnoSport · v0.3</div>
      </aside>
      {open && <div className="drawer-backdrop sidebar-scrim" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="menu-btn" onClick={toggleSidebar} aria-label={hidden ? 'Show sidebar' : 'Hide sidebar'} title={hidden ? 'Show sidebar' : 'Hide sidebar'}>☰</button>
          <StoreChip health={health.data} error={health.error} />
          <button className="menu-btn theme-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
          <UserMenu />
        </header>
        <main className="content">
          {ready ? (
            <ErrorBoundary key={pathname.startsWith('/dashboard') ? '/dashboard' : pathname /* dashboard tabs share state */}>
              <Outlet />
            </ErrorBoundary>
          ) : !health.data && !health.error ? (
            <div className="empty">Connecting to the data store…</div>
          ) : (
            <SetupRequired health={health.data} error={health.error} onRetry={reload} retrying={health.loading} />
          )}
        </main>
      </div>
    </div>
  );
}
