// Audit log: append-only security and configuration events (core/audit.ts). Superuser-only: no API rules.
migrate(
  (app) => {
    const c = new Collection({
      name: "audit",
      type: "base",
      fields: [
        { name: "at", type: "text", required: true },
        { name: "actor", type: "text" },
        { name: "actorName", type: "text" },
        { name: "action", type: "text", required: true },
        { name: "target", type: "text" },
        { name: "org", type: "text" },
        { name: "detail", type: "json", maxSize: 20000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      ],
      indexes: ["CREATE INDEX idx_audit_at ON audit (at)", "CREATE INDEX idx_audit_action ON audit (action)", "CREATE INDEX idx_audit_actor ON audit (actor)"],
    });
    app.save(c);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("audit"));
  },
);
