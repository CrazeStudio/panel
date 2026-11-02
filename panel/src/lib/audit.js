function audit(db, req, action, entityType, entityId = null, details = {}) {
  const user = req.session?.user || null;
  db.prepare(`
    INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, details, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    user?.id || null,
    user?.username || null,
    action,
    entityType,
    entityId,
    JSON.stringify(details),
    req.ip || null
  );
}

module.exports = { audit };
