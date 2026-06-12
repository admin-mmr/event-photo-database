import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { SearchResponse, MatchResult } from '@cloud-webapp/shared';
import { apiUpload, ApiError } from '../lib/api.js';

type Phase = 'consent' | 'pick' | 'searching' | 'results';

/**
 * Demo-scope Find Me flow (2026-06-12): consent checkbox → selfie upload →
 * fused results grid. Multi-reference tabs, enrollment, and the
 * minor/guardian path land with full M3.
 */
export function FindMe(): JSX.Element {
  const { eventId = '' } = useParams();
  const [phase, setPhase] = useState<Phase>('consent');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<MatchResult[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  async function search(file: File): Promise<void> {
    setPhase('searching');
    setError(null);
    const form = new FormData();
    form.set('file', file);
    form.set('eventId', eventId);
    form.set('consent', 'true');
    try {
      const res = await apiUpload<SearchResponse>('/api/findme/search', form);
      setResults(res.results);
      setPhase('results');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_usable_face') {
        setError('We couldn’t find a clear face in that photo. Try a sharper, front-facing picture with good lighting.');
        setPhase('pick');
      } else if (e instanceof ApiError && e.code === 'event_not_indexed') {
        setError('This event hasn’t been indexed for Find Me yet — ask an admin to run indexing.');
        setPhase('pick');
      } else {
        setError(e instanceof Error ? e.message : 'Search failed');
        setPhase('pick');
      }
    }
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Find Me</h2>
        <Link to={`/events/${eventId}`} className="btn btn-light">
          ← Back to gallery
        </Link>
      </div>

      {phase === 'consent' && (
        <div className="consent-card">
          <h3>Before we search</h3>
          <p>
            Find Me compares a photo of you against this event&rsquo;s photos using face
            matching. Your reference photo is used only for this search.
          </p>
          <label className="consent-row">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span>
              I consent to the use of my photo for face matching in this event, and I am
              searching for myself (or as the guardian of the person pictured).
            </span>
          </label>
          <button
            className="btn btn-primary"
            disabled={!agreed}
            onClick={() => setPhase('pick')}
          >
            Continue
          </button>
        </div>
      )}

      {phase === 'pick' && (
        <div className="consent-card">
          <h3>Upload a photo of yourself</h3>
          <p className="muted">A clear, front-facing photo works best — a selfie is perfect.</p>
          {error && <p className="error-text">{error}</p>}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="user"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void search(f);
            }}
          />
          <button className="btn btn-primary" onClick={() => fileInput.current?.click()}>
            Choose / take a photo
          </button>
        </div>
      )}

      {phase === 'searching' && <p className="muted">Searching the event photos…</p>}

      {phase === 'results' && (
        <div>
          {results.length === 0 ? (
            <p className="muted">
              No matches found. Try a different photo, or browse the{' '}
              <Link to={`/events/${eventId}`}>full gallery</Link>.
            </p>
          ) : (
            <>
              <p className="muted">
                {results.length} possible matches, best first. Tap a photo to download it.
              </p>
              <div className="photo-grid">
                {results.map((r) => (
                  <a
                    key={r.photoId}
                    className="photo-cell"
                    href={r.webUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img src={r.thumbUrl} alt="" loading="lazy" />
                    <span className="score-chip">{Math.round(r.score * 100)}%</span>
                  </a>
                ))}
              </div>
            </>
          )}
          <button className="btn btn-light" onClick={() => setPhase('pick')}>
            Search again with another photo
          </button>
        </div>
      )}
    </div>
  );
}
