/* ==========================================================
   Alp-Rapport – Hauptlogik
   ========================================================== */
(() => {
'use strict';

// ------ Supabase-Client -----------------------------------------------------
const cfg = window.APP_CONFIG || {};
if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('DEIN-PROJEKT')) {
  alert('⚠️ Bitte zuerst in config.js die Supabase-URL und den Anon-Key eintragen.');
}
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

// ------ Globaler State ------------------------------------------------------
const state = {
  user: null,
  profile: null,
  myBestoesser: null,   // nur bei Rolle 'bestoesser': eigener Datensatz
  bestoesser: [],
  arbeitsarten: [],
  maschinen: [],
  eintraege: [],
  aufgaben: [],
  profiles: [],         // nur Admin/GF laden alle Profile
  auditLog: [],         // lazy geladen beim Öffnen des Admin-Tabs
  editId: null,
  editIds: null,   // alle IDs der aktuell bearbeiteten Gruppe
};

// ------ Kleine Helfer -------------------------------------------------------
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const fmtCHF = v => (Number(v||0)).toLocaleString('de-CH', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fmtNum = v => (Number(v||0)).toLocaleString('de-CH', {minimumFractionDigits: 0, maximumFractionDigits: 2});
const fmtDate = s => s ? new Date(s).toLocaleDateString('de-CH') : '';
const todayISO = () => new Date().toISOString().slice(0,10);

function showView(id) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#'+id).classList.add('active');
}
function setMsg(el, text, kind='') {
  const e = typeof el === 'string' ? $(el) : el;
  e.textContent = text; e.className = 'msg ' + kind;
}
function rolleLabel(r) {
  return ({
    alpmeister_portein: 'Alpmeister Porteineralp',
    alpmeister_sarn:    'Alpmeister Sarneralp',
    geschaeftsfuehrer:  'Geschäftsführer',
    bestoesser:         'Bestösser'
  })[r] || r;
}
function canWriteAlp(alp, bestoesser_id) {
  const r = state.profile?.rolle;
  if (isSystemAdmin()) return true;
  if (r === 'geschaeftsfuehrer') return true;
  if (r === 'alpmeister_portein') return alp === 'Portein';
  if (r === 'alpmeister_sarn')    return alp === 'Sarn';
  if (r === 'bestoesser') return bestoesser_id && bestoesser_id === state.myBestoesser?.id;
  return false;
}
function alpLabel(a) { return a === 'Portein' ? 'Porteineralp' : a === 'Sarn' ? 'Sarneralp' : a; }
function isAdmin() { return isSystemAdmin() || state.profile?.rolle === 'geschaeftsfuehrer'; }
function isSystemAdmin() { return state.profile?.is_admin === true; }
function isBestoesser() { return state.profile?.rolle === 'bestoesser'; }
function isMainRolle() { return ['geschaeftsfuehrer','alpmeister_portein','alpmeister_sarn'].includes(state.profile?.rolle); }
// Darf Stammdaten (Maschinen, Arbeitsarten, Bestösser) bearbeiten
function canEditMaster() { return isSystemAdmin() || isMainRolle(); }
// Darf Aufgaben erstellen/bearbeiten — nur Alpmeister + Administrator
function canCreateAufgaben() {
  return isSystemAdmin() || ['alpmeister_portein','alpmeister_sarn'].includes(state.profile?.rolle);
}

// ===========================================================================
// AUTH
// ===========================================================================
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  await afterAuth(session?.user ?? null);
  sb.auth.onAuthStateChange((_e, s) => afterAuth(s?.user ?? null));
}

async function afterAuth(user) {
  state.user = user;
  if (!user) { showView('view-login'); return; }
  const { data: p, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) { console.error(error); setMsg('#login-msg', error.message, 'error'); return; }
  if (!p) {
    await prepareOnboarding();
    showView('view-onboarding');
    return;
  }
  state.profile = p;

  // Eigenen Bestösser-Datensatz für das aktuelle Jahr laden (alle Rollen).
  const y = new Date().getFullYear();
  const { data: mine } = await sb.from('bestoesser')
    .select('*').eq('user_id', user.id).eq('jahr', y).maybeSingle();
  state.myBestoesser = mine ?? null;

  // Keine Zuordnung vorhanden:
  //  - Rolle 'bestoesser' → erzwungener Link-Schritt (muss sich zuordnen)
  //  - Alpmeister/GF     → optionaler Link-Schritt mit "Später"-Button,
  //                        sofern sie diese Sitzung nicht bereits übersprungen haben.
  if (!state.myBestoesser) {
    const isBest = p.rolle === 'bestoesser';
    const skipped = sessionStorage.getItem('alp-skip-link') === '1';
    if (isBest || !skipped) {
      await showLinkView(!isBest);
      return;  // Warten auf Zuordnen oder Später/Abmelden
    }
  }

  $('#topbar-user').textContent = `${p.name} · ${rolleLabel(p.rolle)}${isSystemAdmin() ? ' · ADMIN' : ''}`;
  $$('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  $$('.mgmt-only').forEach(el => el.classList.toggle('hidden', !canEditMaster()));
  $$('.mgmt-hint').forEach(el => el.classList.toggle('hidden', canEditMaster()));
  applyRolleUi();
  applyAdminUi();
  showView('view-app');
  await loadAll();
  renderAll();
}

// --- Bestösser: Datensatz verknüpfen ---------------------------------------
async function showLinkView(optional = false) {
  const y = new Date().getFullYear();
  $('#link-jahr').textContent = y;
  const { data, error } = await sb.from('bestoesser')
    .select('*').eq('jahr', y).eq('aktiv', true).is('user_id', null).order('name');
  if (error) console.error(error);
  const rows = data ?? [];
  const sel = $('#link-bestoesser');
  sel.innerHTML = '<option value="">— wählen —</option>' +
    rows.map(b => `<option value="${b.id}">${escapeHtml(b.name)} · ${escapeHtml(alpLabel(b.alpname))} · NST ${fmtNum(b.nst)}</option>`).join('');
  $('#link-empty').hidden = rows.length > 0;
  $('#btn-link-skip').hidden = !optional;
  showView('view-link');
}

$('#btn-link-save').addEventListener('click', async () => {
  const id = $('#link-bestoesser').value;
  if (!id) return setMsg('#link-msg', 'Bitte Eintrag wählen.', 'error');
  setMsg('#link-msg', 'Verknüpfe …');
  const { error } = await sb.from('bestoesser').update({ user_id: state.user.id }).eq('id', id);
  if (error) return setMsg('#link-msg', error.message, 'error');
  await afterAuth(state.user);
});

$('#btn-link-skip').addEventListener('click', () => {
  sessionStorage.setItem('alp-skip-link', '1');
  afterAuth(state.user);
});

$('#btn-link-logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  location.reload();
});

// --- Rollen-basiertes UI -----------------------------------------------------
function applyRolleUi() {
  // Stammdaten-Tab für Bestösser ausblenden (Admins immer sichtbar)
  const sdTab = document.querySelector('.tab[data-tab="stammdaten"]');
  if (sdTab) sdTab.style.display = (isBestoesser() && !canEditMaster()) ? 'none' : '';

  // Alp bei allen Rollen frei wählbar
  const eAlp = $('#e-alpname');
  if (eAlp) eAlp.disabled = false;
  // Wenn eigene Bestösser-Zuordnung existiert, Alp als sinnvollen Default vorschlagen
  if (state.myBestoesser && eAlp && !eAlp.value) {
    eAlp.value = state.myBestoesser.alpname;
  }
}

function applyAdminUi() {
  // Admin-Tab nur für Admin (User-Verwaltung) oder GF (Audit-Lesen)
  const adminTab = document.querySelector('.tab.admin-tab');
  if (adminTab) adminTab.classList.toggle('hidden', !(isSystemAdmin() || state.profile?.rolle === 'geschaeftsfuehrer'));
  // User-Verwaltung nur Admin
  $$('.admin-only-detail').forEach(el => el.classList.toggle('hidden', !isSystemAdmin()));
}

$('#btn-login').addEventListener('click', async () => {
  setMsg('#login-msg', 'Anmelden …');
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) setMsg('#login-msg', error.message, 'error');
});

$('#btn-signup').addEventListener('click', async () => {
  setMsg('#login-msg', 'Registrieren …');
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  if (!email || !password || password.length < 6) {
    return setMsg('#login-msg', 'E-Mail und Passwort (min. 6 Zeichen) erforderlich.', 'error');
  }
  const { error } = await sb.auth.signUp({ email, password });
  if (error) return setMsg('#login-msg', error.message, 'error');
  setMsg('#login-msg', 'Registriert. Melde dich jetzt mit deinem Passwort an.', 'ok');
});

$('#btn-logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  state.user = null; state.profile = null;
  location.reload();
});

async function prepareOnboarding() {
  // Prüfen, ob bereits ein Administrator existiert; wenn nicht, ist dieser User
  // der Erstanmelder und darf die Rolle frei wählen (inkl. Geschäftsführer).
  const { count } = await sb.from('profiles').select('*', { count: 'exact', head: true }).eq('is_admin', true);
  const firstUser = !count;
  const sel = $('#ob-rolle');
  // GF-Option nur zeigen, wenn erster User
  const gfOpt = sel.querySelector('option[value="geschaeftsfuehrer"]');
  if (gfOpt) gfOpt.hidden = !firstUser;
  // Hinweis oben im Onboarding
  const hint = $('#ob-hint');
  if (firstUser) {
    if (!hint) {
      const p = document.createElement('p');
      p.id = 'ob-hint';
      p.className = 'small';
      p.style.color = 'var(--warn)';
      p.textContent = 'Du bist der erste registrierte Benutzer und wirst automatisch Administrator.';
      $('#ob-name').parentNode.parentNode.insertBefore(p, $('#ob-name').parentNode);
    }
  } else if (hint) {
    hint.remove();
  }
}

