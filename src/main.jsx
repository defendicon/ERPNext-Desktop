import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, Check, ChevronRight, CircleDollarSign, Database, ExternalLink, GraduationCap, HardHat, Headphones, HeartPulse, LayoutGrid, PackageCheck, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, Users, WalletCards, Wrench, X } from 'lucide-react';
import './styles.css';
import './controls.css';
import './automatic-setup.css';
import './readable-progress.css';

const catalog = [
  { id: 'erpnext', name: 'ERPNext Core', note: 'Required', description: 'Accounting, buying, selling, stock, manufacturing, projects, assets, quality and support.', icon: Box, required: true, tone: 'mint' },
  { id: 'hrms', name: 'Frappe HR', note: 'Official', description: 'Employees, payroll, attendance, leave, recruitment and performance.', icon: Users, tone: 'coral' },
  { id: 'payments', name: 'Payments', note: 'Official', description: 'Payment gateways and online transaction integrations for ERPNext.', icon: WalletCards, tone: 'gold' },
  { id: 'crm', name: 'Frappe CRM', note: 'Official', description: 'Modern lead, deal and sales pipeline workspace for your team.', icon: Sparkles, tone: 'blue' },
  { id: 'helpdesk', name: 'Frappe Helpdesk', note: 'Official', description: 'Omnichannel tickets, SLAs, teams, knowledge base and customer portal.', icon: Headphones, tone: 'violet' },
  { id: 'lms', name: 'Frappe Learning', note: 'Official', description: 'Courses, batches, quizzes, certifications and training portals.', icon: GraduationCap, tone: 'cyan' },
  { id: 'insights', name: 'Frappe Insights', note: 'Official', description: 'Business intelligence, datasets, dashboards and visual analysis.', icon: Database, tone: 'lime' },
  { id: 'drive', name: 'Frappe Drive', note: 'Official', description: 'Secure file storage, folders, sharing and team collaboration.', icon: PackageCheck, tone: 'orange' },
  { id: 'builder', name: 'Frappe Builder', note: 'Official', description: 'Visual website builder for landing pages and custom web experiences.', icon: LayoutGrid, tone: 'pink' },
  { id: 'wiki', name: 'Frappe Wiki', note: 'Official', description: 'Structured internal documentation and a searchable company knowledge base.', icon: Wrench, tone: 'slate' }
];

const bridge = window.erpDesktop || {
  preflight: async () => ({
    docker: false,
    compose: false,
    git: false,
    engine: false,
    wsl: false,
    features: { wsl: 'unknown', virtualMachinePlatform: 'unknown' },
    firmwareVirtualization: null,
    ready: false
  }),
  installRequirement: async () => { throw new Error('Requirement installation is available in the Windows desktop app.'); },
  startDocker: async () => {},
  startInstall: async () => { throw new Error('Open this screen in the Windows desktop app to start installation.'); },
  workspaceStatus: async () => ({ installed: false }),
  removeWorkspace: async () => ({ removed: false }),
  openAppsSettings: async () => {},
  openUrl: async () => {},
  onInstallEvent: () => () => {}
};

function AppCard({ app, selected, onToggle }) {
  const Icon = app.icon;
  return <button className={`app-card ${selected ? 'selected' : ''}`} onClick={() => !app.required && onToggle(app.id)} aria-pressed={selected}>
    <span className={`app-icon ${app.tone}`}><Icon size={21}/></span>
    <span className="app-copy"><strong>{app.name}</strong><small>{app.description}</small></span>
    <span className="app-meta">{app.note}</span>
    <span className={`tick ${selected ? 'on' : ''}`}>{selected && <Check size={14}/>}</span>
  </button>;
}

