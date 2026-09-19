// 临时审计查询脚本（用后即删）
const db = require('better-sqlite3')('data/control-surface.db', { readonly: true });

// 1. 找 m1c-b2 相关节点（diagram_nodes 表）
const nodeTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
console.log('== tables ==');
console.log(nodeTables.filter(n => /node|evidence|plan|diagram/i.test(n)).join(', '));

// 2. 在 diagram 节点 JSON 中搜 m1c-b2
for (const t of nodeTables) {
  if (!/diagram/i.test(t)) continue;
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  if (!cols.some(c => /json|data|content|payload/i.test(c))) continue;
  console.log(`\n== scanning ${t} (${cols.join(',')}) ==`);
  for (const col of cols.filter(c => /json|data|content|payload/i.test(c))) {
    try {
      const rows = db.prepare(`SELECT rowid, ${col} FROM ${t}`).all();
      for (const r of rows) {
        const s = String(r[col] || '');
        if (s.includes('m1c-b2')) {
          console.log(`FOUND in ${t}.${col} rowid=${r.rowid}, len=${s.length}`);
        }
      }
    } catch (e) { /* skip */ }
  }
}
db.close();