$('#btn-ob-save').addEventListener('click', async () => {
  const name = $('#ob-name').value.trim();
  const rolle = $('#ob-rolle').value;
  if (!name || !rolle) return setMsg('#ob-msg', 'Name und Rolle erforderlich.', 'error');
  const { error } = await sb.from('profiles').insert({ id: state.user.id, name, rolle });
  if (error) return setMsg('#ob-msg', error.message, 'error');
  await afterAuth(state.user);
});

// ===========================================================================
// DATEN LADEN
// ===========================================================================
async function loadAll() {
  const [bes, aa, ma, ei, au] = await Promise.all([
    sb.from('bestoesser').select('*').order('name'),
    sb.from('arbeitsarten').select('*').eq('aktiv', true).order('name'),
    sb.from('maschinen').select('*').order('name'),
    sb.from('eintraege').select('*').order('datum', { ascending: false }),
    sb.from('aufgaben').select('*').order('erstellt_am', { ascending: false })
  ]);
  if (bes.error) console.error(bes.error);
  if (aa.error) console.error(aa.error);
  if (ma.error) console.error(ma.error);
  if (ei.error) console.error(ei.error);
  if (au.error) console.error(au.error);
  state.bestoesser   = bes.data ?? [];
  state.arbeitsarten = aa.data  ?? [];
  state.maschinen    = ma.data  ?? [];
  state.eintraege    = ei.data  ?? [];
  state.aufgaben     = au.data  ?? [];
}

// ===========================================================================
// TABS
// ===========================================================================
$$('.tab').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab').forEach(b => b.classList.remove('active'));
  $$('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  $('#tab-' + btn.dataset.tab).classList.add('active');
}));

function renderAll() {
  fillBestoesserSelects();
  fillArbeitsartenList();
  fillMaschinenSelect();
  fillMaschinenKatList();
  fillJahrSelects();
  renderEintraege();
  renderAuswertung();
  renderStammdaten();
  renderAufgaben();
  renderAdmin();
}

// ===========================================================================
// ERFASSUNG
// ===========================================================================
$('#e-datum').value = todayISO();

function fillBestoesserSelects() {
  const cur = new Date().getFullYear();
  const pool = state.bestoesser.filter(b => b.jahr === cur && b.aktiv);

  // Erfassen-Dropdown: ein Bestösser darf nur für sich selbst erfassen
  // (canWriteAlp lässt nur den eigenen Datensatz zu). Auswahl daher fixieren,
  // damit keine Option angeboten wird, die beim Speichern abgelehnt würde.
  const eSel = $('#e-bestoesser');
  if (eSel) {
    if (isBestoesser() && state.myBestoesser) {
      eSel.innerHTML = `<option value="${state.myBestoesser.id}">${escapeHtml(state.myBestoesser.name)} (${escapeHtml(alpLabel(state.myBestoesser.alpname))})</option>`;
      eSel.value = state.myBestoesser.id;
      eSel.disabled = true;
    } else {
      const v = eSel.value;
      eSel.innerHTML = '<option value="">— wählen —</option>'
        + pool.map(b => `<option value="${b.id}">${escapeHtml(b.name)} (${escapeHtml(alpLabel(b.alpname))})</option>`).join('');
      if (v && [...eSel.options].some(o => o.value === v)) eSel.value = v;
      else if (state.myBestoesser) eSel.value = state.myBestoesser.id;
      eSel.disabled = false;
    }
  }

  // Filter-Dropdown der Einträge-Liste wird jahresabhängig befüllt.
  fillEintraegeBestoesserSelect();
}

