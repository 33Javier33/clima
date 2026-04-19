// ═══════════════════════════════════════════════════════════════
// CLIMA APP — Google Apps Script Backend  [VERSIÓN ACTUALIZADA]
// CarlosPN Interactive®
// ═══════════════════════════════════════════════════════════════
// CAMBIOS vs versión anterior:
//  ✅ Acción deleteUser agregada
//  ✅ Acción updateConfig agregada (guarda duración + módulos trial)
//  ✅ getUsers ahora devuelve config para el panel admin
//  ✅ registerUser usa duración del trial desde PropertiesService
//  ✅ MODULES alineados con los del panel admin
// ═══════════════════════════════════════════════════════════════

const PROPS        = PropertiesService.getScriptProperties();
const MASTER_SHEET = 'Control';
const LOG_SHEET    = 'Log';

// Módulos — deben coincidir exactamente con admin-clima.html
const MODULES = [
  'clima_basico',
  'pronostico_horas',
  'sensacion_horas',
  'pronostico_dias',
  'foto_ciudad',
  'info_ciudad',
  'seccion_explorar',
  'mapa_ciudad',
  'temas_visuales',
  'datos_detalle',
  'datos_uv',
  'datos_viento',
  'datos_presion',
  'datos_nubosidad',
  'datos_visibilidad',
  'datos_amanecer',
];

function getSS() {
  return SpreadsheetApp.openById(PROPS.getProperty('SHEET_ID'));
}

function getSSafe() {
  try {
    return SpreadsheetApp.openById(PROPS.getProperty('SHEET_ID'));
  } catch(e) {
    Logger.log('Error al abrir Sheet: ' + e.message);
    return null;
  }
}

function testConexion() {
  const ss = getSSafe();
  if (!ss) { Logger.log('❌ No se pudo abrir el Sheet. Verifica SHEET_ID.'); return; }
  ensureMasterSheet();
  Logger.log('✅ Conexión OK. Hojas creadas/verificadas.');
}

// ══════════════════════════════════════════════════════════════
// PUNTO DE ENTRADA HTTP
// ══════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents);
    const action = body.action;
    const pass   = body.adminPass;

    // Acciones públicas (sin contraseña de admin)
    if (action === 'register')        return respond(registerUser(body));
    if (action === 'registerSilent')  return respond(registerSilent(body));
    if (action === 'checkLicense')    return respond(checkLicense(body));
    if (action === 'trackUsage')      return respond(trackUsage(body));
    if (action === 'checkSync')       return respond(checkSync(body));

    // Acciones de admin (requieren contraseña)
    if (!verifyAdmin(pass)) return respond({ ok: false, error: 'No autorizado' });

    if (action === 'getUsers')       return respond(getUsers());
    if (action === 'updateModule')   return respond(updateModule(body));
    if (action === 'blockUser')      return respond(blockUser(body));
    if (action === 'deleteUser')     return respond(deleteUser(body));   // ← NUEVO
    if (action === 'updateConfig')   return respond(updateConfig(body)); // ← NUEVO
    if (action === 'getContactInfo') return respond(getContactInfo());

    return respond({ ok: false, error: 'Acción desconocida: ' + action });
  } catch(err) {
    return respond({ ok: false, error: err.message });
  }
}

function doGet(e) {
  return respond({ ok: true, msg: 'Clima App API activa' });
}

// ══════════════════════════════════════════════════════════════
// AUTENTICACIÓN
// ══════════════════════════════════════════════════════════════
function verifyAdmin(pass) {
  return pass && pass === PROPS.getProperty('ADMIN_PASSWORD');
}

