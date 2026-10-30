import { useState, type FormEvent } from 'react';
import { api } from '@/services';
import { setSession } from '@/services/session';
import { Drawer } from '@/components/ui';

// The signed-in user's own password. The API returns a new token (older sign-ins stop working).
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setSession(await api.changePassword(current, next));
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="Change password" onClose={onClose}>
      {done ? (
        <>
          <div className="alert success-alert">Password changed. Other devices signed in with the old password are signed out.</div>
          <div><button className="btn primary" onClick={onClose}>Close</button></div>
        </>
      ) : (
        <form className="form" onSubmit={submit}>
          <label className="field">
            <span>Current password</span>
            <input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="field">
            <span>New password</span>
            <input className="input" type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
            <small className="note">At least 8 characters.</small>
          </label>
          <label className="field">
            <span>Repeat new password</span>
            <input className="input" type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </label>
          {error && <div className="alert error-alert">{error}</div>}
          <div className="form-actions">
            <span style={{ flex: 1 }} />
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
          </div>
        </form>
      )}
    </Drawer>
  );
}
