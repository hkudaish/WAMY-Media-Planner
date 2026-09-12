// =============================================================================
// WAMY Media Planner - Backup & System Restoration Manager
// Handles full database JSON snapshots, checksums, transactional restores,
// and safe project hierarchy wiping (System Reset).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKUPS_DIR = process.env.BACKUP_DIR || path.resolve(__dirname, '../backups');

// Ensure backups directory exists
if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

// Table order for backup & restore (Topological hierarchy)
const HIERARCHY_TABLES = [
  'projects',
  'master_plan_items',
  'project_team_assignments',
  'project_team_members',
  'products',
  'tasks',
  'files',
  'task_assignees',
  'task_schedule_history'
];

const SYSTEM_TABLES = [
  'organizations',
  'profiles',
  'app_settings'
];

/**
 * Calculate SHA-256 checksum of a buffer or string
 */
function calculateChecksum(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generate unique backup ID and filename
 */
function generateBackupId() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = crypto.randomBytes(3).toString('hex');
  return `backup_${timestamp}_${random}`;
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Create a full or project-only backup snapshot
 */
async function createBackup({ type = 'FULL', notes = '', user = null, pool }) {
  if (!pool) throw new Error('Database pool is required for backup');

  const backupId = generateBackupId();
  const tablesToExport = type === 'PROJECTS_ONLY' 
    ? HIERARCHY_TABLES 
    : [...SYSTEM_TABLES, ...HIERARCHY_TABLES];

  const data = {};
  const rowCounts = {};

  for (const table of tablesToExport) {
    try {
      const res = await pool.query(`SELECT * FROM "${table}"`);
      data[table] = res.rows;
      rowCounts[table] = res.rows.length;
    } catch (err) {
      console.warn(`[Backup] Note: table "${table}" query failed: ${err.message}`);
      data[table] = [];
      rowCounts[table] = 0;
    }
  }

  const manifest = {
    id: backupId,
    version: '2.0.0',
    app: 'WAMY Media Planner',
    createdAt: new Date().toISOString(),
    createdBy: user ? { id: user.id, name: user.name, email: user.email } : { id: 'system', name: 'System' },
    type,
    notes,
    rowCounts,
    totalRecords: Object.values(rowCounts).reduce((a, b) => a + b, 0)
  };

  const payload = {
    manifest,
    data
  };

  const jsonContent = JSON.stringify(payload, null, 2);
  const checksum = calculateChecksum(jsonContent);
  manifest.checksum = checksum;

  // Final payload with checksum in manifest
  const finalJson = JSON.stringify({ manifest, data }, null, 2);
  const filePath = path.join(BACKUPS_DIR, `${backupId}.json`);

  fs.writeFileSync(filePath, finalJson, 'utf-8');
  const stats = fs.statSync(filePath);

  return {
    id: backupId,
    filename: `${backupId}.json`,
    size: stats.size,
    sizeFormatted: formatBytes(stats.size),
    createdAt: manifest.createdAt,
    createdBy: manifest.createdBy,
    type: manifest.type,
    notes: manifest.notes,
    rowCounts: manifest.rowCounts,
    totalRecords: manifest.totalRecords,
    checksum
  };
}

/**
 * List all available backups in the backups directory
 */
function listBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];

  const files = fs.readdirSync(BACKUPS_DIR).filter(f => {
    if (f.startsWith('.') || f === 'backup-status.json' || !f.endsWith('.json')) return false;
    return true;
  });
  const backups = [];

  for (const file of files) {
    const filePath = path.join(BACKUPS_DIR, file);
    try {
      const stats = fs.statSync(filePath);
      const raw = fs.readFileSync(filePath, 'utf-8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      
      // Must have valid manifest and data object to be recognized as a valid DB backup
      if (!parsed || typeof parsed !== 'object' || !parsed.manifest || !parsed.data || typeof parsed.data !== 'object') {
        continue;
      }

      const manifest = parsed.manifest;

      backups.push({
        id: manifest.id || path.basename(file, '.json'),
        filename: file,
        size: stats.size,
        sizeFormatted: formatBytes(stats.size),
        createdAt: manifest.createdAt || stats.mtime.toISOString(),
        createdBy: manifest.createdBy || { name: 'النظام' },
        type: manifest.type || 'FULL',
        notes: manifest.notes || '',
        rowCounts: manifest.rowCounts || {},
        totalRecords: manifest.totalRecords || 0,
        checksum: manifest.checksum || ''
      });
    } catch (err) {
      console.error(`[Backup] Error reading backup file ${file}:`, err.message);
    }
  }

  // Sort descending by creation date
  return backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Get the full filesystem path of a backup file
 */
function getBackupFilePath(backupId) {
  const safeId = path.basename(String(backupId || ''));
  if (!safeId || safeId === 'backup-status' || safeId === 'backup-status.json' || safeId.startsWith('.')) {
    throw new Error(`معرف النسخة الاحتياطية غير صالح: ${backupId}`);
  }
  const filename = safeId.endsWith('.json') ? safeId : `${safeId}.json`;
  const filePath = path.join(BACKUPS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`ملف النسخة الاحتياطية غير موجود: ${filename}`);
  }

  return filePath;
}

/**
 * Delete a backup file
 */