// ══════════════════════════════════════════════════════════════
// REGISTRO DE USUARIO
// Lee la duración del trial desde PropertiesService (no hardcodeada)
// ══════════════════════════════════════════════════════════════
function registerUser(body) {
  const { nombre, apellido, email, whatsapp } = body;
  if (!nombre || !email || !whatsapp)
    return { ok: false, error: 'Faltan campos obligatorios' };

  const SS = getSS();
  ensureMasterSheet();

  const master = SS.getSheetByName(MASTER_SHEET);
  const data   = master.getDataRange().getValues();

  // Si ya existe, devolver sus datos
  for (let i = 1; i < data.length; i++) {
    if (data[i][2] === email) {
      return {
        ok: true,
        userId:   data[i][0],
        existing: true,
        trialEnd: data[i][5],
        modules:  JSON.parse(data[i][7] || '{}'),
      };
    }
  }

  // Calcular fecha de fin de trial desde PropertiesService
  const trialValor  = parseInt(PROPS.getProperty('trial_valor')  || '7');
  const trialUnidad = PROPS.getProperty('trial_unidad') || 'dias';

  const trialEnd = new Date();
  if (trialUnidad === 'horas') {
    trialEnd.setHours(trialEnd.getHours() + trialValor);
  } else {
    trialEnd.setDate(trialEnd.getDate() + trialValor);
  }
  const trialEndStr = trialEnd.toISOString();

  const userId = generateId(email);

  // Módulos iniciales: los que estén activados en la config trial
  const modulesInit = {};
  MODULES.forEach(m => {
    const key    = 'trial_mod_' + m;
    const active = PROPS.getProperty(key);
    modulesInit[m] = (active === 'true');
  });
  // clima_basico siempre activo por defecto si no hay config
  if (modulesInit['clima_basico'] === undefined) modulesInit['clima_basico'] = true;

  master.appendRow([
    userId,
    `${nombre} ${apellido || ''}`.trim(),
    email,
    whatsapp,
    new Date().toISOString(),
    trialEndStr,
    'trial',
    JSON.stringify(modulesInit),
    'activo',
  ]);

  createUserSheet(SS, userId, nombre, apellido || '', email, whatsapp, trialEndStr, modulesInit);
  notifyAdmin(nombre, apellido || '', email, whatsapp);
  appendLog(SS, 'REGISTER', email, `Trial hasta ${trialEndStr} (${trialValor} ${trialUnidad})`);

  return { ok: true, userId, trialEnd: trialEndStr, modules: modulesInit };
}

// ══════════════════════════════════════════════════════════════
// REGISTRO SILENCIOSO (solo deviceId, sin formulario)
// Se llama automáticamente la primera vez que un dispositivo abre la app
// ══════════════════════════════════════════════════════════════
function registerSilent(body) {
  const { deviceId } = body;
  if (!deviceId) return { ok: false, error: 'deviceId requerido' };

  const SS = getSS();
  ensureMasterSheet();
  const master = SS.getSheetByName(MASTER_SHEET);
  const data   = master.getDataRange().getValues();

  // Si ya existe, devolver sus datos actuales
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === deviceId) {
      const trialEnd  = new Date(data[i][5]);
      const now       = new Date();
      const msLeft    = Math.max(0, trialEnd - now);
      return {
        ok:       true,
        userId:   deviceId,
        existing: true,
        trialEnd: data[i][5],
        modules:  JSON.parse(data[i][7] || '{}'),
        daysLeft:  Math.ceil(msLeft / 86400000),
        hoursLeft: Math.ceil(msLeft / 3600000),
      };
    }
  }

  // Nuevo dispositivo: leer config del trial desde PropertiesService
  const trialValor  = parseInt(PROPS.getProperty('trial_valor')  || '7');
  const trialUnidad = PROPS.getProperty('trial_unidad') || 'dias';

  const trialEnd = new Date();
  if (trialUnidad === 'horas') {
    trialEnd.setHours(trialEnd.getHours() + trialValor);
  } else {
    trialEnd.setDate(trialEnd.getDate() + trialValor);
  }
  const trialEndStr = trialEnd.toISOString();

  // Módulos: los que estén activados en la config trial del admin
  const modulesInit = {};
  MODULES.forEach(m => {
    modulesInit[m] = (PROPS.getProperty('trial_mod_' + m) === 'true');
  });
  if (!PROPS.getProperty('trial_mod_clima_basico')) modulesInit['clima_basico'] = true;

  master.appendRow([
    deviceId,
    'Dispositivo ' + deviceId.slice(0, 6),
    '',
    '',
    new Date().toISOString(),
    trialEndStr,
    'trial',
    JSON.stringify(modulesInit),
    'activo',
    0,
    null,
  ]);

  const msLeft = Math.max(0, trialEnd - new Date());
  appendLog(SS, 'REGISTER_SILENT', deviceId, `Trial ${trialValor} ${trialUnidad} hasta ${trialEndStr}`);

  return {
    ok:        true,
    userId:    deviceId,
    trialEnd:  trialEndStr,
    modules:   modulesInit,
    daysLeft:  Math.ceil(msLeft / 86400000),
    hoursLeft: Math.ceil(msLeft / 3600000),
  };
}