// Bestösser-Filter der Einträge-Liste passend zum gewählten Jahr befüllen –
// Bestösser-Datensätze haben pro Jahr eine eigene ID, sonst greift der Filter
// für frühere Jahre ins Leere und vorhandene Einträge verschwinden.
function fillEintraegeBestoesserSelect() {
  const sel = $('#f-bestoesser');
  if (!sel) return;
  const jahr = Number($('#f-jahr')?.value) || new Date().getFullYear();
  const cur = sel.value;
  const pool = state.bestoesser
    .filter(b => b.jahr === jahr)
    .sort((a,b) => a.name.localeCompare(b.name,'de'));
  sel.innerHTML = '<option value="">alle</option>'
    + pool.map(b => `<option value="${b.id}">${escapeHtml(b.name)} (${escapeHtml(alpLabel(b.alpname))})</option>`).join('');
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

function fillArbeitsartenList() {
  $('#list-arbeitsarten').innerHTML = state.arbeitsarten.map(a => `<option value="${escapeAttr(a.name)}">`).join('');
}

// HTML für die Combobox-Dropdown-Liste (gefiltert).
function buildDropdownHTML(filterTerm = '') {
  const term = filterTerm.trim().toLowerCase();
  const active = state.maschinen.filter(m => m.aktiv !== false);
  const filtered = !term ? active : active.filter(m =>
    m.name.toLowerCase().includes(term)
    || (m.kategorie || '').toLowerCase().includes(term)
  );
  if (filtered.length === 0) {
    return `<div class="m-option-empty">Keine Maschine gefunden.</div>`;
  }
  const groups = {};
  for (const m of filtered) {
    const cat = m.kategorie || 'Übrige';
    (groups[cat] = groups[cat] || []).push(m);
  }
  const parts = [`<div class="m-option" data-id="" data-name="— keine —" data-ansatz="0" data-einheit="">— keine Maschine —</div>`];
  for (const cat of Object.keys(groups).sort((a,b) => a.localeCompare(b,'de'))) {
    parts.push(`<div class="m-opt-group">${escapeHtml(cat)}</div>`);
    for (const m of groups[cat].sort((a,b) => a.name.localeCompare(b.name,'de'))) {
      parts.push(
        `<div class="m-option" data-id="${m.id}" data-name="${escapeAttr(m.name)}" data-ansatz="${m.ansatz}" data-einheit="${escapeAttr(m.einheit)}">` +
          `<strong>${escapeHtml(m.name)}</strong>` +
          `<small>CHF ${fmtCHF(m.ansatz)} / ${escapeHtml(m.einheit)}</small>` +
        `</div>`
      );
    }
  }
  return parts.join('');
}

// Platzhalter (wird von Multi-Row nicht mehr gebraucht, bleibt als no-op für Backwards-Compat)
function fillMaschinenSelect() {}

// Einträge mit gleichen Basisfeldern (Datum, Bestösser, Alp, Arbeit, Bemerkung) zu einer Gruppe zusammenfassen.
function groupEintraege(eintraege) {
  const groups = new Map();
  for (const e of eintraege) {
    const key = [e.datum, e.bestoesser_id, e.alpname, e.arbeit, e.bemerkung ?? ''].join('\x00');
    if (!groups.has(key)) {
      groups.set(key, {
        ...e,
        _ids: [e.id],
        _maschinen: e.maschine_id
          ? [{ maschine_id: e.maschine_id, masch_std: e.masch_std, ansatz: e.ansatz, betrag: e.betrag }]
          : []
      });
    } else {
      const g = groups.get(key);
      g._ids.push(e.id);
      if (e.mann_std) g.mann_std = (Number(g.mann_std) || 0) + Number(e.mann_std);
      if (e.maschine_id) {
        g._maschinen.push({ maschine_id: e.maschine_id, masch_std: e.masch_std, ansatz: e.ansatz, betrag: e.betrag });
      }
    }
  }
  return [...groups.values()];
}

function fillMaschinenKatList() {
  const dl = $('#list-maschinenkat');
  if (!dl) return;
  const cats = [...new Set(state.maschinen.map(m => m.kategorie).filter(Boolean))].sort((a,b) => a.localeCompare(b,'de'));
  dl.innerHTML = cats.map(c => `<option value="${escapeAttr(c)}">`).join('');
}

// Eine Maschinen-Zeile mit Combobox-Suche einfügen.
function addMaschineRow(data) {
  const list = $('#e-maschinen-list');
  if (!list) return;
  const rowIdx = list.children.length;
  const row = document.createElement('div');
  row.className = 'm-row';
  row.innerHTML = `
    <div class="m-header">
      <span>Maschine ${rowIdx + 1}</span>
      <button type="button" class="m-remove" title="Entfernen">✕</button>
    </div>
    <div class="m-combo">
      <input type="search" class="m-search" placeholder="🔍 Maschine suchen oder antippen…" autocomplete="off" />
      <div class="m-dropdown" hidden></div>
    </div>
    <input type="hidden" class="m-id" />
    <div class="two-col">
      <label>Anzahl / Std. / km / m³
        <input class="m-std" type="number" step="0.25" min="0" value="0" inputmode="decimal" />
      </label>
      <label>Ansatz (CHF)
        <input class="m-ansatz" type="number" step="0.01" min="0" value="0" inputmode="decimal" />
      </label>
    </div>
    <div class="m-betrag">CHF 0.00</div>
  `;
  list.appendChild(row);

  const searchInput = row.querySelector('.m-search');
  const dropdown = row.querySelector('.m-dropdown');
  const hiddenId = row.querySelector('.m-id');
  const stdInput = row.querySelector('.m-std');
  const ansatzInput = row.querySelector('.m-ansatz');

  function openDropdown(term = '') {
    dropdown.innerHTML = buildDropdownHTML(term);
    dropdown.hidden = false;
    dropdown.querySelectorAll('.m-option').forEach(opt => {
      opt.addEventListener('mousedown', ev => ev.preventDefault()); // verhindert blur-vor-click
      opt.addEventListener('click', () => {
        hiddenId.value = opt.dataset.id || '';
        searchInput.value = opt.dataset.name === '— keine —' ? '' : (opt.dataset.name || '');
        ansatzInput.value = opt.dataset.id ? (opt.dataset.ansatz || 0) : 0;
        dropdown.hidden = true;
        recalcRowBetrag(row);
      });
    });
  }

  searchInput.addEventListener('focus', () => openDropdown(searchInput.value));
  searchInput.addEventListener('input', () => {
    // Bei aktiver Textänderung: Auswahl verwerfen, bis neu ausgewählt
    hiddenId.value = '';
    openDropdown(searchInput.value);
  });
  // Blur mit kurzer Verzögerung, damit Klick auf Option noch feuert
  searchInput.addEventListener('blur', () => setTimeout(() => { dropdown.hidden = true; }, 150));

  stdInput.addEventListener('input', () => recalcRowBetrag(row));
  ansatzInput.addEventListener('input', () => recalcRowBetrag(row));

  row.querySelector('.m-remove').addEventListener('click', () => {
    row.remove();
    renumberMaschinenRows();
    recalcTotalBetrag();
  });

  // Vorbefüllen beim Bearbeiten
  if (data) {
    if (data.maschine_id) {
      const m = state.maschinen.find(x => x.id === data.maschine_id);
      if (m) {
        hiddenId.value = m.id;
        searchInput.value = m.name;
      }
    }
    stdInput.value = data.masch_std ?? 0;
    ansatzInput.value = data.ansatz ?? 0;
    recalcRowBetrag(row);
  }

  return row;
}

function renumberMaschinenRows() {
  const list = $('#e-maschinen-list');
  if (!list) return;
  [...list.children].forEach((row, idx) => {
    const label = row.querySelector('.m-header span');
    if (label) label.textContent = 'Maschine ' + (idx + 1);
  });
}

function recalcRowBetrag(row) {
  const s = Number(row.querySelector('.m-std').value) || 0;
  const a = Number(row.querySelector('.m-ansatz').value) || 0;
  const betragEl = row.querySelector('.m-betrag');
  const v = s * a;
  betragEl.textContent = 'CHF ' + fmtCHF(v);
  recalcTotalBetrag();
}

function recalcTotalBetrag() {
  const list = $('#e-maschinen-list');
  if (!list) return;
  let total = 0;
  [...list.children].forEach(row => {
    const s = Number(row.querySelector('.m-std').value) || 0;
    const a = Number(row.querySelector('.m-ansatz').value) || 0;
    total += s * a;
  });
  const el = $('#e-betrag-total');
  if (el) el.textContent = 'CHF ' + fmtCHF(total);
}

function resetMaschinenRows() {
  const list = $('#e-maschinen-list');
  if (list) list.innerHTML = '';
  recalcTotalBetrag();
}

function getMaschinenRowsData() {
  const list = $('#e-maschinen-list');
  if (!list) return [];
  return [...list.children].map(row => ({
    maschine_id: row.querySelector('.m-id').value || null,
    masch_std: Number(row.querySelector('.m-std').value) || 0,
    ansatz: Number(row.querySelector('.m-ansatz').value) || 0
  })).filter(r => r.maschine_id || r.masch_std > 0 || r.ansatz > 0);
}

$('#btn-add-maschine')?.addEventListener('click', () => addMaschineRow());

$('#form-eintrag').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  setMsg('#e-msg', 'Speichere …');

  const bestoesser_id = $('#e-bestoesser').value;
  const datum   = $('#e-datum').value;
  const alpname = $('#e-alpname').value;
  const arbeit  = $('#e-arbeit').value.trim();
  const mann    = Number($('#e-mann').value) || 0;
  const bem     = $('#e-bemerkung').value.trim() || null;
  const maschRows = getMaschinenRowsData();

  if (!bestoesser_id) return setMsg('#e-msg', 'Bestösser wählen.', 'error');
  if (!datum || !arbeit) return setMsg('#e-msg', 'Datum und Arbeit erforderlich.', 'error');
  if (!canWriteAlp(alpname, bestoesser_id)) return setMsg('#e-msg', 'Keine Berechtigung für diese Alp / diesen Bestösser.', 'error');

  const base = { bestoesser_id, datum, alpname, arbeit, bemerkung: bem, erstellt_von: state.user.id };

  // Bearbeiten eines bestehenden Eintrags: wir aktualisieren den Haupt-Eintrag
  // (erste Maschine oder keine) und hängen zusätzliche Maschinen als neue Einträge an.
  if (state.editId) {
    const first = maschRows[0] || { maschine_id: null, masch_std: 0, ansatz: 0 };
    const res = await sb.from('eintraege').update({
      ...base, mann_std: mann,
      maschine_id: first.maschine_id, masch_std: first.masch_std, ansatz: first.ansatz
    }).eq('id', state.editId);
    if (res.error) return setMsg('#e-msg', res.error.message, 'error');

    // Alte Zusatz-Einträge der Gruppe löschen
    const otherIds = (state.editIds || []).filter(id => id !== state.editId);
    if (otherIds.length > 0) {
      const delRes = await sb.from('eintraege').delete().in('id', otherIds);
      if (delRes.error) return setMsg('#e-msg', delRes.error.message, 'error');
    }

    // Neue Maschinen (ab Index 1) als zusätzliche Einträge einfügen
    for (let i = 1; i < maschRows.length; i++) {
      const m = maschRows[i];
      const r = await sb.from('eintraege').insert({
        ...base, mann_std: 0,
        maschine_id: m.maschine_id, masch_std: m.masch_std, ansatz: m.ansatz
      });
      if (r.error) return setMsg('#e-msg', r.error.message, 'error');
    }
  } else {
    // Neu anlegen: 1 Eintrag wenn nur Mann-Std / keine Maschine,
    // sonst 1 Eintrag pro Maschine (Mann-Std nur beim ersten Eintrag).
    if (maschRows.length === 0) {
      const r = await sb.from('eintraege').insert({
        ...base, mann_std: mann,
        maschine_id: null, masch_std: 0, ansatz: 0
      });
      if (r.error) return setMsg('#e-msg', r.error.message, 'error');
    } else {
      const rows = maschRows.map((m, idx) => ({
        ...base,
        mann_std: idx === 0 ? mann : 0,
        maschine_id: m.maschine_id,
        masch_std: m.masch_std,
        ansatz: m.ansatz
      }));
      const r = await sb.from('eintraege').insert(rows);
      if (r.error) return setMsg('#e-msg', r.error.message, 'error');
    }
  }

  setMsg('#e-msg', state.editId ? 'Aktualisiert.' : 'Gespeichert.', 'ok');
  state.editId = null;
  state.editIds = null;
  $('#form-eintrag').reset();
  $('#e-datum').value = todayISO();
  resetMaschinenRows();
  await loadAll();
  renderAll();
});

// ===========================================================================
// EINTRÄGE-LISTE
// ===========================================================================
function fillJahrSelects() {
  const years = new Set(state.eintraege.map(e => e.jahr));
  years.add(new Date().getFullYear());
  const sorted = [...years].sort((a,b) => b-a);
  for (const sel of ['#f-jahr', '#a-jahr']) {
    const el = $(sel);
    const cur = el.value || String(new Date().getFullYear());
    el.innerHTML = sorted.map(y => `<option value="${y}">${y}</option>`).join('');
    el.value = cur;
  }
}

['#f-jahr','#f-alpname','#f-bestoesser'].forEach(s => $(s).addEventListener('change', renderEintraege));

function filteredEintraege() {
  const jahr   = Number($('#f-jahr').value) || new Date().getFullYear();
  const alp    = $('#f-alpname').value;
  const best   = $('#f-bestoesser').value;
  return state.eintraege.filter(e =>
    e.jahr === jahr &&
    (!alp  || e.alpname === alp) &&
    (!best || e.bestoesser_id === best)
  );
}

function renderEintraege() {
  fillEintraegeBestoesserSelect();
  const list = $('#eintraege-list');
  const data = filteredEintraege();
  if (!data.length) { list.innerHTML = '<p class="small">Keine Einträge.</p>'; return; }

  const bestMap = Object.fromEntries(state.bestoesser.map(b => [b.id, b]));
  const maschMap = Object.fromEntries(state.maschinen.map(m => [m.id, m]));
  const grouped = groupEintraege(data);

  list.innerHTML = grouped.map(e => {
    const b = bestMap[e.bestoesser_id];
    const canEdit = canWriteAlp(e.alpname, e.bestoesser_id);
    const alpClass = e.alpname === 'Sarn' ? 'alp-sarn' : '';
    const maschinenHtml = e._maschinen.map(md => {
      const m = maschMap[md.maschine_id];
      return m ? `🔧 ${escapeHtml(m.name)} ${fmtNum(md.masch_std)} ${escapeHtml(m.einheit)} × ${fmtCHF(md.ansatz)} = <strong>CHF ${fmtCHF(md.betrag)}</strong>` : '';
    }).filter(Boolean).join('<br>');
    const totalBetrag = e._maschinen.reduce((s, md) => s + Number(md.betrag || 0), 0);
    const allIdsStr = e._ids.join(',');
    return `
      <div class="eintrag-card ${alpClass}">
        <div class="head">
          <span>${fmtDate(e.datum)} · <strong>${escapeHtml(alpLabel(e.alpname))}</strong></span>
          <span>${b ? escapeHtml(b.name) : '—'}</span>
        </div>
        <div class="title">${escapeHtml(e.arbeit)}</div>
        <div class="meta">
          ${e.mann_std ? `👤 ${fmtNum(e.mann_std)} h` : ''}
          ${maschinenHtml ? (e.mann_std ? '<br>' : '') + maschinenHtml : ''}
          ${e._maschinen.length > 1 ? `<br><strong>Maschinen-Total: CHF ${fmtCHF(totalBetrag)}</strong>` : ''}
          ${e.bemerkung ? `<br><em>${escapeHtml(e.bemerkung)}</em>` : ''}
        </div>
        ${canEdit ? `
          <div class="actions">
            <button data-edit="${e._ids[0]}" data-ids="${allIdsStr}">bearbeiten</button>
            <button class="del" data-del="${allIdsStr}">löschen</button>
          </div>` : ''}
      </div>`;
  }).join('');

  list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editEintrag(b.dataset.edit, b.dataset.ids)));
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteEintrag(b.dataset.del)));
}

