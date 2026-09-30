import { useState } from "preact/hooks";
import { supabase } from "../lib/supabase.ts";

// Email + password. Users are created by the admin in the Supabase dashboard (sign-ups disabled),
// so no email is ever sent and the login works the same in Safari and in an installed iOS PWA.
export function LoginView() {
  const [email, setEmail] = useState(() => {
    try {
      return localStorage.getItem("last-email") ?? "";
    } catch {
      return "";
    }
  });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setError(error.message === "Invalid login credentials" ? "Väärä sähköposti tai salasana." : error.message);
      return;
    }
    try {
      localStorage.setItem("last-email", email.trim());
    } catch { /* private mode */ }
  };

  return (
    <main class="login">
      <div class="stack-sm">
        <h1>Hintaseuranta</h1>
        <p class="muted">Seuraa toivelistan hintoja ja saa ilmoitus, kun ostoikkuna aukeaa.</p>
      </div>
      <form class="stack" onSubmit={submit}>
        <label class="field">
          <span>Sähköposti</span>
          <input type="email" required autoComplete="username" value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Salasana</span>
          <input type="password" required autoComplete="current-password" value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </label>
        <button class="btn primary block" disabled={busy}>{busy ? "Kirjaudutaan…" : "Kirjaudu"}</button>
      </form>
      {error && <div class="notice bad" role="alert">{error}</div>}
      <p class="meta">Tunnukset luo sovelluksen ylläpitäjä. Unohtuneen salasanan voi vaihtaa Supabasen hallintapaneelista.</p>
    </main>
  );
}
