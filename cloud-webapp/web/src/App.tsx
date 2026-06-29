import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { continueAsGuest, signInWithGoogle, signOutUser } from './lib/firebase.js';
import { useAuth } from './lib/useAuth.js';
import { useSession } from './lib/useSession.js';
import { LangToggle, useStrings } from './lib/i18n.js';
import { clearStoredName, setStoredName } from './lib/userName.js';
import { isInAppBrowser } from './lib/inAppBrowser.js';
import { InAppBrowserWarning } from './components/InAppBrowserWarning.js';
import { Footer } from './components/Footer.js';

/** Inline brand glyph (folder + lens) — placeholder until a real logo asset. */
function BrandMark({ className = 'brand-mark' }: { className?: string }): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.1c.4 0 .79.16 1.07.44L11 6.8h8.5A1.5 1.5 0 0 1 21 8.3v9.2A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z"
        fill="currentColor"
        opacity="0.18"
      />
      <path
        d="M3 8.3A1.5 1.5 0 0 1 4.5 6.8h15A1.5 1.5 0 0 1 21 8.3v9.2A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5V8.3Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="13" r="3.1" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="13" r="1.1" fill="currentColor" />
    </svg>
  );
}

/** Hamburger (three bars) that morphs to an X when the menu is open. */
function MenuIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {open ? (
        <>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </>
      ) : (
        <>
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </>
      )}
    </svg>
  );
}

/**
 * A grouped nav dropdown ("Manage ▾" / "Insights ▾"). Collapses several admin
 * links under one trigger so the header stays short and the title keeps its
 * space. On desktop the panel is an absolutely-positioned card; inside the
 * mobile slide-down menu it expands inline. Closes on outside click / Escape
 * and whenever a link inside it is chosen.
 */
function NavMenu({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={`nav-menu${open ? ' open' : ''}`} ref={ref}>
      <button
        type="button"
        className="nav-link nav-menu-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <span className="nav-caret" aria-hidden="true">▾</span>
      </button>
      {/* Clicking any link inside also collapses this group. */}
      <div className="nav-menu-panel" role="menu" onClick={() => setOpen(false)}>
        {children}
      </div>
    </div>
  );
}

const STR = {
  en: {
    title: 'FindMe',
    tagline: 'Browse event photos and find yourself with Find Me.',
    nav: {
      galleries: 'Galleries',
      myData: 'My data',
      events: 'Events',
      users: 'Users',
      clubs: 'Clubs',
      feedback: 'Match feedback',
      metrics: 'Metrics',
      report: 'Report',
      trash: 'Trash',
      audit: 'Audit',
      folders: 'Folders',
      email: 'Email settings',
      manage: 'Manage',
      insights: 'Insights',
    },
    menu: 'Menu',
    guest: 'Guest',
    signInGoogle: 'Sign in with Google',
    yourNameRequired: 'Your name (required)',
    namePlaceholder: 'e.g. Jamie Lee',
    nameHint: 'Shown to event organizers so they know who searched.',
    continue: 'Continue',
    exitGuest: 'Exit guest',
    signOut: 'Sign out',
    loading: 'Loading…',
    guestError:
      'Could not start a guest session. Ask an admin to enable Anonymous sign-in in Firebase.',
  },
  zh: {
    title: '一键找我',
    tagline: '浏览活动照片，并用人脸识别找到照片中的自己。',
    nav: {
      galleries: '相册',
      myData: '我的数据',
      events: '活动',
      users: '用户',
      clubs: '俱乐部',
      feedback: '匹配反馈',
      metrics: '指标',
      report: '报告',
      trash: '回收站',
      audit: '审计',
      folders: '文件夹',
      email: '邮件设置',
      manage: '管理',
      insights: '概览',
    },
    menu: '菜单',
    guest: '访客',
    signInGoogle: '使用 Google 登录',
    yourNameRequired: '您的姓名（必填）',
    namePlaceholder: '例如：张三',
    nameHint: '此姓名会提供给活动主办方，以便了解是谁进行了搜索。',
    continue: '继续',
    exitGuest: '退出访客',
    signOut: '退出登录',
    loading: '加载中…',
    guestError: '无法开始访客会话，请联系管理员在 Firebase 中启用匿名登录。',
  },
};
import { Events } from './pages/Events.js';
import { Gallery } from './pages/Gallery.js';
import { FindMe } from './pages/FindMe.js';
import { FeedbackAdmin } from './pages/FeedbackAdmin.js';
import { AdminUsers } from './pages/AdminUsers.js';
import { AdminClubs } from './pages/AdminClubs.js';
import { AdminEvents } from './pages/AdminEvents.js';
import { AdminLinks } from './pages/AdminLinks.js';
import { AdminAudit } from './pages/AdminAudit.js';
import { EmailPrefs } from './pages/EmailPrefs.js';
import { AdminSummary } from './pages/AdminSummary.js';
import { AdminManagedFolders } from './pages/AdminManagedFolders.js';
import { DeletedFiles } from './pages/DeletedFiles.js';
import { AdminMetrics } from './pages/AdminMetrics.js';
import { MyData } from './pages/MyData.js';
import { VolunteerUpload } from './pages/VolunteerUpload.js';

