// Analytics events, one row each: a finished review run (tokens, cost, duration, findings, gates, suggestions posted
// and applied) or a suggestion outcome (posted later by hand, dismissed into a learning). `data` holds the event JSON;
// kind, repo, url and at are copies for filters.
migrate(
  (app) => {
    const c = new Collection({
      name: "analytics",
      type: "base",
      fields: [
        { name: "kind", type: "text", required: true },
        { name: "repo", type: "text" },
        { name: "url", type: "text" },
        { name: "at", type: "date" },
        { name: "data", type: "json", maxSize: 200000 },
        { name: "created", type: "autodate", onCreate: true },
      ],
      indexes: ["CREATE INDEX idx_analytics_at ON analytics (at)"],
    });
    app.save(c);
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("analytics"));
  },
);