function editEintrag(id, allIdsStr) {
  const e = state.eintraege.find(x => x.id === id);
  if (!e) return;
  state.editId = id;
  state.editIds = allIdsStr ? allIdsStr.split(',') : [id];
  $('#e-datum').value = e.datum;
  $('#e-bestoesser').value = e.bestoesser_id;
  $('#e-alpname').value = e.alpname;
  $('#e-arbeit').value = e.arbeit;
  $('#e-mann').value = e.mann_std;
  $('#e-bemerkung').value = e.bemerkung || '';
  resetMaschinenRows();
  // Alle Maschinen der Gruppe laden
  state.eintraege
    .filter(x => state.editIds.includes(x.id) && x.maschine_id)
    .forEach(ge => addMaschineRow({ maschine_id: ge.maschine_id, masch_std: ge.masch_std, ansatz: ge.ansatz }));
  $$('.tab')[0].click();
  setMsg('#e-msg', 'Eintrag wird bearbeitet. "Speichern" zum Übernehmen.', 'ok');
}

async function deleteEintrag(idsStr) {
  if (!confirm('Eintrag wirklich löschen?')) return;
  const ids = idsStr.split(',');
  const { error } = await sb.from('eintraege').delete().in('id', ids);
  if (error) return alert(error.message);
  await loadAll(); renderAll();
}

// ===========================================================================
// AUSWERTUNG
// ===========================================================================
['#a-jahr','#a-alpname','#a-bestoesser','#a-arbeit'].forEach(s => {
  const el = $(s);
  if (el) el.addEventListener(s === '#a-arbeit' ? 'input' : 'change', renderAuswertung);
});

function currentAuswertungFilter() {
  const f = {
    jahr:       Number($('#a-jahr').value) || new Date().getFullYear(),
    alp:        $('#a-alpname')?.value || '',
    bestId:     $('#a-bestoesser')?.value || '',
    arbeitTerm: ($('#a-arbeit')?.value || '').trim().toLowerCase()
  };
  // Bestösser: immer nur die eigenen Einträge – aber über ALLE Alpen hinweg,
  // damit auch Stunden sichtbar sind, die auf einer anderen als der
  // registrierten Alp erfasst wurden. Die Alp bleibt ein optionaler Filter.
  if (isBestoesser() && state.myBestoesser) {
    f.bestId = state.myBestoesser.id;
  }
  return f;
}

function auswertungData(f) {
  let eintraege = state.eintraege.filter(e => e.jahr === f.jahr);
  if (f.alp)        eintraege = eintraege.filter(e => e.alpname === f.alp);
  if (f.bestId)     eintraege = eintraege.filter(e => e.bestoesser_id === f.bestId);
  if (f.arbeitTerm) eintraege = eintraege.filter(e =>
      (e.arbeit || '').toLowerCase().includes(f.arbeitTerm) ||
      (e.bemerkung || '').toLowerCase().includes(f.arbeitTerm));

  let bestList = state.bestoesser.filter(b => b.jahr === f.jahr);
  if (f.alp)    bestList = bestList.filter(b => b.alpname === f.alp);
  if (f.bestId) bestList = bestList.filter(b => b.id === f.bestId);

  const byBest = {};
  for (const b of bestList) {
    byBest[b.id] = { best: b, eintraege: [], mann_std: 0, betrag: 0, soll_std: Number(b.nst) * 2 };
  }
  for (const e of eintraege) {
    if (byBest[e.bestoesser_id]) {
      byBest[e.bestoesser_id].eintraege.push(e);
      byBest[e.bestoesser_id].mann_std += Number(e.mann_std || 0);
      byBest[e.bestoesser_id].betrag += Number(e.betrag || 0);
    }
  }
  // Summen nach Alp (nur die 2 Alpen)
  const byAlp = { Portein: { mann: 0, betrag: 0 }, Sarn: { mann: 0, betrag: 0 } };
  for (const e of eintraege) {
    if (!byAlp[e.alpname]) byAlp[e.alpname] = { mann: 0, betrag: 0 };
    byAlp[e.alpname].mann   += Number(e.mann_std || 0);
    byAlp[e.alpname].betrag += Number(e.betrag   || 0);
  }
  return { eintraege, byBest, byAlp, jahr: f.jahr, filter: f };
}

function fillAuswertungSelects() {
  const jahr = Number($('#a-jahr').value) || new Date().getFullYear();
  const alpSel  = $('#a-alpname');
  const bestSel = $('#a-bestoesser');

  // Bestösser: nur der Bestösser-Filter ist fixiert (eigene Daten). Die Alp
  // bleibt frei wählbar ("alle" als Default), damit auch Stunden auf einer
  // anderen als der registrierten Alp sichtbar sind.
  if (isBestoesser() && state.myBestoesser) {
    if (alpSel) alpSel.disabled = false;
    if (bestSel) {
      bestSel.innerHTML = `<option value="${state.myBestoesser.id}">${escapeHtml(state.myBestoesser.name)}</option>`;
      bestSel.value = state.myBestoesser.id;
      bestSel.disabled = true;
    }
    return;
  }

  // Alle anderen Rollen: Bestösser-Dropdown abhängig vom gewählten Alp füllen
  if (alpSel) alpSel.disabled = false;
  if (bestSel) {
    bestSel.disabled = false;
    const cur = bestSel.value;
    const alp = alpSel?.value || '';
    let pool = state.bestoesser.filter(b => b.jahr === jahr && b.aktiv);
    if (alp) pool = pool.filter(b => b.alpname === alp);
    bestSel.innerHTML = '<option value="">alle</option>' +
      pool.sort((a,b)=>a.name.localeCompare(b.name,'de'))
          .map(b => `<option value="${b.id}">${escapeHtml(b.name)} (${escapeHtml(alpLabel(b.alpname))})</option>`).join('');
    if ([...bestSel.options].some(o => o.value === cur)) bestSel.value = cur;
  }
}

function renderAuswertung() {
  fillAuswertungSelects();
  const f = currentAuswertungFilter();
  const { byBest, byAlp, eintraege, jahr } = auswertungData(f);
  const totalMann = eintraege.reduce((s,e) => s + Number(e.mann_std||0), 0);
  const totalBetrag = eintraege.reduce((s,e) => s + Number(e.betrag||0), 0);

  // Filter-Badge oberhalb (nicht für Bestösser, weil Filter dort erzwungen sind)
  let filterInfo = '';
  if (!isBestoesser()) {
    const badges = [];
    if (f.alp) badges.push(`Alp: <strong>${escapeHtml(alpLabel(f.alp))}</strong>`);
    if (f.bestId) {
      const b = state.bestoesser.find(x => x.id === f.bestId);
      if (b) badges.push(`Bestösser: <strong>${escapeHtml(b.name)}</strong>`);
    }
    if (f.arbeitTerm) badges.push(`Arbeit enthält: <strong>${escapeHtml(f.arbeitTerm)}</strong>`);
    if (badges.length) filterInfo = `<p class="small">Filter aktiv: ${badges.join(' · ')}</p>`;
  }

  // Bestösser sieht nur die eigene Alp-Zeile
  const alpEntries = isBestoesser() && state.myBestoesser
    ? Object.entries(byAlp).filter(([a]) => a === state.myBestoesser.alpname)
    : Object.entries(byAlp);

  const titel = isBestoesser() ? `Meine Leistung ${jahr}` : `Jahresübersicht ${jahr}`;

  let html = `
    <div class="auswertung-section">
      <h3>${titel}</h3>
      ${filterInfo}
      <div class="summary-grid">
        <div class="summary-card"><div class="lab">Einträge</div><div class="val">${eintraege.length}</div></div>
        <div class="summary-card"><div class="lab">Mann-Stunden total</div><div class="val">${fmtNum(totalMann)} h</div></div>
        <div class="summary-card"><div class="lab">Maschinen-Betrag</div><div class="val">CHF ${fmtCHF(totalBetrag)}</div></div>
      </div>
      ${isBestoesser() ? '' : `
      <h4>Nach Alp</h4>
      <div class="table-wrap"><table class="rapport">
        <thead><tr><th>Alp</th><th class="num">Mann-Std.</th><th class="num">Betrag CHF</th></tr></thead>
        <tbody>
          ${alpEntries.map(([a,v]) => `
            <tr><td>${escapeHtml(alpLabel(a))}</td><td class="num">${fmtNum(v.mann)}</td><td class="num">${fmtCHF(v.betrag)}</td></tr>`).join('')}
          <tr class="total"><td>Total</td><td class="num">${fmtNum(totalMann)}</td><td class="num">${fmtCHF(totalBetrag)}</td></tr>
        </tbody>
      </table></div>`}
    </div>`;

  // Pro Bestösser: Rapport im Original-Layout
  for (const entry of Object.values(byBest).sort((a,b) => a.best.name.localeCompare(b.best.name))) {
    const b = entry.best;
    const rest = entry.soll_std - entry.mann_std;
    html += `
      <div class="auswertung-section">
        <h3>${escapeHtml(b.name)} · ${escapeHtml(b.alpname)}</h3>
        <div class="summary-grid">
          <div class="summary-card"><div class="lab">NST</div><div class="val">${fmtNum(b.nst)}</div></div>
          <div class="summary-card"><div class="lab">Sollstunden (NST × 2)</div><div class="val">${fmtNum(entry.soll_std)} h</div></div>
          <div class="summary-card"><div class="lab">Geleistet</div><div class="val">${fmtNum(entry.mann_std)} h</div></div>
          <div class="summary-card"><div class="lab">Differenz</div><div class="val" style="color:${rest>0?'var(--warn)':'var(--green-dark)'}">${rest>0?'-':'+'}${fmtNum(Math.abs(rest))} h</div></div>
          <div class="summary-card"><div class="lab">Maschinen-Betrag</div><div class="val">CHF ${fmtCHF(entry.betrag)}</div></div>
        </div>
        <div class="table-wrap"><table class="rapport">
          <thead><tr>
            <th>Datum</th><th>Alp</th><th>Arbeit</th><th class="num">Mann-Std.</th>
            <th>Maschine</th><th class="num">Masch.-Std.</th><th class="num">Ansatz</th><th class="num">Betrag</th>
          </tr></thead>
          <tbody>
            ${entry.eintraege.sort((a,b) => a.datum.localeCompare(b.datum)).map(e => {
              const m = e.maschine_id ? state.maschinen.find(x => x.id === e.maschine_id) : null;
              return `<tr>
                <td>${fmtDate(e.datum)}</td>
                <td>${escapeHtml(alpLabel(e.alpname))}</td>
                <td>${escapeHtml(e.arbeit)}${e.bemerkung ? '<br><em class="small">'+escapeHtml(e.bemerkung)+'</em>' : ''}</td>
                <td class="num">${e.mann_std ? fmtNum(e.mann_std) : ''}</td>
                <td>${m ? escapeHtml(m.name) : ''}</td>
                <td class="num">${e.masch_std ? fmtNum(e.masch_std) : ''}</td>
                <td class="num">${e.ansatz ? fmtCHF(e.ansatz) : ''}</td>
                <td class="num">${e.betrag ? fmtCHF(e.betrag) : ''}</td>
              </tr>`;
            }).join('')}
            <tr class="total">
              <td colspan="3">Total</td>
              <td class="num">${fmtNum(entry.mann_std)}</td>
              <td colspan="3"></td>
              <td class="num">${fmtCHF(entry.betrag)}</td>
            </tr>
          </tbody>
        </table></div>
      </div>`;
  }

  $('#auswertung-content').innerHTML = html || '<p>Keine Daten für dieses Jahr.</p>';
}