export function App(): JSX.Element {
  const { user, loading } = useAuth();
  const [signInError, setSignInError] = useState<string | null>(null);
  const [inApp] = useState(() => isInAppBrowser());
  const [menuOpen, setMenuOpen] = useState(false);
  const [guestName, setGuestName] = useState('');
  const headerRef = useRef<HTMLElement>(null);
  const t = useStrings(STR);
  const isGuest = Boolean(user?.isAnonymous);
  // Control-plane role drives which menu items appear (super_admin → all;
  // club_admin → the pages the API lets them open; member/guest → none).
  const { role } = useSession(user);
  const isSuperAdmin = role === 'super_admin';
  const isAdmin = role === 'super_admin' || role === 'club_admin';
  const closeMenu = (): void => setMenuOpen(false);
  const guestNameOk = guestName.trim().length > 0;

  // Sign out / exit guest: also forget the remembered searcher name so the next
  // person on a shared device starts fresh.
  function signOutAndForget(): void {
    clearStoredName();
    void signOutUser();
  }

  // Close the collapsed menu when tapping outside the header or pressing Escape.
  // Links close it via their own onClick; this covers everything else.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent): void {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  async function guest(): Promise<void> {
    if (!guestNameOk) return;
    setSignInError(null);
    // Remember the name first so it's already in place when the routed pages
    // (Find Me) mount and read it — no need to ask for it again.
    setStoredName(guestName);
    try {
      await continueAsGuest();
    } catch (err) {
      // Most likely cause: Anonymous sign-in not enabled in the Firebase console.
      setSignInError(t.guestError);
      console.error('anonymous sign-in failed', err);
    }
  }

  // App chrome + auth gate, applied to every signed-in page via <Outlet/>. The
  // public volunteer upload route sits OUTSIDE this layout so it renders with
  // no header and no sign-in requirement.
  const layout = (
    <main className="page">
      <header className="app-header" ref={headerRef}>
        <Link to="/" className="app-title" onClick={closeMenu}>
          <BrandMark />
          <h1>{t.title}</h1>
        </Link>
        <div className="header-controls">
          <LangToggle />
          {user && (
            <button
              type="button"
              className="nav-toggle"
              aria-label={t.menu}
              aria-expanded={menuOpen}
              aria-controls="app-nav"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <MenuIcon open={menuOpen} />
            </button>
          )}
        </div>
        {user && (
          <nav id="app-nav" className={`app-nav${menuOpen ? ' open' : ''}`}>
            {/* Everyone: the galleries dashboard (home) + their own data. */}
            <Link to="/" className="nav-link" onClick={closeMenu}>
              {t.nav.galleries}
            </Link>
            <Link to="/me/data" className="nav-link" onClick={closeMenu}>
              {t.nav.myData}
            </Link>

            {/* Any admin (super_admin or club_admin): operational pages grouped
                under "Manage". "Events" here means event configuration. */}
            {isAdmin && (
              <>
                <span className="nav-sep" aria-hidden="true" />
                <NavMenu label={t.nav.manage}>
                  <Link to="/admin/events" className="nav-link" onClick={closeMenu}>
                    {t.nav.events}
                  </Link>
                  <Link to="/admin/users" className="nav-link" onClick={closeMenu}>
                    {t.nav.users}
                  </Link>
                  <Link to="/admin/clubs" className="nav-link" onClick={closeMenu}>
                    {t.nav.clubs}
                  </Link>
                  <Link to="/admin/folders" className="nav-link" onClick={closeMenu}>
                    {t.nav.folders}
                  </Link>
                  <Link to="/admin/deleted" className="nav-link" onClick={closeMenu}>
                    {t.nav.trash}
                  </Link>
                  <Link to="/me/email" className="nav-link" onClick={closeMenu}>
                    {t.nav.email}
                  </Link>
                </NavMenu>

                {/* Read-only oversight grouped under "Insights": Report for any
                    admin; Metrics / Feedback / Audit for super_admins only. */}
                <NavMenu label={t.nav.insights}>
                  <Link to="/admin/summary" className="nav-link" onClick={closeMenu}>
                    {t.nav.report}
                  </Link>
                  {isSuperAdmin && (
                    <>
                      <Link to="/admin/metrics" className="nav-link" onClick={closeMenu}>
                        {t.nav.metrics}
                      </Link>
                      <Link to="/admin/feedback" className="nav-link" onClick={closeMenu}>
                        {t.nav.feedback}
                      </Link>
                      <Link to="/admin/audit" className="nav-link" onClick={closeMenu}>
                        {t.nav.audit}
                      </Link>
                    </>
                  )}
                </NavMenu>
              </>
            )}

            <span className="nav-sep" aria-hidden="true" />
            {isGuest ? (
              <>
                <span className="muted">{t.guest}</span>
                <button className="btn btn-light btn-sm" onClick={() => void signInWithGoogle()}>
                  {t.signInGoogle}
                </button>
              </>
            ) : (
              <span className="muted">{user.email}</span>
            )}
            <button className="btn btn-light btn-sm" onClick={signOutAndForget}>
              {isGuest ? t.exitGuest : t.signOut}
            </button>
          </nav>
        )}
      </header>

      {loading ? (
        <p className="muted">{t.loading}</p>
      ) : user ? (
        <Outlet />
      ) : (
        <div className="signin-screen">
          <div className="signin-card">
            <BrandMark className="brand-mark brand-mark-lg" />
            <h2>{t.title}</h2>
            <p className="muted">{t.tagline}</p>

            {/* WeChat & other in-app webviews: Google OAuth 403s here. Always
                bilingual. */}
            {inApp && <InAppBrowserWarning />}

            {/* Name is captured once here and remembered for the session, so
                Find Me never has to ask for it again. */}
            <form
              className="signin-name"
              onSubmit={(e) => {
                e.preventDefault();
                void guest();
              }}
            >
              <label htmlFor="guest-name">{t.yourNameRequired}</label>
              <input
                id="guest-name"
                type="text"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder={t.namePlaceholder}
                maxLength={120}
                autoComplete="name"
                required
                aria-required="true"
              />
              <span className="field-hint muted">{t.nameHint}</span>
              <button className="btn btn-primary" type="submit" disabled={!guestNameOk}>
                {t.continue}
              </button>
            </form>
            {!inApp && (
              <button className="btn btn-light btn-google" onClick={() => void signInWithGoogle()}>
                {t.signInGoogle}
              </button>
            )}
            {signInError && <p className="error-text">{signInError}</p>}
          </div>
        </div>
      )}

      <Footer />
    </main>
  );

  return (
    <BrowserRouter>
      <Routes>
        {/* Public, link-token-gated volunteer upload — no sign-in, no app
            chrome. Validated server-side against the Upload_Links sheet. */}
        <Route path="/upload/:token" element={<VolunteerUpload />} />
        <Route element={layout}>
          <Route path="/" element={<Events isGuest={isGuest} />} />
          <Route path="/events/:eventId" element={<Gallery />} />
          <Route path="/events/:eventId/findme" element={<FindMe />} />
          {/* Admin-only: guests have no admin email, so bounce them home
              instead of rendering an empty page the API would 403 anyway. */}
          <Route
            path="/admin/feedback"
            element={isGuest ? <Navigate to="/" replace /> : <FeedbackAdmin />}
          />
          <Route path="/admin/users" element={isGuest ? <Navigate to="/" replace /> : <AdminUsers />} />
          <Route path="/admin/clubs" element={isGuest ? <Navigate to="/" replace /> : <AdminClubs />} />
          <Route path="/admin/events" element={isGuest ? <Navigate to="/" replace /> : <AdminEvents />} />
          <Route
            path="/admin/events/:eventId/links"
            element={isGuest ? <Navigate to="/" replace /> : <AdminLinks />}
          />
          <Route path="/admin/audit" element={isGuest ? <Navigate to="/" replace /> : <AdminAudit />} />
          <Route path="/admin/metrics" element={isGuest ? <Navigate to="/" replace /> : <AdminMetrics />} />
          <Route path="/admin/summary" element={isGuest ? <Navigate to="/" replace /> : <AdminSummary />} />
          <Route path="/admin/deleted" element={isGuest ? <Navigate to="/" replace /> : <DeletedFiles />} />
          <Route path="/admin/folders" element={isGuest ? <Navigate to="/" replace /> : <AdminManagedFolders />} />
          <Route path="/me/email" element={isGuest ? <Navigate to="/" replace /> : <EmailPrefs />} />
          <Route path="/me/data" element={<MyData />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
