import { useEffect, useState, type FormEvent } from 'react';
import { useApi } from '../api/context';
import type { AccessToken } from '../api/types';
import { Badge, Button, Card, ErrorPanel, Field, Notice, PageHeader } from '../components/UI';
import { explainError } from '../lib';
import { en } from '../messages';

export function SettingsPage() {
  const { api, settings, sessionStatus, signIn, signOut, checkSession } = useApi();
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState<'signin' | 'signout' | 'checking' | ''>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [issuedSecret, setIssuedSecret] = useState('');
  const [tokenError, setTokenError] = useState('');
  const authenticated = sessionStatus === 'authenticated';

  useEffect(() => {
    setBaseUrl(settings.baseUrl);
  }, [settings.baseUrl]);

  useEffect(() => {
    if (!authenticated) {
      setTokens([]);
      return;
    }
    let active = true;
    setTokensLoading(true);
    api.listAccessTokens().then((page) => active && setTokens(page.items)).catch((cause) => active && setTokenError(explainError(cause))).finally(() => active && setTokensLoading(false));
    return () => { active = false; };
  }, [api, authenticated]);

  async function establishSession(event: FormEvent) {
    event.preventDefault();
    const submittedToken = token;
    setToken('');
    setShowToken(false);
    setBusy('signin');
    setError('');
    setNotice('');
    try {
      await signIn(baseUrl, submittedToken);
      setNotice(en.settings.established);
    } catch (cause) {
      setError(explainError(cause));
    } finally {
      setBusy('');
    }
  }

  async function verifyConnection() {
    setBusy('checking'); setError(''); setNotice('');
    try {
      await checkSession();
      setNotice(en.settings.active);
    } catch (cause) {
      setError(explainError(cause));
    } finally {
      setBusy('');
    }
  }

  async function endSession() {
    setBusy('signout'); setError(''); setNotice('');
    try {
      await signOut();
      setIssuedSecret('');
      setTokens([]);
      setNotice(en.settings.signedOut);
    } catch (cause) {
      setError(explainError(cause));
    } finally {
      setBusy('');
    }
  }

  async function issueToken(event: FormEvent) {
    event.preventDefault();
    if (!tokenName.trim()) return;
    setTokensLoading(true); setTokenError(''); setIssuedSecret('');
    try {
      const issued = await api.issueAccessToken(tokenName.trim());
      setTokens((items) => [issued.token, ...items]);
      setIssuedSecret(issued.secret);
      setTokenName('');
    } catch (cause) { setTokenError(explainError(cause)); }
    finally { setTokensLoading(false); }
  }

  async function revokeToken(id: string) {
    setTokensLoading(true); setTokenError('');
    try { const revoked = await api.revokeAccessToken(id); setTokens((items) => items.map((item) => item.id === id ? revoked : item)); }
    catch (cause) { setTokenError(explainError(cause)); }
    finally { setTokensLoading(false); }
  }

  const openApiUrl = `${baseUrl.replace(/\/$/, '')}/openapi.json`;
  return (
    <div className="page-stack narrow-page">
      <PageHeader eyebrow={en.settings.eyebrow} title={en.settings.title} description={en.settings.description} actions={authenticated ? <a className="button button-secondary" href="#/data">{en.settings.exportImport}</a> : undefined} />
      {notice && <Notice tone="success">{notice}</Notice>}
      <div className="settings-grid">
        <Card>
          <div className="section-heading"><div><p className="eyebrow">{en.settings.connection}</p><h2>{en.settings.browserSession}</h2></div>{authenticated ? <Badge tone="success">{en.settings.signedIn}</Badge> : sessionStatus === 'checking' ? <Badge>{en.settings.checking}</Badge> : sessionStatus === 'unavailable' ? <Badge tone="danger">{en.settings.unavailable}</Badge> : <Badge tone="warning">{en.settings.signInRequired}</Badge>}</div>
          <form className="form-stack" onSubmit={establishSession}>
            {error && <ErrorPanel message={error} />}
            <Field label={en.settings.apiBase} hint={en.settings.apiBaseHint}><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="/api/v1" spellCheck="false" disabled={authenticated} /></Field>
            {authenticated ? (
              <>
                <Notice tone="success">{en.settings.cookieNotice}</Notice>
                <div className="form-actions"><Button type="button" variant="secondary" onClick={() => void verifyConnection()} disabled={Boolean(busy)}>{busy === 'checking' ? en.settings.checkingProgress : en.settings.checkSession}</Button><Button type="button" variant="danger" onClick={() => void endSession()} disabled={Boolean(busy)}>{busy === 'signout' ? en.settings.signingOut : en.settings.signOut}</Button></div>
              </>
            ) : (
              <>
                <Field label={en.settings.administratorToken} hint={en.settings.tokenHint}><div className="password-field"><input type={showToken ? 'text' : 'password'} value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck="false" required /><button type="button" onClick={() => setShowToken((value) => !value)}>{showToken ? en.settings.hide : en.settings.show}</button></div></Field>
                <div className="form-actions"><Button type="submit" disabled={!token.trim() || Boolean(busy)}>{busy === 'signin' || sessionStatus === 'checking' ? en.settings.signingIn : en.settings.startSession}</Button></div>
              </>
            )}
          </form>
        </Card>
        <Card><p className="eyebrow">{en.settings.privacy}</p><h2>{en.settings.privateDefault}</h2><p>{en.settings.privateDescription}</p><ul className="privacy-list"><li><span aria-hidden="true">✓</span><div><strong>{en.settings.noTelemetry}</strong><small>{en.settings.noTelemetryDescription}</small></div></li><li><span aria-hidden="true">✓</span><div><strong>{en.settings.httpOnly}</strong><small>{en.settings.httpOnlyDescription}</small></div></li><li><span aria-hidden="true">✓</span><div><strong>{en.settings.sameOrigin}</strong><small>{en.settings.sameOriginDescription}</small></div></li></ul></Card>
      </div>
      <Card className="token-card">
        <div className="section-heading"><div><p className="eyebrow">{en.settings.apiClients}</p><h2>{en.settings.revocableTokens}</h2><p>{en.settings.tokenDescription}</p></div><Badge>{en.settings.activeCount(tokens.filter((item) => !item.revokedAt).length)}</Badge></div>
        {tokenError && <ErrorPanel message={tokenError} />}
        {!authenticated ? <Notice tone="warning">{en.settings.sessionRequired}</Notice> : (
          <>
            {issuedSecret && <Notice tone="success"><div className="issued-token"><div><strong>{en.settings.copyNow}</strong><code>{issuedSecret}</code><small>{en.settings.cannotShowAgain}</small></div><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(issuedSecret)}>{en.settings.copy}</Button></div></Notice>}
            <form className="token-create-form" onSubmit={issueToken}><Field label={en.settings.tokenName}><input value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder={en.settings.tokenNamePlaceholder} /></Field><Button type="submit" disabled={!tokenName.trim() || tokensLoading}>{tokensLoading ? en.settings.working : en.settings.issueToken}</Button></form>
            <ul className="token-list">
              {tokens.length === 0 ? <li className="token-empty">{en.settings.noTokens}</li> : tokens.map((item) => <li key={item.id}><div><strong>{item.name}</strong><small>{en.settings.createdAt(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(item.createdAt)))}</small></div>{item.revokedAt ? <Badge>{en.settings.revoked}</Badge> : <Button variant="quiet" onClick={() => void revokeToken(item.id)} disabled={tokensLoading}>{en.settings.revoke}</Button>}</li>)}
            </ul>
          </>
        )}
      </Card>
      <Card className="developer-card"><div><p className="eyebrow">{en.settings.developers}</p><h2>{en.settings.buildApi}</h2><p>{en.settings.apiDescription}</p></div><a className="button button-secondary" href={openApiUrl} target="_blank" rel="noreferrer">{en.settings.openApi}</a></Card>
      <Card className="deployment-card"><p className="eyebrow">{en.settings.deployment}</p><h2>{en.settings.runtimeControls}</h2><dl><div><dt>{en.settings.runtime}</dt><dd>{en.settings.runtimeDescription}</dd></div><div><dt>{en.settings.persistence}</dt><dd>{en.settings.persistenceDescription}</dd></div><div><dt>{en.settings.authentication}</dt><dd>{en.settings.authenticationDescription}</dd></div></dl></Card>
    </div>
  );
}