// ══════════════════════════════════════════════════════════════
// VERIFICAR LICENCIA
// ══════════════════════════════════════════════════════════════
function checkLicense(body) {
  const { userId, email } = body;
  if (!userId && !email) return { ok: false, error: 'Sin identificador' };

  const SS     = getSS();
  const master = SS.getSheetByName(MASTER_SHEET);
  if (!master) return { ok: false, error: 'Sin base de datos' };

  const data = master.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0] === userId || row[2] === email) {
      const trialEnd = new Date(row[5]);
      const now      = new Date();
      const estado   = row[6];
      const acceso   = row[8];

      if (acceso === 'bloqueado')
        return { ok: true, status: 'blocked', modules: {} };

      const modules = JSON.parse(row[7] || '{}');
      const expired = estado === 'trial' && now > trialEnd;
      const msLeft  = Math.max(0, trialEnd - now);

      return {
        ok:        true,
        status:    expired ? 'expired' : estado,
        trialEnd:  row[5],
        modules:   expired ? {} : modules,
        daysLeft:  estado === 'trial' ? Math.ceil(msLeft / 86400000)  : null,
        hoursLeft: estado === 'trial' ? Math.ceil(msLeft / 3600000)   : null,
      };
    }
  }
  return { ok: true, status: 'not_found' };
}

// ══════════════════════════════════════════════════════════════
// TRACK USAGE — actualiza minutos de uso y último ping
// ══════════════════════════════════════════════════════════════
function trackUsage(body) {
  const { deviceId, minutes } = body;
  if (!deviceId) return { ok: false };
  try {
    const SS     = getSS();
    const master = SS.getSheetByName(MASTER_SHEET);
    if (!master) return { ok: false };
    const data = master.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === deviceId) {
        const prev    = parseInt(data[i][9]) || 0;
        const newMins = prev + (parseInt(minutes) || 5);
        master.getRange(i + 1, 10).setValue(newMins);
        master.getRange(i + 1, 11).setValue(new Date().toISOString());
        return { ok: true };
      }
    }
  } catch(_) {}
  return { ok: false };
}

// ══════════════════════════════════════════════════════════════
// CHECK SYNC — detecta cambios en los datos del usuario
// Devuelve un "stamp" que cambia cuando el admin modifica algo
// ══════════════════════════════════════════════════════════════
function checkSync(body) {
  const { deviceId } = body;
  if (!deviceId) return { ok: false };
  try {
    const SS     = getSS();
    const master = SS.getSheetByName(MASTER_SHEET);
    if (!master) return { ok: false };
    const data = master.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === deviceId) {
        // El stamp es una combinación de estado + acceso + modules (cambia si el admin modifica)
        const stamp = data[i][6] + '|' + data[i][8] + '|' + data[i][7];
        return { ok: true, stamp: stamp };
      }
    }
  } catch(_) {}
  return { ok: true, stamp: null };
}

// ══════════════════════════════════════════════════════════════
// ADMIN: LISTAR USUARIOS  (ahora incluye config del trial)
// ══════════════════════════════════════════════════════════════
function getUsers() {
  const SS     = getSS();
  const master = SS.getSheetByName(MASTER_SHEET);
  if (!master) return { ok: false, error: 'Sin hoja maestra' };

  const data  = master.getDataRange().getValues();
  const users = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    users.push({
      userId:       row[0],
      nombre:       row[1],
      email:        row[2],
      whatsapp:     row[3],
      registeredAt: row[4],
      trialEnd:     row[5],
      estado:       row[6],
      modules:      JSON.parse(row[7] || '{}'),
      acceso:       row[8],
      totalMinutes: row[9] || 0,
      lastPing:     row[10] || null,
    });
  }

  // Leer config del trial desde PropertiesService para devolverla al admin
  const config = {};
  config['trial_valor']  = PROPS.getProperty('trial_valor')  || '7';
  config['trial_unidad'] = PROPS.getProperty('trial_unidad') || 'dias';
  MODULES.forEach(m => {
    const key = 'trial_mod_' + m;
    config[key] = PROPS.getProperty(key) || 'false';
  });

  return { ok: true, users, modules: MODULES, config };
}

