import { useState, type FormEvent } from 'react';
import { api } from '@/services';
import { setSession, takeNotice } from '@/services/session';
import logo from '@/assets/technosport-logo.png';

// Shown instead of the app until the user signs in.
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(takeNotice);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(await api.login(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-logo"><img src={logo} alt="TechnoSport" /></div>
        <div>
          <h1>BLUE ORIGIN</h1>
          <p className="note">Sales &amp; Retailer Growth · sign in to continue</p>
        </div>
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="alert error-alert" role="alert">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="note">No account, or forgot your password? Ask an admin to add you or reset it on the Users page.</p>
      </form>
    </div>
  );
}
