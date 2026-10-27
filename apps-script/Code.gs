/**
 * Ferroxwood · Synchro Google Sheet → plateforme de suivi
 *
 * Installation : dans le Google Sheet > Extensions > Apps Script,
 * collez ce fichier, adaptez CONFIG ci-dessous, enregistrez, puis rechargez le Sheet :
 * un menu « Ferroxwood » apparaît.
 *   1. Ferroxwood > Tester le mapping      (vérifie les colonnes reconnues, n'envoie rien)
 *   2. Ferroxwood > Synchroniser maintenant
 *   3. Ferroxwood > Activer la synchro auto (toutes les 10 min)
 *
 * À chaque synchro, tout l'onglet est relu : la plateforme ignore les leads déjà importés,
 * donc l'ordre des lignes (tri, insertion en haut) n'a pas d'importance.
 */

const CONFIG = {
  ENDPOINT: 'https://VOTRE-APP.vercel.app/api/import',
  SECRET: 'COLLEZ_ICI_LA_VALEUR_DE_IMPORT_SECRET',

  // Un bloc par onglet. « tab » = nom exact de l'onglet, « source » = 'Meta' ou 'Site web'.
  //
  // Onglet SANS ligne d'en-têtes (les leads commencent en ligne 1) :
  //   headerRow: 0  +  letters: { champ: 'lettre de colonne' }
  // Onglet AVEC une ligne d'en-têtes :
  //   headerRow: 1  (les colonnes sont reconnues par leur titre, voir COLUMNS plus bas)
  SHEETS: [
    { tab: 'Devis META', source: 'Meta', headerRow: 0,
      letters: { created: 'B', name: 'M', phone: 'N', email: 'O', city: 'P', type: 'Q' } },
    // { tab: 'Devis site web', source: 'Site web', headerRow: 1 },
  ],

  COLUMNS: {
    external_id: ['id', 'lead_id', 'leadgen_id', 'id du lead', 'lead id'],
    name:        ['full_name', 'nom complet', 'nom et prenom', 'name', 'nom'],
    first_name:  ['first_name', 'prenom'],
    last_name:   ['last_name', 'nom de famille'],
    email:       ['email', 'e-mail', 'adresse email', 'adresse e-mail', 'mail'],
    phone:       ['phone_number', 'phone', 'telephone', 'tel', 'gsm', 'numero de telephone'],
    city:        ['city', 'ville', 'localite', 'commune', 'code postal', 'post_code', 'zip'],
    message:     ['message', 'description', 'votre message', 'details', 'commentaire', 'decrivez votre projet'],
    type:        ['type', 'type de projet', 'quel est votre projet', 'quel type de projet', 'produit', 'projet'],
    budget:      ['budget', 'budget estime', 'votre budget'],
    created:     ['created_time', 'date', 'horodateur', 'timestamp', 'date de creation', 'submitted_at'],
  },

  // Colonnes à ne jamais recopier dans le message (techniques Meta, etc.)
  IGNORE: ['ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'form_id', 'form_name',
           'is_organic', 'platform', 'lead_status', 'statut', 'synchro'],
};

// ---------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Ferroxwood')
    .addItem('Tester le mapping', 'testMapping')
    .addItem('Synchroniser maintenant', 'syncNow')
    .addSeparator()
    .addItem('Activer la synchro auto (10 min)', 'installTrigger')
    .addItem('Désactiver la synchro auto', 'removeTrigger')
    .addItem('Tout renvoyer (réinitialiser)', 'resetPointers')
    .addToUi();
}

const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[?:*]/g, '').replace(/\s+/g, ' ').trim();

function mapHeaders(headers) {
  const idx = {}, used = new Set();
  const H = headers.map(norm);
  Object.keys(CONFIG.COLUMNS).forEach(field => {
    const aliases = CONFIG.COLUMNS[field].map(norm);
    let i = H.findIndex((h, j) => !used.has(j) && aliases.includes(h));
    if (i < 0) i = H.findIndex((h, j) => !used.has(j) && h && aliases.some(a => a.length > 3 && h.indexOf(a) >= 0));
    if (i >= 0) { idx[field] = i; used.add(i); }
  });
  return { idx, used };
}

function cellText(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Europe/Brussels', "yyyy-MM-dd'T'HH:mm:ss");
  return String(v == null ? '' : v).trim();
}

function colIndex(letter) {
  let n = 0;
  String(letter).toUpperCase().replace(/[^A-Z]/g, '').split('').forEach(c => { n = n * 26 + (c.charCodeAt(0) - 64); });
  return n - 1;
}
function colLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

function mapLetters(letters) {
  const idx = {}, used = new Set();
  Object.keys(letters || {}).forEach(f => { const i = colIndex(letters[f]); if (i >= 0) { idx[f] = i; used.add(i); } });
  return { idx, used, noHeader: true };
}

function phoneFix(p) {
  const d = String(p).replace(/[^\d+]/g, '');
  if (/^32\d{8,9}$/.test(d)) return '+' + d;          // 32477… → +32477…
  if (/^4\d{8}$/.test(d)) return '+32' + d;           // 477… (0 perdu par Sheets) → +32477…
  return String(p).trim();
}