// ══════════════════════════════════════════════════════════════
// ADMIN: ACTUALIZAR MÓDULO / PLAN
// ══════════════════════════════════════════════════════════════
function updateModule(body) {
  const { userId, module, value, plan } = body;
  const SS     = getSS();
  const master = SS.getSheetByName(MASTER_SHEET);
  const data   = master.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      const modules = JSON.parse(data[i][7] || '{}');

      if (plan) {
        const plans = {
          basico:   ['clima_basico'],
          estandar: ['clima_basico','pronostico_horas','pronostico_dias','datos_viento','foto_ciudad'],
          premium:  MODULES,
        };
        MODULES.forEach(m => { modules[m] = (plans[plan] || []).includes(m); });
        master.getRange(i + 1, 7).setValue('premium');
      } else {
        modules[module] = value;
      }

      master.getRange(i + 1, 8).setValue(JSON.stringify(modules));
      updateUserSheet(SS, userId, modules, master.getRange(i + 1, 7).getValue());
      appendLog(SS, 'UPDATE_MODULE', data[i][2], plan ? `plan=${plan}` : `${module}=${value}`);
      return { ok: true, modules };
    }
  }
  return { ok: false, error: 'Usuario no encontrado' };
}

// ══════════════════════════════════════════════════════════════
// ADMIN: BLOQUEAR / DESBLOQUEAR
// ══════════════════════════════════════════════════════════════
function blockUser(body) {
  const { userId, block } = body;
  const SS     = getSS();
  const master = SS.getSheetByName(MASTER_SHEET);
  const data   = master.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      const newAcceso = block ? 'bloqueado' : 'activo';
      master.getRange(i + 1, 9).setValue(newAcceso);
      updateUserSheet(SS, userId, JSON.parse(data[i][7] || '{}'), data[i][6], newAcceso);
      appendLog(SS, 'BLOCK_USER', data[i][2], newAcceso);
      return { ok: true, acceso: newAcceso };
    }
  }
  return { ok: false, error: 'Usuario no encontrado' };
}

// ══════════════════════════════════════════════════════════════
// ADMIN: ELIMINAR USUARIO  ← NUEVO
// ══════════════════════════════════════════════════════════════
function deleteUser(body) {
  const { userId } = body;
  if (!userId) return { ok: false, error: 'userId requerido' };

  const SS     = getSS();
  const master = SS.getSheetByName(MASTER_SHEET);
  if (!master) return { ok: false, error: 'Sin hoja maestra' };

  const data = master.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      const email     = data[i][2];
      const nombre    = data[i][1];

      // Eliminar hoja individual del usuario si existe
      const userSheet = SS.getSheetByName(nombre.slice(0, 30));
      if (userSheet) SS.deleteSheet(userSheet);

      // Eliminar fila del maestro
      master.deleteRow(i + 1);

      appendLog(SS, 'DELETE_USER', email, 'Eliminado por admin');
      return { ok: true };
    }
  }
  return { ok: false, error: 'Usuario no encontrado' };
}