function App() {
  const [selected, setSelected] = useState(() => {
    try { return JSON.parse(localStorage.getItem('erpnext-desktop:selected-apps')) || ['erpnext', 'hrms', 'payments']; }
    catch { return ['erpnext', 'hrms', 'payments']; }
  });
  const [query, setQuery] = useState('');
  const [siteName, setSiteName] = useState(() => localStorage.getItem('erpnext-desktop:site-name') || 'erp');
  const [preflight, setPreflight] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [activity, setActivity] = useState({ phase: 'Preparing automatic setup', image: 'Windows requirements', line: 'Checking this computer before installation begins.' });
  const [logs, setLogs] = useState([]);
  const [message, setMessage] = useState('');
  const [complete, setComplete] = useState(null);
  const [workspace, setWorkspace] = useState({ installed: false });
  const [dialog, setDialog] = useState(null);
  const [requirementBusy, setRequirementBusy] = useState('');

  const filtered = useMemo(() => catalog.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())), [query]);
  const toggle = (id) => setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  const check = async () => setPreflight(await bridge.preflight());

  useEffect(() => {
    check();
    bridge.workspaceStatus().then(setWorkspace);
    return bridge.onInstallEvent((event) => {
      if (event.line) setLogs((items) => [...items.slice(-80), event.line]);
      if (event.progress !== undefined) setProgress((current) => Math.max(current, event.progress));
      setActivity((current) => ({
        phase: event.phase || current.phase,
        image: event.image || current.image,
        line: event.line || current.line
      }));
    });
  }, []);

  useEffect(() => {
    localStorage.setItem('erpnext-desktop:selected-apps', JSON.stringify(selected));
    localStorage.setItem('erpnext-desktop:site-name', siteName);
  }, [selected, siteName]);

  const install = async () => {
    setBusy(true); setMessage(''); setLogs([]); setProgress(1);
    setActivity({ phase: 'Preparing automatic setup', image: 'Windows requirements', line: 'Checking this computer before installation begins.' });
    try {
      const result = await bridge.startInstall({ version: '16', apps: selected.filter((id) => id !== 'erpnext'), siteName });
      setComplete(result); setWorkspace({ installed: true }); setProgress(100);
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  };

  const runRequirement = async (id) => {
    setDialog(null); setRequirementBusy(id); setMessage('');
    try {
      await bridge.installRequirement(id);
      setMessage(id === 'git' ? 'Git was installed. Checking the system again…' : 'Installation completed. Windows or Docker Desktop may require a restart.');
      await check();
    } catch (err) { setMessage(err.message); } finally { setRequirementBusy(''); }
  };

  const startDocker = async () => {
    setRequirementBusy('engine'); setMessage('');
    try { await bridge.startDocker(); setMessage('Docker Desktop is starting. Wait a moment, then check requirements again.'); }
    catch (err) { setMessage(err.message); } finally { setRequirementBusy(''); }
  };

  const removeWorkspace = async (deleteData) => {
    setDialog(null); setBusy(true); setMessage('');
    try {
      await bridge.removeWorkspace({ deleteData });
      setWorkspace({ installed: !deleteData }); setComplete(null);
      setMessage(deleteData ? 'ERP workspace, containers and data volumes were removed.' : 'ERPNext services stopped; your database and files were kept.');
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  };

  return <main className="shell">
    <aside className="rail">
      <div className="brand"><span className="brand-mark"><HardHat size={21}/></span><span>ERPNext<br/><b>Desktop</b></span></div>
      <nav><a className="active"><LayoutGrid size={18}/>New installation</a><a><HeartPulse size={18}/>System health</a><a><RefreshCw size={18}/>Updates</a><a><ShieldCheck size={18}/>Backups</a></nav>
      <div className="rail-foot"><span className={`status-dot ${preflight?.ready ? 'good' : ''}`}/><div><b>{preflight?.ready ? 'System ready' : 'Setup required'}</b><small>{preflight?.ready ? 'Docker engine is running' : 'Install the missing requirements'}</small></div></div>
    </aside>

    <section className="content">
      <header className="topbar"><div><span className="eyebrow">LOCAL • PRIVATE • OPEN SOURCE</span><h1>Build your ERP workspace.</h1><p>Choose the official apps and give your site a name. Everything else is automatic.</p></div><div className="version"><small>ERPNext release</small><strong>Version 16 · Current</strong></div></header>
      <div className="workspace">
        <section className="picker">
          <div className="section-head"><div><h2>Choose official apps</h2><span>{selected.length} selected</span></div><label className="search"><Search size={16}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search apps"/></label></div>
          <div className="notice"><CircleDollarSign size={18}/><div><b>Core business modules are included together.</b><span>Accounting, Stock, Buying, Selling, Manufacturing, Projects, Assets and Quality are part of ERPNext Core—not separate downloads.</span></div></div>
          <div className="apps-grid">{filtered.map((app) => <AppCard key={app.id} app={app} selected={selected.includes(app.id)} onToggle={toggle}/>)}</div>
        </section>

        <aside className="summary">
          <div className="summary-top"><span>INSTALLATION</span><b>{selected.length < 4 ? 'Lean workspace' : selected.length < 7 ? 'Team workspace' : 'Complete suite'}</b></div>
          <div className="metric"><span>{selected.length}</span><small>official apps</small></div>
          <div className="field"><label>Site name</label><div className="site-name-field"><input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="mycompany"/><span>.localhost</span></div></div>
          <div className="automatic-note"><ShieldCheck size={19}/><div><b>Fully automatic setup</b><span>WSL 2, Git, Docker Desktop and every required image will be installed silently.</span></div></div>
          {message && <div className="message">{message}</div>}
          {complete ? <button className="primary" onClick={() => bridge.openUrl(complete.url)}>Open ERPNext <ExternalLink size={17}/></button> : <button className="primary" disabled={busy || !siteName.trim()} onClick={install}>{busy ? 'Setting up everything…' : 'Install selected apps'}<ChevronRight size={18}/></button>}
          <p className="fineprint">Missing Windows components are downloaded and configured automatically. A restart may be required once.</p>
          <div className="uninstall-zone"><b>Removal & recovery</b><button disabled={!workspace.installed || busy} onClick={() => setDialog({type:'workspace'})}><Trash2 size={13}/> Remove ERP workspace</button><button onClick={() => bridge.openAppsSettings()}><ExternalLink size={13}/> Uninstall Windows app</button></div>
        </aside>
      </div>
    </section>

    {busy && <section className="setup-progress-screen" role="status" aria-live="polite">
      <div className="progress-brand"><span className="brand-mark"><HardHat size={25}/></span><span>ERPNext <b>Desktop</b></span></div>
      <div className="progress-panel">
        <span className="progress-kicker">AUTOMATIC INSTALLATION</span>
        <div className="progress-number">{progress}<small>%</small></div>
        <div className="progress-track"><div style={{width: `${progress}%`}}/></div>
        <h2>{activity.phase}</h2>
        <p>{activity.line}</p>
        <div className="current-download"><Database size={22}/><div><span>CURRENT PACKAGE / IMAGE</span><strong>{activity.image}</strong></div></div>
        <div className="progress-steps">
          <span className={progress >= 24 ? 'done' : 'active'}>Windows setup</span>
          <span className={progress >= 32 ? (progress >= 82 ? 'done' : 'active') : ''}>ERPNext image</span>
          <span className={progress >= 82 ? 'active' : ''}>Services & site</span>
        </div>
        <small className="progress-footnote">No action is needed. A Windows permission prompt or one restart may still be required.</small>
      </div>
    </section>}

    {dialog?.type === 'workspace' && <div className="dialog-backdrop"><div className="dialog-card danger-card">
      <button className="dialog-close" onClick={() => setDialog(null)}><X size={18}/></button><span className="dialog-icon danger"><Trash2 size={23}/></span><h3>Remove ERP workspace?</h3>
      <p>Stop the services and keep the database volumes for recovery, or permanently remove the workspace, database, files and locally-built image.</p>
      <div className="dialog-actions stacked"><button onClick={() => removeWorkspace(false)}>Stop services · keep data</button><button className="destructive" onClick={() => removeWorkspace(true)}>Permanently delete everything</button><button onClick={() => setDialog(null)}>Cancel</button></div>
    </div></div>}
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