// ===========================================================================
// EXPORTE
// ===========================================================================
$('#btn-export-pdf').addEventListener('click', exportPDF);
$('#btn-export-xlsx').addEventListener('click', exportXLSX);

function exportFilenameSuffix(f) {
  const parts = [];
  if (f.alp) parts.push(f.alp);
  if (f.bestId) {
    const b = state.bestoesser.find(x => x.id === f.bestId);
    if (b) parts.push(b.name.replace(/\s+/g,'_'));
  }
  if (f.arbeitTerm) parts.push(f.arbeitTerm.replace(/\s+/g,'_').slice(0,20));
  return parts.length ? '_' + parts.join('_') : '';
}

function exportPDF() {
  const f = currentAuswertungFilter();
  const { byBest, jahr } = auswertungData(f);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  let first = true;
  for (const entry of Object.values(byBest).sort((a,b) => a.best.name.localeCompare(b.best.name))) {
    if (!first) doc.addPage();
    first = false;
    const b = entry.best;
    doc.setFontSize(14); doc.text(`Pflichtarbeiten ${jahr}`, 14, 14);
    doc.setFontSize(10);
    doc.text(`Name Bestösser: ${b.name}`, 14, 22);
    doc.text(`Alp: ${alpLabel(b.alpname)}`, 14, 28);
    doc.text(`NST: ${fmtNum(b.nst)}   Sollstunden: ${fmtNum(entry.soll_std)} h   Geleistet: ${fmtNum(entry.mann_std)} h`, 14, 34);

    const rows = entry.eintraege.sort((a,b) => a.datum.localeCompare(b.datum)).map(e => {
      const m = e.maschine_id ? state.maschinen.find(x => x.id === e.maschine_id) : null;
      return [
        fmtDate(e.datum), alpLabel(e.alpname), e.arbeit + (e.bemerkung ? ' ('+e.bemerkung+')' : ''),
        e.mann_std ? fmtNum(e.mann_std) : '',
        m ? m.name : '',
        e.masch_std ? fmtNum(e.masch_std) : '',
        e.ansatz ? fmtCHF(e.ansatz) : '',
        e.betrag ? fmtCHF(e.betrag) : ''
      ];
    });
    rows.push([
      { content: 'Total', colSpan: 3, styles: { fontStyle: 'bold' } },
      { content: fmtNum(entry.mann_std), styles: { halign: 'right', fontStyle: 'bold' } },
      '', '', '',
      { content: fmtCHF(entry.betrag), styles: { halign: 'right', fontStyle: 'bold' } }
    ]);

    doc.autoTable({
      startY: 40,
      head: [['Datum','Alp','Art der Arbeit','Mann-Std.','Maschine','Masch.-Std.','Ansatz','Betrag']],
      body: rows,
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [58, 107, 53], textColor: 255 },
      columnStyles: {
        3: { halign: 'right' }, 5: { halign: 'right' },
        6: { halign: 'right' }, 7: { halign: 'right' }
      }
    });
  }

  if (first) { doc.text('Keine Daten für diese Auswahl.', 14, 30); }
  doc.save(`Rapport_${jahr}${exportFilenameSuffix(f)}.pdf`);
}

