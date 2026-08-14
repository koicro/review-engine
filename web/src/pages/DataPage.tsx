import { useRef, useState, type ChangeEvent } from 'react';
import { useApi } from '../api/context';
import type { ImportValidation } from '../api/types';
import { Badge, Button, Card, ErrorPanel, Notice, PageHeader } from '../components/UI';
import { explainError } from '../lib';
import { en } from '../messages';

export function DataPage() {
  const { api } = useApi();
  const inputRef = useRef<HTMLInputElement>(null);
  const [payload, setPayload] = useState<unknown>();
  const [fileName, setFileName] = useState('');
  const [validation, setValidation] = useState<ImportValidation | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'export' | 'validate' | 'import' | ''>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function exportData() {
    setBusy('export'); setError(''); setNotice('');
    try {
      const { blob, fileName: name } = await api.exportAll();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice(en.dataPage.exported);
    } catch (cause) { setError(explainError(cause)); }
    finally { setBusy(''); }
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name); setValidation(null); setConfirmed(false); setError(''); setNotice('');
    try { setPayload(JSON.parse(await file.text())); }
    catch { setPayload(undefined); setError(en.dataPage.invalidJson); }
  }

  async function validate() {
    if (payload === undefined) return;
    setBusy('validate'); setError('');
    try { setValidation(await api.validateImport(payload)); }
    catch (cause) { setError(explainError(cause)); }
    finally { setBusy(''); }
  }

  async function runImport() {
    if (payload === undefined || !validation?.valid || !confirmed) return;
    setBusy('import'); setError('');
    try { const result = await api.importAll(payload); setNotice(en.dataPage.importComplete(result.counts ? Object.values(result.counts).reduce((sum, value) => sum + value, 0) : undefined)); setPayload(undefined); setFileName(''); setValidation(null); setConfirmed(false); if (inputRef.current) inputRef.current.value = ''; }
    catch (cause) { setError(explainError(cause)); }
    finally { setBusy(''); }
  }

  return (
    <div className="page-stack narrow-page">
      <PageHeader eyebrow={en.dataPage.eyebrow} title={en.dataPage.title} description={en.dataPage.description} />
      {notice && <Notice tone="success">{notice}</Notice>}{error && <ErrorPanel message={error} />}
      <div className="data-grid">
        <Card className="data-card"><div className="data-card-icon" aria-hidden="true">↓</div><div><p className="eyebrow">{en.dataPage.backup}</p><h2>{en.dataPage.exportTitle}</h2><p>{en.dataPage.exportDescription}</p><ul className="plain-check-list">{en.dataPage.exportChecks.map((item) => <li key={item}>{item}</li>)}</ul><Button onClick={() => void exportData()} disabled={Boolean(busy)}>{busy === 'export' ? en.dataPage.preparingExport : en.dataPage.downloadExport}</Button></div></Card>
        <Card className="data-card"><div className="data-card-icon" aria-hidden="true">↑</div><div><p className="eyebrow">{en.dataPage.restore}</p><h2>{en.dataPage.importTitle}</h2><p>{en.dataPage.importDescription}</p><input ref={inputRef} className="file-input" id="import-file" type="file" accept="application/json,.json" onChange={(event) => void chooseFile(event)} /><label className="file-drop" htmlFor="import-file"><strong>{fileName || en.dataPage.chooseExport}</strong><span>{fileName ? en.dataPage.readyToValidate : en.dataPage.jsonOnly}</span></label>{payload !== undefined && !validation && <Button variant="secondary" onClick={() => void validate()} disabled={Boolean(busy)}>{busy === 'validate' ? en.dataPage.validating : en.dataPage.validateBeforeImport}</Button>}</div></Card>
      </div>
      {validation && <Card className="validation-card"><div className="section-heading"><div><p className="eyebrow">{en.dataPage.validationResult}</p><h2>{validation.valid ? en.dataPage.readyToRestore : en.dataPage.cannotImport}</h2></div><Badge tone={validation.valid ? 'success' : 'danger'}>{validation.valid ? en.dataPage.valid : en.dataPage.errorCount(validation.errors.length)}</Badge></div>{validation.formatVersion && <p>{en.dataPage.formatVersion} <strong>{validation.formatVersion}</strong></p>}{validation.counts && <dl className="count-grid">{Object.entries(validation.counts).map(([name, count]) => <div key={name}><dt>{name}</dt><dd>{count}</dd></div>)}</dl>}{validation.errors.length > 0 && <ul className="import-errors">{validation.errors.map((item, index) => <li key={`${item.path}-${index}`}><strong>{item.path || item.code || en.common.data}</strong><span>{en.dataPage.importIssue(item.code)}</span></li>)}</ul>}{validation.valid && <><Notice tone="warning"><strong>{en.dataPage.restoreCarefully}</strong> {en.dataPage.restoreWarning}</Notice><label className="confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{en.dataPage.transactionConfirmation}</span></label><Button onClick={() => void runImport()} disabled={!confirmed || Boolean(busy)}>{busy === 'import' ? en.dataPage.restoring : en.dataPage.importAll}</Button></>}</Card>}
      <Card className="backup-note"><strong>{en.dataPage.offlineBackup}</strong><p>{en.dataPage.offlineBackupDescription}</p></Card>
    </div>
  );
}