function deleteBackup(backupId) {
  const filePath = getBackupFilePath(backupId);
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Restore a backup atomically into the database
 */
async function restoreBackup(backupId, { pool, user = null }) {
  if (!pool) throw new Error('Database pool is required for restoration');

  const filePath = getBackupFilePath(backupId);
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON format in backup file: ${err.message}`);
  }

  const manifest = parsed.manifest;
  const data = parsed.data;

  if (!manifest || !data || typeof data !== 'object') {
    throw new Error('ملف النسخة الاحتياطية غير صالح أو تالف (Manifest/Data missing)');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.allow_audit_mutation = 'on'");

    // Restore/merge organizations if present
    if (data.organizations && Array.isArray(data.organizations) && data.organizations.length > 0) {
      for (const org of data.organizations) {
        if (!org || !org.code) continue;
        await client.query(
          `INSERT INTO organizations (id, code, name, name_ar, name_en, short_name, description, color, logo_url, is_active, sort_order)
           VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, COALESCE($8, '#3b82f6'), $9, COALESCE($10, true), COALESCE($11, 0))
           ON CONFLICT (lower(code)) WHERE deleted_at IS NULL DO UPDATE SET
             name = EXCLUDED.name,
             name_ar = EXCLUDED.name_ar,
             name_en = EXCLUDED.name_en,
             short_name = EXCLUDED.short_name,
             description = EXCLUDED.description,
             color = EXCLUDED.color,
             logo_url = EXCLUDED.logo_url,
             is_active = EXCLUDED.is_active,
             sort_order = EXCLUDED.sort_order,
             updated_at = NOW()`,
          [org.id || null, org.code, org.name || org.code, org.name_ar || null, org.name_en || null, org.short_name || null, org.description || null, org.color || '#3b82f6', org.logo_url || null, org.is_active ?? true, org.sort_order || 0]
        );
      }
    }

    // 1. Clear tables in reverse hierarchical order
    const reverseHierarchy = [...HIERARCHY_TABLES].reverse();

    for (const table of reverseHierarchy) {
      await client.query(`DELETE FROM "${table}"`);
    }

    // 2. Insert records in topological forward order
    const restoredCounts = {};
    let totalRestored = 0;

    for (const table of HIERARCHY_TABLES) {
      const rows = data[table] || [];
      restoredCounts[table] = 0;

      if (rows.length === 0) continue;

      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;

        const colNames = columns.map(c => `"${c}"`).join(', ');
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        const values = columns.map(c => {
          const val = row[c];
          if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
            return JSON.stringify(val);
          }
          return val;
        });

        let insertQuery;
        if (table === 'task_assignees') {
          insertQuery = `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
        } else if (table === 'task_schedule_history') {
          insertQuery = `INSERT INTO "${table}" (${colNames}) OVERRIDING SYSTEM VALUE VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;
        } else if (columns.includes('id')) {
          const updateCols = columns.filter(c => c !== 'id');
          if (updateCols.length > 0) {
            insertQuery = `
              INSERT INTO "${table}" (${colNames})
              VALUES (${placeholders})
              ON CONFLICT (id) DO UPDATE SET
              ${updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')}
            `;
          } else {
            insertQuery = `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;
          }
        } else {
          insertQuery = `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`;
        }

        await client.query(insertQuery, values);
        restoredCounts[table]++;
        totalRestored++;
      }
    }

    // If backup included app_settings, merge app_settings
    if (data.app_settings && Array.isArray(data.app_settings) && data.app_settings.length > 0) {
      const st = data.app_settings[0];
      if (st) {
        await client.query(
          `INSERT INTO app_settings (id, drive_client_id, drive_picker_api_key, drive_root_folder_id, drive_root_folder_name, updated_at)
           VALUES (1, $1, $2, $3, $4, NOW())
           ON CONFLICT (id) DO UPDATE SET
             drive_client_id = EXCLUDED.drive_client_id,
             drive_picker_api_key = EXCLUDED.drive_picker_api_key,
             drive_root_folder_id = EXCLUDED.drive_root_folder_id,
             drive_root_folder_name = EXCLUDED.drive_root_folder_name,
             updated_at = NOW()`,
          [st.drive_client_id || null, st.drive_picker_api_key || null, st.drive_root_folder_id || null, st.drive_root_folder_name || null]
        );
      }
    }

    await client.query('COMMIT');

    return {
      success: true,
      backupId: manifest.id,
      restoredAt: new Date().toISOString(),
      restoredBy: user ? { id: user.id, name: user.name } : { name: 'System' },
      restoredCounts,
      restoredRecords: totalRestored
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Restore failed: ${err.message}`);
  } finally {
    client.release();
  }
}

/**
 * System Reset: Wipe all project hierarchy data while strictly preserving
 * users (profiles), settings, sessions, activity_log, and backup files.
 */
async function resetProjectHierarchy({ pool, user = null, createBackupFirst = true }) {
  if (!pool) throw new Error('Database pool is required for system reset');

  let preResetBackup = null;

  // 1. Create safety snapshot first if requested
  if (createBackupFirst) {
    preResetBackup = await createBackup({
      type: 'PRE_RESET',
      notes: `نسخة احتياطية تلقائية قبل إعادة تهيئة النظام (${new Date().toLocaleString('ar-SA')})`,
      user,
      pool
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.allow_audit_mutation = 'on'");

    const wipedCounts = {};
    const reverseHierarchy = [...HIERARCHY_TABLES].reverse();

    for (const table of reverseHierarchy) {
      const countRes = await client.query(`SELECT COUNT(*) FROM "${table}"`);
      wipedCounts[table] = parseInt(countRes.rows[0]?.count || '0', 10);
      await client.query(`DELETE FROM "${table}"`);
    }

    await client.query('COMMIT');

    return {
      success: true,
      wipedAt: new Date().toISOString(),
      wipedBy: user ? { id: user.id, name: user.name, email: user.email } : { name: 'System' },
      preResetBackup,
      wipedCounts
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`System Reset failed: ${err.message}`);
  } finally {
    client.release();
  }
}

module.exports = {
  createBackup,
  listBackups,
  getBackupFilePath,
  deleteBackup,
  restoreBackup,
  resetProjectHierarchy
};
