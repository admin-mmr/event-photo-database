import { useState } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { continueAsGuest, signInWithGoogle, signOutUser } from './lib/firebase.js';
import { useAuth } from './lib/useAuth.js';
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
import { DeletedFiles } from './pages/DeletedFiles.js';
import { AdminMetrics } from './pages/AdminMetrics.js';
import { MyData } from './pages/MyData.js';
import { VolunteerUpload } from './pages/VolunteerUpload.js';

export function App(): JSX.Element {
  const { user, loading } = useAuth();
  const [signInError, setSignInError] = useState<string | null>(null);
  const isGuest = Boolean(user?.isAnonymous);

  async function guest(): Promise<void> {
    setSignInError(null);
    try {
      await continueAsGuest();
    } catch (err) {
      // Most likely cause: Anonymous sign-in not enabled in the Firebase console.
      setSignInError(
        'Could not start a guest session. Ask an admin to enable Anonymous sign-in in Firebase. · 无法开始访客会话，请联系管理员在 Firebase 中启用匿名登录。',
      );
      console.error('anonymous sign-in failed', err);
    }
  }

  // App chrome + auth gate, applied to every signed-in page via <Outlet/>. The
  // public volunteer upload route sits OUTSIDE this layout so it renders with
  // no header and no sign-in requirement.
  const layout = (
    <main className="page">
      <header className="app-header">
        <Link to="/" className="app-title">
          <h1>Event Photo Database · 活动照片库</h1>
        </Link>
        {user && (
          <div className="user-box">
            <Link to="/me/data" className="muted nav-link">
              My data · 我的数据
            </Link>
            {/* Admin-only; guests have no email so the API blocks them anyway. */}
            {!isGuest && (
              <>
                <Link to="/admin/events" className="muted nav-link">
                  Events · 活动
                </Link>
                <Link to="/admin/users" className="muted nav-link">
                  Users · 用户
                </Link>
                <Link to="/admin/clubs" className="muted nav-link">
                  Clubs · 俱乐部
                </Link>
                <Link to="/admin/feedback" className="muted nav-link">
                  Match feedback · 匹配反馈
                </Link>
                <Link to="/admin/metrics" className="muted nav-link">
                  Metrics · 指标
                </Link>
                <Link to="/admin/summary" className="muted nav-link">
                  Report · 报告
                </Link>
                <Link to="/admin/deleted" className="muted nav-link">
                  Trash · 回收站
                </Link>
                <Link to="/admin/audit" className="muted nav-link">
                  Audit · 审计
                </Link>
                <Link to="/me/email" className="muted nav-link">
                  Email settings · 邮件设置
                </Link>
              </>
            )}
            {isGuest ? (
              <>
                <span className="muted">Guest · 访客</span>
                <button className="btn btn-light" onClick={() => void signInWithGoogle()}>
                  Sign in with Google · 使用 Google 登录
                </button>
              </>
            ) : (
              <span className="muted">{user.email}</span>
            )}
            <button className="btn btn-light" onClick={() => void signOutUser()}>
              {isGuest ? 'Exit guest · 退出访客' : 'Sign out · 退出登录'}
            </button>
          </div>
        )}
      </header>

      {loading ? (
        <p className="muted">Loading… · 加载中…</p>
      ) : user ? (
        <Outlet />
      ) : (
        <div className="consent-card signin-card">
          <p>
            Browse event photos and find yourself in them with Find Me. ·
            浏览活动照片，并用「找到我」找到照片中的自己。
          </p>
          <button className="btn btn-primary" onClick={() => void guest()}>
            Continue as guest · 以访客身份继续
          </button>
          <button className="btn btn-light" onClick={() => void signInWithGoogle()}>
            Sign in with Google · 使用 Google 登录
          </button>
          {signInError && <p className="error-text">{signInError}</p>}
        </div>
      )}
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
          <Route path="/me/email" element={isGuest ? <Navigate to="/" replace /> : <EmailPrefs />} />
          <Route path="/me/data" element={<MyData />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