// ══════════════════════════════════════════════════════════════
// ADMIN: GUARDAR CONFIGURACIÓN TRIAL  ← NUEVO
// Guarda trial_valor, trial_unidad y todos los trial_mod_*
// ══════════════════════════════════════════════════════════════
function updateConfig(body) {
  const { config } = body;
  if (!config) return { ok: false, error: 'config requerido' };

  // Guardar cada clave en PropertiesService
  const allowed = ['trial_valor', 'trial_unidad'];
  MODULES.forEach(m => allowed.push('trial_mod_' + m));

  const toSave = {};
  allowed.forEach(key => {
    if (config[key] !== undefined) toSave[key] = String(config[key]);
  });

  PROPS.setProperties(toSave);
  appendLog(getSS(), 'UPDATE_CONFIG', 'admin', JSON.stringify(toSave));
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════
// ADMIN: CONTACTO
// ══════════════════════════════════════════════════════════════
function getContactInfo() {
  return {
    ok:       true,
    email:    PROPS.getProperty('ADMIN_EMAIL'),
    whatsapp: PROPS.getProperty('ADMIN_WHATSAPP'),
  };
}

// ══════════════════════════════════════════════════════════════
// HOJAS
// ══════════════════════════════════════════════════════════════
function ensureMasterSheet() {
  const SS = getSS();
  let master = SS.getSheetByName(MASTER_SHEET);
  if (!master) {
    master = SS.insertSheet(MASTER_SHEET, 0);
    // Columnas: A=userId B=nombre C=email D=whatsapp E=registro F=trial_end
    //           G=estado H=modulos I=acceso J=totalMinutes K=lastPing
    master.appendRow(['userId','nombre','email','whatsapp','registro','trial_end','estado','modulos','acceso','totalMinutes','lastPing']);
    master.setFrozenRows(1);
    master.getRange(1,1,1,11).setBackground('#1a2d40').setFontColor('#ffffff').setFontWeight('bold');
  }
  let log = SS.getSheetByName(LOG_SHEET);
  if (!log) {
    log = SS.insertSheet(LOG_SHEET);
    log.appendRow(['fecha','accion','email','detalle']);
    log.setFrozenRows(1);
    log.getRange(1,1,1,4).setBackground('#1a2d40').setFontColor('#ffffff').setFontWeight('bold');
  }
  Logger.log('Hojas verificadas correctamente.');
}

function createUserSheet(SS, userId, nombre, apellido, email, whatsapp, trialEnd, modules) {
  const sheetName = `${nombre} ${apellido}`.trim().slice(0, 30);
  let sheet = SS.getSheetByName(sheetName);
  if (sheet) SS.deleteSheet(sheet);
  sheet = SS.insertSheet(sheetName);

  sheet.appendRow(['── DATOS DEL USUARIO ──']);
  sheet.appendRow(['ID',          userId]);
  sheet.appendRow(['Nombre',      `${nombre} ${apellido}`.trim()]);
  sheet.appendRow(['Email',       email]);
  sheet.appendRow(['WhatsApp',    whatsapp]);
  sheet.appendRow(['Registro',    new Date().toISOString()]);
  sheet.appendRow(['Trial hasta', trialEnd]);
  sheet.appendRow(['Estado',      'trial']);
  sheet.appendRow(['Acceso',      'activo']);
  sheet.appendRow([]);
  sheet.appendRow(['── MÓDULOS ──']);
  sheet.appendRow(['Módulo', 'Activo']);
  MODULES.forEach(m => sheet.appendRow([m, modules[m] ? '✅ Activo' : '❌ Inactivo']));

  sheet.getRange(1,1,1,2).setBackground('#0d1117').setFontColor('#7eb8d4').setFontWeight('bold');
  sheet.getRange(11,1,1,2).setBackground('#0d1117').setFontColor('#7eb8d4').setFontWeight('bold');
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 150);
}

function updateUserSheet(SS, userId, modules, estado, acceso) {
  const master = SS.getSheetByName(MASTER_SHEET);
  if (!master) return;
  const data = master.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      const sheet = SS.getSheetByName(data[i][1].slice(0, 30));
      if (!sheet) return;
      sheet.getRange(8, 2).setValue(estado || data[i][6]);
      if (acceso) sheet.getRange(9, 2).setValue(acceso);
      MODULES.forEach((m, idx) => {
        sheet.getRange(13 + idx, 2).setValue(modules[m] ? '✅ Activo' : '❌ Inactivo');
      });
      break;
    }
  }
}

function appendLog(SS, action, email, detail) {
  const log = SS.getSheetByName(LOG_SHEET);
  if (log) log.appendRow([new Date().toISOString(), action, email, detail]);
}

// ══════════════════════════════════════════════════════════════
// NOTIFICACIÓN AL ADMIN
// ══════════════════════════════════════════════════════════════
function notifyAdmin(nombre, apellido, email, whatsapp) {
  try {
    const adminEmail = PROPS.getProperty('ADMIN_EMAIL');
    if (!adminEmail) return;
    const wa = PROPS.getProperty('ADMIN_WHATSAPP');
    MailApp.sendEmail({
      to:      adminEmail,
      subject: `🌤 Clima App — Nuevo registro: ${nombre} ${apellido}`,
      htmlBody: `<div style="font-family:monospace;background:#0d1117;color:#b8dce8;padding:24px;border-radius:12px">
        <h2 style="color:#7eb8d4">Nuevo usuario registrado</h2>
        <table>
          <tr><td><b>Nombre:</b></td><td>${nombre} ${apellido}</td></tr>
          <tr><td><b>Email:</b></td><td>${email}</td></tr>
          <tr><td><b>WhatsApp:</b></td><td>${whatsapp}</td></tr>
          <tr><td><b>Trial:</b></td><td>Según config admin</td></tr>
        </table>
        <p style="color:#7a92a8;margin-top:16px">Contacto admin (privado): ${wa}</p>
      </div>`,
    });
  } catch(_) {}
}

// ══════════════════════════════════════════════════════════════
// UTILIDADES
// ══════════════════════════════════════════════════════════════
function generateId(email) {
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, email + Date.now());
  return hash.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2,'0')).join('').slice(0, 12);
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