function buildLead(sheetCfg, headers, map, row) {
  const get = f => map.idx[f] == null ? '' : cellText(row[map.idx[f]]);
  const raw = {}, extra = [];
  const ignore = CONFIG.IGNORE.map(norm);
  headers.forEach((h, j) => {
    const v = cellText(row[j]);
    if (!h || !v) return;
    raw[h] = v;
    if (!map.noHeader && !map.used.has(j) && ignore.indexOf(norm(h)) < 0) extra.push(h.replace(/_/g, ' ') + ' : ' + v);
  });
  if (!Object.keys(raw).length) return null; // ligne vide

  let id = get('external_id');
  if (!id) {
    const key = [sheetCfg.tab, get('email'), get('phone'), get('created') || JSON.stringify(raw)].join('|');
    id = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key)).slice(0, 22);
  }
  const message = [get('type') ? 'Projet : ' + get('type') : '', get('message'), extra.join('\n')].filter(String).join('\n\n');
  if (!get('email') && !get('phone') && !get('name')) return null; // ligne sans contact
  return {
    external_id: sheetCfg.source + ':' + id,
    source: sheetCfg.source,
    name: get('name'), first_name: get('first_name'), last_name: get('last_name'),
    email: get('email'), phone: get('phone') ? phoneFix(get('phone')) : '', city: get('city'),
    type: get('type'), message: message, budget: get('budget'), created: get('created'),
    raw: raw,
  };
}

function readTab(sheetCfg, onlyNew) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetCfg.tab);
  if (!sh) throw new Error('Onglet introuvable : « ' + sheetCfg.tab + ' »');
  const last = sh.getLastRow(), hr = sheetCfg.headerRow == null ? 1 : Number(sheetCfg.headerRow);
  if (last <= hr) return { leads: [], lastRow: hr, headers: [], map: { idx: {} } };
  const start = hr === 0 ? 1 : hr;
  const values = sh.getRange(start, 1, last - start + 1, sh.getLastColumn()).getValues();
  const headers = hr === 0 ? values[0].map((_, j) => colLetter(j)) : values[0].map(h => String(h).trim());
  const map = hr === 0 ? mapLetters(sheetCfg.letters) : mapHeaders(headers);
  const props = PropertiesService.getScriptProperties();
  const from = onlyNew ? Number(props.getProperty('last_' + sheetCfg.tab) || hr) : hr;
  const leads = [];
  for (let r = Math.max(from, hr) + 1; r <= last; r++) {
    const lead = buildLead(sheetCfg, headers, map, values[r - start]);
    if (lead) leads.push(lead);
  }
  return { leads, lastRow: last, headers, map };
}

function post(leads) {
  const resp = UrlFetchApp.fetch(CONFIG.ENDPOINT, {
    method: 'post', contentType: 'application/json',
    headers: { 'x-import-secret': CONFIG.SECRET },
    payload: JSON.stringify({ leads: leads }), muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  if (code !== 200) throw new Error('Import refusé (' + code + ') : ' + resp.getContentText().slice(0, 300));
  return JSON.parse(resp.getContentText());
}

function syncAll(silent) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  const props = PropertiesService.getScriptProperties();
  const report = [];
  try {
    CONFIG.SHEETS.forEach(cfg => {
      const t = readTab(cfg, !!cfg.incremental); // par défaut : tout l'onglet (les doublons sont ignorés)
      let inserted = 0;
      for (let i = 0; i < t.leads.length; i += 200) inserted += post(t.leads.slice(i, i + 200)).inserted;
      props.setProperty('last_' + cfg.tab, String(t.lastRow)); // n'avance qu'après un envoi réussi
      report.push(cfg.tab + ' : ' + t.leads.length + ' ligne(s) lue(s), ' + inserted + ' nouvelle(s) demande(s) importée(s)');
    });
  } finally { lock.releaseLock(); }
  if (!silent) SpreadsheetApp.getUi().alert(report.join('\n'));
  return report;
}

function syncNow() { syncAll(false); }
function syncTrigger() { syncAll(true); }

function testMapping() {
  const out = [];
  CONFIG.SHEETS.forEach(cfg => {
    const t = readTab(cfg, false);
    const found = Object.keys(t.map.idx).map(f => '  ' + f + ' ← ' + (t.map.noHeader ? 'colonne ' : '« ') + t.headers[t.map.idx[f]] + (t.map.noHeader ? '' : ' »'));
    const missing = ['email', 'phone'].filter(f => t.map.idx[f] == null);
    out.push('ONGLET ' + cfg.tab + ' (' + t.leads.length + ' lignes)\n' + found.join('\n') +
      (missing.length ? '\n  ⚠ non trouvé : ' + missing.join(', ') : '') +
      (t.leads[0] ? '\n  Exemple : ' + [t.leads[0].name || t.leads[0].first_name, t.leads[0].email, t.leads[0].city].join(' · ') : ''));
  });
  SpreadsheetApp.getUi().alert(out.join('\n\n'));
}

function installTrigger() {
  removeTrigger(true);
  ScriptApp.newTrigger('syncTrigger').timeBased().everyMinutes(10).create();
  SpreadsheetApp.getUi().alert('Synchro automatique activée (toutes les 10 minutes).');
}

function removeTrigger(silent) {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncTrigger').forEach(t => ScriptApp.deleteTrigger(t));
  if (silent !== true) SpreadsheetApp.getUi().alert('Synchro automatique désactivée.');
}

function resetPointers() {
  const props = PropertiesService.getScriptProperties();
  CONFIG.SHEETS.forEach(cfg => props.deleteProperty('last_' + cfg.tab));
  SpreadsheetApp.getUi().alert('Réinitialisé : la prochaine synchro renverra toutes les lignes (les doublons sont ignorés par la plateforme).');
}