function exportXLSX() {
  const f = currentAuswertungFilter();
  const { byBest, jahr } = auswertungData(f);
  const wb = XLSX.utils.book_new();

  for (const entry of Object.values(byBest).sort((a,b) => a.best.name.localeCompare(b.best.name))) {
    const b = entry.best;
    // Layout nachempfunden dem Original Arbeitsrapport.xlsx
    const aoa = [
      ['LBG Sarn'],
      [`Pflichtarbeiten ${jahr}`],
      [],
      ['Name Bestösser:', '', b.name],
      ['Alp:', '', alpLabel(b.alpname)],
      [],
      ['Bestossung', '', ''],
      ['NST', b.nst],
      ['Sollstunden', entry.soll_std, entry.soll_std - entry.mann_std],
      [],
      ['Rapport Pflichtarbeiten:'],
      [],
      ['Datum', 'Alpname', 'Art der Arbeit', 'Mann-Std.', 'Eingesetzte Maschinen', 'Masch.-Std.', 'Ansatz', 'Betrag'],
    ];
    for (const e of entry.eintraege.sort((a,b) => a.datum.localeCompare(b.datum))) {
      const m = e.maschine_id ? state.maschinen.find(x => x.id === e.maschine_id) : null;
      aoa.push([
        new Date(e.datum), alpLabel(e.alpname), e.arbeit + (e.bemerkung ? ' ('+e.bemerkung+')' : ''),
        e.mann_std ? Number(e.mann_std) : '',
        m ? m.name : '',
        e.masch_std ? Number(e.masch_std) : '',
        e.ansatz ? Number(e.ansatz) : '',
        e.betrag ? Number(e.betrag) : ''
      ]);
    }
    // Total-Zeile mit Formeln (Header in Excel-Zeile 13, erste Datenzeile 14)
    const firstRow = 14;
    const lastRow = 13 + entry.eintraege.length;
    aoa.push([
      'Total', '', '',
      { f: `SUM(D${firstRow}:D${lastRow})` },
      '', '', '',
      { f: `SUM(H${firstRow}:H${lastRow})` }
    ]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{wch:12},{wch:14},{wch:30},{wch:10},{wch:24},{wch:11},{wch:10},{wch:12}];
    // Datumsformat auf Datenzeilen (0-indexed ab 13)
    for (let r = 13; r < 13 + entry.eintraege.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
      if (cell && cell.v instanceof Date) cell.z = 'dd.mm.yyyy';
    }
    // Kurzer, Excel-kompatibler Sheet-Name
    const safeName = b.name.replace(/[\\/*?:[\]]/g, '').slice(0, 28);
    XLSX.utils.book_append_sheet(wb, ws, safeName || 'Bestösser');
  }

  // Übersichts-Tabelle
  const sum = [['Jahresübersicht ' + jahr], []];
  // Filter-Info
  const badges = [];
  if (f.alp)        badges.push('Alp: ' + alpLabel(f.alp));
  if (f.bestId)     { const bb = state.bestoesser.find(x => x.id === f.bestId); if (bb) badges.push('Bestösser: ' + bb.name); }
  if (f.arbeitTerm) badges.push('Arbeit enthält: ' + f.arbeitTerm);
  if (badges.length) { sum.push(['Filter:', badges.join(' · ')]); sum.push([]); }
  sum.push(['Bestösser','Alp','NST','Soll-Std.','Geleistet','Diff.','Maschinen-Betrag CHF']);
  for (const entry of Object.values(byBest).sort((a,b) => a.best.name.localeCompare(b.best.name))) {
    sum.push([
      entry.best.name, alpLabel(entry.best.alpname),
      Number(entry.best.nst), Number(entry.soll_std),
      Number(entry.mann_std), Number(entry.soll_std - entry.mann_std),
      Number(entry.betrag)
    ]);
  }
  const wsSum = XLSX.utils.aoa_to_sheet(sum);
  wsSum['!cols'] = [{wch:22},{wch:14},{wch:8},{wch:10},{wch:10},{wch:10},{wch:18}];
  XLSX.utils.book_append_sheet(wb, wsSum, 'Übersicht');

  XLSX.writeFile(wb, `Arbeitsrapport_${jahr}${exportFilenameSuffix(f)}.xlsx`);
}

// ===========================================================================
// STAMMDATEN
// ===========================================================================
$('#b-jahr').value = new Date().getFullYear();

$('#form-bestoesser').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (isBestoesser()) return alert('Nur Alpmeister oder Geschäftsführer.');
  const row = {
    name: $('#b-name').value.trim(),
    nst: Number($('#b-nst').value),
    alpname: $('#b-alpname').value,
    jahr: Number($('#b-jahr').value)
  };
  const { error } = await sb.from('bestoesser').insert(row);
  if (error) return alert(error.message);
  $('#form-bestoesser').reset();
  $('#b-jahr').value = new Date().getFullYear();
  await loadAll(); renderAll();
});

$('#form-maschine').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!canEditMaster()) return setMsg('#m-msg', 'Keine Berechtigung.', 'error');
  const name = $('#m-name').value.trim();
  const ansatz = Number($('#m-ansatz').value);
  const einheit = $('#m-einheit').value.trim() || 'Std.';
  const kategorie = $('#m-kategorie').value.trim() || null;
  if (!name) return setMsg('#m-msg', 'Name erforderlich.', 'error');
  if (!Number.isFinite(ansatz)) return setMsg('#m-msg', 'Ansatz muss eine Zahl sein.', 'error');
  setMsg('#m-msg', 'Speichere …');
  const { error } = await sb.from('maschinen').insert({ name, ansatz, einheit, kategorie });
  if (error) return setMsg('#m-msg', error.message, 'error');
  setMsg('#m-msg', `"${name}" gespeichert.`, 'ok');
  $('#m-name').value = '';
  $('#m-ansatz').value = '';
  $('#m-einheit').value = 'Std.';
  $('#m-kategorie').value = '';
  await loadAll(); renderAll();
});

$('#form-arbeitsart').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!canEditMaster()) return alert('Keine Berechtigung.');
  const { error } = await sb.from('arbeitsarten').insert({ name: $('#aa-name').value.trim() });
  if (error) return alert(error.message);
  $('#form-arbeitsart').reset();
  await loadAll(); renderAll();
});

async function vorjahrUebernehmen(prevRows, curYear) {
  if (!confirm(`Alle ${prevRows.length} aktiven Bestösser aus Jahr ${curYear-1} ins Jahr ${curYear} übernehmen?\nNST und Alp bleiben; die User-Zuordnung muss neu erfolgen.`)) return;
  // Neue Einfügungen ohne user_id, damit sich jeder neu zuordnen kann.
  const payload = prevRows.map(b => ({
    name: b.name, nst: b.nst, alpname: b.alpname, jahr: curYear, aktiv: true
  }));
  const { error } = await sb.from('bestoesser').insert(payload);
  if (error) return alert(error.message);
  await loadAll(); renderAll();
}

function renderStammdaten() {
  // --- Bestösser ---
  const curYear = new Date().getFullYear();
  const jahre = [...new Set(state.bestoesser.map(b => b.jahr))].sort((a,b) => b-a);
  if (!jahre.includes(curYear)) jahre.unshift(curYear);

  // „Vorjahr übernehmen"-Banner bauen, wenn nichts für aktuelles Jahr
  const countCurYear = state.bestoesser.filter(b => b.jahr === curYear).length;
  const prevYear = curYear - 1;
  const prevActive = state.bestoesser.filter(b => b.jahr === prevYear && b.aktiv);
  let banner = '';
  if (canEditMaster() && countCurYear === 0 && prevActive.length > 0) {
    banner = `
      <div class="year-banner">
        <strong>Neues Jahr ${curYear}:</strong> Es gibt noch keine Bestösser.
        <button class="primary" id="btn-uebernehme-vorjahr">Aus Jahr ${prevYear} übernehmen (${prevActive.length})</button>
      </div>`;
  }

  const rows = state.bestoesser
    .slice()
    .sort((a,b) => b.jahr - a.jahr || a.name.localeCompare(b.name,'de'))
    .map(b => {
      const canEdit = canEditMaster();
      return `
        <div class="sd-row bestoesser-row" data-bid="${b.id}">
          <span class="name">
            <strong data-show="name">${escapeHtml(b.name)}</strong> ·
            <span data-show="alp">${escapeHtml(alpLabel(b.alpname))}</span> ·
            NST <span data-show="nst">${fmtNum(b.nst)}</span> ·
            ${b.jahr}${b.user_id ? ' · <span class="small">angemeldet</span>' : ''}
          </span>
          <span data-edit-controls hidden>
            <input type="text" data-edit="name" value="${escapeAttr(b.name)}" style="width:12em" placeholder="Name" />
            <select data-edit="alpname">
              <option value="Portein"${b.alpname==='Portein'?' selected':''}>Porteineralp</option>
              <option value="Sarn"${b.alpname==='Sarn'?' selected':''}>Sarneralp</option>
            </select>
            <input type="number" step="0.1" min="0" data-edit="nst" value="${b.nst}" style="width:6em" />
            <button data-save>✓</button>
            <button data-cancel>✕</button>
          </span>
          ${canEdit ? `
            <button data-edit-b title="Bearbeiten">✎</button>
            <button data-del-b title="Löschen">✕</button>` : ''}
        </div>`;
    }).join('');

  $('#bestoesser-list').innerHTML = banner + (rows || '<p class="small">Noch keine Bestösser.</p>');

  // Übernehme-Vorjahr-Button
  $('#btn-uebernehme-vorjahr')?.addEventListener('click', () => vorjahrUebernehmen(prevActive, curYear));

  // Bearbeiten / Speichern / Löschen
  $$('#bestoesser-list .bestoesser-row').forEach(row => {
    const bid = row.dataset.bid;
    row.querySelector('[data-edit-b]')?.addEventListener('click', () => {
      row.querySelector('[data-edit-controls]').hidden = false;
      row.querySelectorAll('[data-edit-b], [data-del-b]').forEach(b => b.hidden = true);
    });
    row.querySelector('[data-cancel]')?.addEventListener('click', () => {
      row.querySelector('[data-edit-controls]').hidden = true;
      row.querySelectorAll('[data-edit-b], [data-del-b]').forEach(b => b.hidden = false);
    });
    row.querySelector('[data-save]')?.addEventListener('click', async () => {
      const name = row.querySelector('[data-edit="name"]').value.trim();
      const alp  = row.querySelector('[data-edit="alpname"]').value;
      const nst  = Number(row.querySelector('[data-edit="nst"]').value);
      if (!name) return alert('Name darf nicht leer sein.');
      const { error } = await sb.from('bestoesser').update({ name, alpname: alp, nst }).eq('id', bid);
      if (error) return alert(error.message);
      await loadAll(); renderAll();
    });
    row.querySelector('[data-del-b]')?.addEventListener('click', async () => {
      if (!confirm('Bestösser und alle Einträge löschen?')) return;
      const { error } = await sb.from('bestoesser').delete().eq('id', bid);
      if (error) return alert(error.message);
      await loadAll(); renderAll();
    });
  });

  // Maschinen nach Kategorie gruppiert (nur aktive im Admin-View)
  const mg = {};
  for (const m of state.maschinen.filter(x => x.aktiv !== false))
    (mg[m.kategorie || 'Übrige'] = mg[m.kategorie || 'Übrige'] || []).push(m);
  const mParts = [];
  for (const cat of Object.keys(mg).sort((a,b) => a.localeCompare(b,'de'))) {
    mParts.push(`<h4 class="small" style="margin:.6rem 0 .2rem;color:var(--green-dark)">${escapeHtml(cat)}</h4>`);
    for (const m of mg[cat].sort((a,b) => a.name.localeCompare(b.name,'de'))) {
      mParts.push(`
      <div class="sd-row maschine-row" data-mid="${m.id}">
        <span class="name" data-show="info">${escapeHtml(m.name)} · CHF ${fmtCHF(m.ansatz)} / ${escapeHtml(m.einheit)}${m.quelle ? ` · <span class="small">${escapeHtml(m.quelle)}</span>` : ''}</span>
        <span data-edit-controls hidden>
          <input type="text" data-edit="name" value="${escapeAttr(m.name)}" style="width:16em" placeholder="Name" />
          <input type="number" step="0.01" min="0" data-edit="ansatz" value="${m.ansatz}" style="width:6em" />
          <input type="text" data-edit="einheit" value="${escapeAttr(m.einheit)}" style="width:5em" placeholder="Einheit" />
          <input type="text" data-edit="kategorie" value="${escapeAttr(m.kategorie||'')}" style="width:9em" placeholder="Kategorie" />
          <button data-save>✓</button>
          <button data-cancel>✕</button>
        </span>
        ${canEditMaster() ? `<button data-edit-m title="Bearbeiten">✎</button><button data-del-m title="Löschen">✕</button>` : ''}
      </div>`);
    }
  }
  $('#maschinen-list').innerHTML = mParts.join('') || '<p class="small">Keine Maschinen.</p>';
  $$('#maschinen-list .maschine-row').forEach(row => {
    const mid = row.dataset.mid;
    row.querySelector('[data-edit-m]')?.addEventListener('click', () => {
      row.querySelector('[data-show="info"]').hidden = true;
      row.querySelector('[data-edit-controls]').hidden = false;
      row.querySelectorAll('[data-edit-m],[data-del-m]').forEach(b => b.hidden = true);
    });
    row.querySelector('[data-cancel]')?.addEventListener('click', () => {
      row.querySelector('[data-show="info"]').hidden = false;
      row.querySelector('[data-edit-controls]').hidden = true;
      row.querySelectorAll('[data-edit-m],[data-del-m]').forEach(b => b.hidden = false);
    });
    row.querySelector('[data-save]')?.addEventListener('click', async () => {
      const name     = row.querySelector('[data-edit="name"]').value.trim();
      const ansatz   = Number(row.querySelector('[data-edit="ansatz"]').value);
      const einheit  = row.querySelector('[data-edit="einheit"]').value.trim() || 'Std.';
      const kategorie= row.querySelector('[data-edit="kategorie"]').value.trim() || null;
      if (!name || !Number.isFinite(ansatz)) return alert('Name und Ansatz erforderlich.');

      // Prüfen ob sich der Ansatz geändert hat
      const oldMaschine = state.maschinen.find(x => x.id === mid);
      const ansatzGeaendert = oldMaschine && Number(oldMaschine.ansatz) !== ansatz;

      const { error } = await sb.from('maschinen').update({ name, ansatz, einheit, kategorie }).eq('id', mid);
      if (error) return alert(error.message);

      // Ansatz in bestehenden Einträgen nachführen
      if (ansatzGeaendert) {
        const betroffene = state.eintraege.filter(e => e.maschine_id === mid);
        if (betroffene.length > 0) {
          const { error: eErr } = await sb.from('eintraege').update({ ansatz }).eq('maschine_id', mid);
          if (eErr) return alert('Maschine gespeichert, aber Einträge konnten nicht aktualisiert werden: ' + eErr.message);
        }
      }

      await loadAll(); renderAll();
    });
    row.querySelector('[data-del-m]')?.addEventListener('click', async () => {
      const m = state.maschinen.find(x => x.id === mid);
      if (!confirm(`Maschine "${m?.name}" deaktivieren?`)) return;
      const { error } = await sb.from('maschinen').update({ aktiv: false }).eq('id', mid);
      if (error) return alert(error.message);
      await loadAll(); renderAll();
    });
  });

  // Arbeitsarten
  $('#arbeitsarten-list').innerHTML = state.arbeitsarten.map(a => `
    <div class="sd-row">
      <span class="name">${escapeHtml(a.name)}</span>
      ${canEditMaster() ? `<button data-del-a="${a.id}" title="Löschen">✕</button>` : ''}
    </div>`).join('') || '<p class="small">Keine Arbeitsarten.</p>';
  $$('#arbeitsarten-list [data-del-a]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Arbeitsart deaktivieren?')) return;
    const { error } = await sb.from('arbeitsarten').update({ aktiv: false }).eq('id', btn.dataset.delA);
    if (error) return alert(error.message);
    await loadAll(); renderAll();
  }));
}

// ===========================================================================
// AUFGABEN (To-Dos)
// ===========================================================================
let editAufgabeId = null;

function prioChipClass(p) { return 'chip prio-' + (p || 'normal'); }
function istUeberfaellig(a) {
  if (!a.frist || a.status === 'erledigt') return false;
  return a.frist < todayISO();
}

function fillAufgabenSelects() {
  // Zuweisen-Dropdown: alle Profile (für Admin/GF/Alpmeister sichtbar via RLS auf profiles)
  const sel = $('#t-zugewiesen');
  if (!sel) return;
  const cur = sel.value;
  // state.profiles wird nur bei Admin geladen; sonst aus state.bestoesser user_ids + eigenem Profil bauen
  const pool = (state.profiles && state.profiles.length)
    ? state.profiles
    : [state.profile, ...state.bestoesser.filter(b => b.user_id).map(b => ({ id: b.user_id, name: b.name, rolle: 'bestoesser' }))]
        .filter(Boolean);
  sel.innerHTML = '<option value="">— offen, alle dürfen übernehmen —</option>' +
    pool.filter(p => p && p.id)
        .sort((a,b) => (a.name||'').localeCompare(b.name||'','de'))
        .map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(rolleLabel(p.rolle||''))})</option>`).join('');
  sel.value = cur;
}

function currentAufgabenFilter() {
  return {
    status: $('#f-status')?.value ?? 'offen',
    alp: $('#f-a-alpname')?.value ?? '',
    zug: $('#f-a-zug')?.value ?? '',
  };
}

function filteredAufgaben() {
  const f = currentAufgabenFilter();
  let data = state.aufgaben.slice();
  if (f.status) data = data.filter(a => a.status === f.status);
  if (f.alp)    data = data.filter(a => a.alpname === f.alp);
  if (f.zug === 'me')   data = data.filter(a => a.zugewiesen_an === state.user?.id);
  if (f.zug === 'none') data = data.filter(a => !a.zugewiesen_an);
  // Bestösser sieht eigene Zuweisungen + alle noch nicht übernommenen Aufgaben
  // beider Alpen – er darf auf beiden Alpen mithelfen und erfassen. Über den
  // Alp-Filter oben lässt sich die Ansicht bei Bedarf eingrenzen.
  if (isBestoesser()) {
    data = data.filter(a =>
      a.zugewiesen_an === state.user.id
      || !a.zugewiesen_an
    );
  }
  return data;
}

function renderAufgaben() {
  fillAufgabenSelects();
  const btn = $('#btn-aufgabe-neu');
  if (btn) btn.classList.toggle('hidden', !canCreateAufgaben());
  // Formular (neu/edit) nur für Aufgaben-Ersteller sichtbar, falls offen
  const form = $('#form-aufgabe');
  if (form && !canCreateAufgaben()) form.hidden = true;

  const list = $('#aufgaben-list');
  if (!list) return;
  const data = filteredAufgaben();
  if (!data.length) { list.innerHTML = '<p class="small">Keine Aufgaben.</p>'; return; }

  const userMap = {};
  (state.profiles || []).forEach(p => userMap[p.id] = p);
  state.bestoesser.filter(b => b.user_id).forEach(b => { if (!userMap[b.user_id]) userMap[b.user_id] = { name: b.name, rolle: 'bestoesser' }; });
  if (state.profile) userMap[state.profile.id] = state.profile;

  list.innerHTML = data.map(a => {
    const canDelete = canCreateAufgaben();
    const canEdit   = canCreateAufgaben();
    const canClose  = canCreateAufgaben() || a.zugewiesen_an === state.user?.id || (!a.zugewiesen_an);
    const canTakeOver = a.status === 'offen' && !a.zugewiesen_an && state.user?.id;
    const ueberfaellig = istUeberfaellig(a);
    const classes = [
      a.status === 'erledigt' ? 'erledigt' : '',
      a.alpname === 'Sarn' ? 'alp-sarn' : '',
      a.prioritaet === 'hoch' ? 'prio-hoch' : '',
    ].filter(Boolean).join(' ');
    const assignee = a.zugewiesen_an
      ? escapeHtml(userMap[a.zugewiesen_an]?.name || 'Unbekannt')
      : '<em>offen — noch nicht übernommen</em>';
    return `
      <div class="aufgabe-card ${classes}" data-aid="${a.id}">
        <div class="a-head">
          <span>${a.alpname ? escapeHtml(alpLabel(a.alpname)) : 'beide Alpen'} · Übernommen von: ${assignee}</span>
          <span>${a.frist ? (ueberfaellig ? '<span class="chip frist-ueberfaellig">Frist: '+fmtDate(a.frist)+'</span>' : 'Frist: '+fmtDate(a.frist)) : ''}</span>
        </div>
        <div class="a-title">${escapeHtml(a.titel)} <span class="${prioChipClass(a.prioritaet)}">${escapeHtml(a.prioritaet)}</span></div>
        ${a.beschreibung ? `<div class="a-desc">${escapeHtml(a.beschreibung)}</div>` : ''}
        <div class="a-meta">
          ${a.status === 'erledigt' && a.erledigt_am ? `✓ erledigt am ${fmtDate(a.erledigt_am)}${a.erledigt_von && userMap[a.erledigt_von] ? ' von '+escapeHtml(userMap[a.erledigt_von].name) : ''}` : ''}
        </div>
        <div class="a-actions">
          ${canTakeOver ? `<button data-takeover>Übernehmen</button>` : ''}
          ${a.status === 'offen'
            ? (canClose ? `<button class="primary" data-close>✓ erledigen</button>` : '')
            : (canCreateAufgaben() ? `<button data-reopen>↺ wieder öffnen</button>` : '')
          }
          ${a.status === 'offen' && a.alpname
            ? `<button data-to-eintrag>→ als Eintrag übernehmen</button>` : ''}
          ${canEdit   ? `<button data-edit>bearbeiten</button>` : ''}
          ${canDelete ? `<button class="del" data-del>löschen</button>` : ''}
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.aufgabe-card').forEach(card => {
    const aid = card.dataset.aid;
    const a = state.aufgaben.find(x => x.id === aid);
    card.querySelector('[data-takeover]')?.addEventListener('click', async () => {
      const { error } = await sb.from('aufgaben').update({ zugewiesen_an: state.user.id }).eq('id', aid);
      if (error) return alert(error.message);
      await loadAll(); renderAll();
    });
    card.querySelector('[data-close]')?.addEventListener('click', async () => {
      const upd = { status: 'erledigt', erledigt_am: new Date().toISOString(), erledigt_von: state.user.id };
      // Wenn noch niemand zugewiesen, jetzt dem Abschliessenden zuweisen (Nachweis wer übernommen hat)
      if (!a.zugewiesen_an) upd.zugewiesen_an = state.user.id;
      const { error } = await sb.from('aufgaben').update(upd).eq('id', aid);
      if (error) return alert(error.message);
      await loadAll(); renderAll();
    });
    card.querySelector('[data-reopen]')?.addEventListener('click', async () => {
      const { error } = await sb.from('aufgaben').update({ status: 'offen', erledigt_am: null, erledigt_von: null }).eq('id', aid);
      if (error) return alert(error.message);
      await loadAll(); renderAll();
    });
    card.querySelector('[data-edit]')?.addEventListener('click', () => editAufgabe(aid));
    card.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!confirm('Aufgabe löschen?')) return;
      const { error } = await sb.from('aufgaben').delete().eq('id', aid);
      if (error) return alert(error.message);
      await loadAll(); renderAll();
    });
    card.querySelector('[data-to-eintrag]')?.addEventListener('click', () => aufgabeInEintragUebernehmen(a));
  });
}

function editAufgabe(id) {
  const a = state.aufgaben.find(x => x.id === id);
  if (!a) return;
  editAufgabeId = id;
  $('#form-aufgabe').hidden = false;
  $('#t-titel').value = a.titel;
  $('#t-beschreibung').value = a.beschreibung || '';
  $('#t-alpname').value = a.alpname || '';
  $('#t-prioritaet').value = a.prioritaet || 'normal';
  $('#t-frist').value = a.frist || '';
  $('#t-zugewiesen').value = a.zugewiesen_an || '';
  $('#form-aufgabe').scrollIntoView({ behavior: 'smooth' });
}

function aufgabeInEintragUebernehmen(a) {
  if (!a || !a.alpname) return;
  // Wechsel auf Erfassen-Tab und Formular vorbefüllen
  document.querySelector('.tab[data-tab="erfassen"]').click();
  $('#e-datum').value = todayISO();
  $('#e-alpname').value = a.alpname;
  $('#e-arbeit').value = a.titel;
  if (a.beschreibung) $('#e-bemerkung').value = a.beschreibung;
  resetMaschinenRows();

  // Bestösser vorauswählen: eigener Datensatz, sonst der Zugewiesene (falls gemappt),
  // sonst bleibt die bereits vorgewählte Option.
  const sel = $('#e-bestoesser');
  if (sel) {
    if (state.myBestoesser) {
      sel.value = state.myBestoesser.id;
    } else if (a.zugewiesen_an) {
      const b = state.bestoesser.find(x => x.user_id === a.zugewiesen_an);
      if (b) sel.value = b.id;
    }
  }
  setMsg('#e-msg', 'Aufgabe vorbefüllt — nach dem Speichern gehe zurück auf "Aufgaben" und markiere sie als erledigt.', 'ok');
}

$('#btn-aufgabe-neu')?.addEventListener('click', () => {
  editAufgabeId = null;
  $('#form-aufgabe').hidden = false;
  $('#form-aufgabe').reset();
  $('#t-prioritaet').value = 'normal';
});
$('#btn-t-cancel')?.addEventListener('click', () => {
  editAufgabeId = null;
  $('#form-aufgabe').hidden = true;
  $('#form-aufgabe').reset();
});

$('#form-aufgabe')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!canEditMaster()) return setMsg('#t-msg', 'Keine Berechtigung.', 'error');
  const payload = {
    titel: $('#t-titel').value.trim(),
    beschreibung: $('#t-beschreibung').value.trim() || null,
    alpname: $('#t-alpname').value || null,
    prioritaet: $('#t-prioritaet').value,
    frist: $('#t-frist').value || null,
    zugewiesen_an: $('#t-zugewiesen').value || null,
  };
  let res;
  if (editAufgabeId) {
    res = await sb.from('aufgaben').update(payload).eq('id', editAufgabeId);
  } else {
    payload.erstellt_von = state.user.id;
    res = await sb.from('aufgaben').insert(payload);
  }
  if (res.error) return setMsg('#t-msg', res.error.message, 'error');
  editAufgabeId = null;
  $('#form-aufgabe').hidden = true;
  $('#form-aufgabe').reset();
  setMsg('#t-msg', '', '');
  await loadAll(); renderAll();
});

['#f-status','#f-a-alpname','#f-a-zug'].forEach(s => $(s)?.addEventListener('change', renderAufgaben));

// ===========================================================================
// ADMINISTRATION (User-Verwaltung + Audit-Log)
// ===========================================================================
async function loadAdminData() {
  if (isSystemAdmin()) {
    const { data: ps } = await sb.from('profiles').select('*').order('name');
    state.profiles = ps ?? [];
  }
  // Audit-Log laden (Admin + GF)
  if (isSystemAdmin() || state.profile?.rolle === 'geschaeftsfuehrer') {
    const tab = $('#audit-filter-tabelle')?.value || '';
    let q = sb.from('audit_log').select('*').order('zeit', { ascending: false });
    if (tab) q = q.eq('tabelle', tab);
    const { data: al } = await q;
    state.auditLog = (al ?? []).slice(0, 100);
  }
}

async function renderAdmin() {
  // Nur laden und rendern, wenn Tab überhaupt sichtbar ist
  const adminTab = document.querySelector('.tab.admin-tab');
  if (!adminTab || adminTab.classList.contains('hidden')) return;
  await loadAdminData();

  // Benutzerliste (nur Admin)
  const ul = $('#users-list');
  if (ul && isSystemAdmin()) {
    ul.innerHTML = state.profiles.map(p => `
      <div class="user-row" data-uid="${p.id}">
        <div class="u-head">
          <span class="u-name">${escapeHtml(p.name)} ${p.is_admin ? '<span class="u-admin-badge">ADMIN</span>' : ''}</span>
        </div>
        <div class="u-controls">
          <label class="small">Rolle
            <select data-role>
              <option value="bestoesser"${p.rolle==='bestoesser'?' selected':''}>Bestösser</option>
              <option value="alpmeister_portein"${p.rolle==='alpmeister_portein'?' selected':''}>Alpmeister Porteineralp</option>
              <option value="alpmeister_sarn"${p.rolle==='alpmeister_sarn'?' selected':''}>Alpmeister Sarneralp</option>
              <option value="geschaeftsfuehrer"${p.rolle==='geschaeftsfuehrer'?' selected':''}>Geschäftsführer</option>
            </select>
          </label>
          <label class="small"><input type="checkbox" data-admin${p.is_admin?' checked':''}${p.id === state.user.id ? ' disabled title="Du kannst dir den Admin-Status nicht selbst entziehen."' : ''} /> Administrator</label>
          ${p.id !== state.user.id ? `<button class="secondary" data-del-user>Löschen</button>` : '<span class="small">(Du)</span>'}
        </div>
      </div>
    `).join('') || '<p class="small">Keine Benutzer.</p>';

    ul.querySelectorAll('.user-row').forEach(row => {
      const uid = row.dataset.uid;
      row.querySelector('[data-role]').addEventListener('change', async e => {
        const { error } = await sb.from('profiles').update({ rolle: e.target.value }).eq('id', uid);
        if (error) { alert(error.message); return; }
        await loadAdminData(); renderAdmin();
      });
      row.querySelector('[data-admin]').addEventListener('change', async e => {
        const { error } = await sb.from('profiles').update({ is_admin: e.target.checked }).eq('id', uid);
        if (error) { alert(error.message); e.target.checked = !e.target.checked; return; }
        await loadAdminData(); renderAdmin();
      });
      const delBtn = row.querySelector('[data-del-user]');
      if (delBtn) delBtn.addEventListener('click', async () => {
        if (!confirm('Benutzer-Profil wirklich löschen? (Der Auth-Account bleibt bestehen — kann im Supabase-Studio entfernt werden.)')) return;
        const { error } = await sb.from('profiles').delete().eq('id', uid);
        if (error) return alert(error.message);
        await loadAdminData(); renderAdmin();
      });
    });
  }

  // Audit-Log
  const al = $('#audit-list');
  if (al) {
    if (!state.auditLog.length) {
      al.innerHTML = '<p class="small">Keine Einträge.</p>';
    } else {
      al.innerHTML = state.auditLog.map(row => {
        const zeit = new Date(row.zeit).toLocaleString('de-CH');
        return `
          <div class="audit-row">
            <div class="head">
              <span><span class="tag ${row.aktion}">${row.aktion}</span> <strong>${escapeHtml(row.tabelle)}</strong></span>
              <span>${zeit}</span>
            </div>
            <div>von ${escapeHtml(row.user_name || '—')} ${row.rolle ? '· '+escapeHtml(rolleLabel(row.rolle)) : ''}</div>
            ${row.alt || row.neu ? `
              <details>
                <summary>Details</summary>
                ${row.alt ? `<pre>vorher: ${escapeHtml(JSON.stringify(row.alt, null, 2))}</pre>` : ''}
                ${row.neu ? `<pre>nachher: ${escapeHtml(JSON.stringify(row.neu, null, 2))}</pre>` : ''}
              </details>` : ''}
          </div>`;
      }).join('');
    }
  }
}

// Lazy-Load beim Wechsel auf Admin-Tab
$$('.tab').forEach(btn => {
  if (btn.dataset.tab === 'admin') btn.addEventListener('click', renderAdmin);
});
$('#audit-filter-tabelle')?.addEventListener('change', renderAdmin);
$('#btn-audit-reload')?.addEventListener('click', renderAdmin);

// ===========================================================================
// Util: HTML-Escape
// ===========================================================================
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

// ------ Service Worker (PWA offline shell) ----------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
}

// Start
init();

})();
