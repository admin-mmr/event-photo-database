import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { signInWithGoogle, signOutUser } from './lib/firebase.js';
import { useAuth } from './lib/useAuth.js';
import { Events } from './pages/Events.js';
import { Gallery } from './pages/Gallery.js';
import { FindMe } from './pages/FindMe.js';
import { FeedbackAdmin } from './pages/FeedbackAdmin.js';

export function App(): JSX.Element {
  const { user, loading } = useAuth();

  return (
    <BrowserRouter>
      <main className="page">
        <header className="app-header">
          <Link to="/" className="app-title">
            <h1>Event Photo Database</h1>
          </Link>
          {user && (
            <div className="user-box">
              <Link to="/admin/feedback" className="muted nav-link">
                Match feedback
              </Link>
              <span className="muted">{user.email}</span>
              <button className="btn btn-light" onClick={() => void signOutUser()}>
                Sign out
              </button>
            </div>
          )}
        </header>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : user ? (
          <Routes>
            <Route path="/" element={<Events />} />
            <Route path="/events/:eventId" element={<Gallery />} />
            <Route path="/events/:eventId/findme" element={<FindMe />} />
            <Route path="/admin/feedback" element={<FeedbackAdmin />} />
          </Routes>
        ) : (
          <div className="consent-card signin-card">
            <p>Browse event photos and find yourself in them with Find Me.</p>
            <button className="btn btn-primary" onClick={() => void signInWithGoogle()}>
              Sign in with Google
            </button>
          </div>
        )}
      </main>
    </BrowserRouter>
  );
}
