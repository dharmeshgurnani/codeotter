// The audit log's CSV export (the page itself is the "audit" settings page). Mounted at /api/audit; owner only.
import { Hono } from "hono";
import { requestOrg } from "../access.ts";
import { auditFilter, exportAudit } from "../audit.ts";
import { gate } from "./middleware.ts";
import type { Env } from "./middleware.ts";

export const auditRoutes = new Hono<Env>();
auditRoutes.use(gate("owner"));

// ?org= ?action= ?actor=: the same filter as the page; an unknown action or a malformed actor is ignored.
auditRoutes.get("/export", async (c) => {
  const q = auditFilter({ action: c.req.query("action"), actor: c.req.query("actor"), org: requestOrg(c.req.query("org")) });
  const day = new Date().toISOString().slice(0, 10);
  return c.body(await exportAudit(q), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="codeotter-audit-${day}.csv"`, "cache-control": "no-store" });
});
