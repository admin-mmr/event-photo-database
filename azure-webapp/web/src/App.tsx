import { useState } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { continueAsGuest, signInWithGoogle, signOutUser } from './lib/firebase.js';
import { useAuth } from './lib/useAuth.js';
import { Events } from './pages/Events.js';
import { Gallery } from './pages/Gallery.js';
import { FindMe } from './pages/FindMe.js';
import { FeedbackAdmin } from './pages/FeedbackAdmin.js';
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
        'Could not start a guest session. Ask an admin to enable Anonymous sign-in in Firebase.',
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
          <h1>Event Photo Database</h1>
        </Link>
        {user && (
          <div className="user-box">
            <Link to="/me/data" className="muted nav-link">
              My data
            </Link>
            {/* Admin-only; guests have no email so the API blocks them anyway. */}
            {!isGuest && (
              <Link to="/admin/feedback" className="muted nav-link">
                Match feedback
              </Link>
            )}
            {isGuest ? (
              <>
                <span className="muted">Guest</span>
                <button className="btn btn-light" onClick={() => void signInWithGoogle()}>
                  Sign in with Google
                </button>
              </>
            ) : (
              <span className="muted">{user.email}</span>
            )}
            <button className="btn btn-light" onClick={() => void signOutUser()}>
              {isGuest ? 'Exit guest' : 'Sign out'}
            </button>
          </div>
        )}
      </header>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : user ? (
        <Outlet />
      ) : (
        <div className="consent-card signin-card">
          <p>Browse event photos and find yourself in them with Find Me.</p>
          <button className="btn btn-primary" onClick={() => void guest()}>
            Continue as guest
          </button>
          <button className="btn btn-light" onClick={() => void signInWithGoogle()}>
            Sign in with Google
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
          <Route path="/me/data" element={<MyData />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
