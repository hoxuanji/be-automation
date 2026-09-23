// Pattern catalog — every entry drives the UI dropdown and the generator dispatch.
// The 'methods' hint what HTTP verbs make sense; it's advisory, not enforced.

export const PATTERN_CATALOG = [
  // ── CRUD ──────────────────────────────────────────────────────────────────
  { id: "crud_list",   name: "List (paginated)",  desc: "Paginated collection with optional search and sort", category: "CRUD",      methods: ["GET"] },
  { id: "crud_get",    name: "Get by ID",          desc: "Fetch a single resource by primary key, 404 on miss", category: "CRUD",      methods: ["GET"] },
  { id: "crud_create", name: "Create",             desc: "Validate, persist, return 201 with created resource", category: "CRUD",      methods: ["POST"] },
  { id: "crud_update", name: "Partial update",     desc: "Merge-patch an existing resource, 404 on miss",       category: "CRUD",      methods: ["PATCH", "PUT"] },
  { id: "crud_delete", name: "Delete",             desc: "Hard-delete a resource, 204 on success",              category: "CRUD",      methods: ["DELETE"] },
  // ── Auth ──────────────────────────────────────────────────────────────────
  { id: "auth_login",           name: "Login",              desc: "Verify email + bcrypt hash, issue JWT",            category: "Auth",      methods: ["POST"] },
  { id: "auth_register",        name: "Register",           desc: "Validate, hash password, create user, issue JWT",  category: "Auth",      methods: ["POST"] },
  { id: "auth_me",              name: "Current user",       desc: "Return authenticated user profile from JWT",        category: "Auth",      methods: ["GET"] },
  { id: "auth_logout",          name: "Logout",             desc: "Revoke session / token server-side",               category: "Auth",      methods: ["POST"] },
  { id: "auth_refresh",         name: "Refresh token",      desc: "Exchange refresh token for new access token",      category: "Auth",      methods: ["POST"] },
  { id: "auth_change_password", name: "Change password",    desc: "Verify current password, hash and store new one",  category: "Auth",      methods: ["PATCH", "POST"] },
  // ── Infrastructure ────────────────────────────────────────────────────────
  { id: "health_check",     name: "Health / liveness",  desc: "DB + cache ping, returns 200 OK or 503",           category: "Infra",     methods: ["GET"] },
  { id: "webhook_receive",  name: "Webhook receiver",   desc: "HMAC-SHA256 signature validation + event enqueue", category: "Infra",     methods: ["POST"] },
  { id: "file_upload",      name: "File upload",        desc: "Multipart upload, validate MIME + size, store",    category: "Infra",     methods: ["POST"] },
  // ── Search & Analytics ────────────────────────────────────────────────────
  { id: "paginated_search", name: "Paginated search",   desc: "Full-text / filtered search with cursor pagination", category: "Search",    methods: ["GET"] },
  { id: "aggregate_stats",  name: "Aggregate stats",    desc: "COUNT / SUM / AVG grouped by dimension + timerange", category: "Analytics", methods: ["GET"] },
  // ── Messaging ─────────────────────────────────────────────────────────────
  { id: "send_notification", name: "Send notification", desc: "Publish event to queue (RabbitMQ / Kafka / NATS)",  category: "Messaging", methods: ["POST"] },
  // ── Caching ───────────────────────────────────────────────────────────────
  { id: "cache_read",  name: "Cache-aside read",  desc: "Check Redis, fallback to DB, populate on miss",        category: "Cache",     methods: ["GET"] },
  // ── Custom ────────────────────────────────────────────────────────────────
  { id: "custom",      name: "Custom",             desc: "Describe the logic — AI generates the implementation", category: "Custom",    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
] as const;

export type PatternId = typeof PATTERN_CATALOG[number]["id"];
export type PatternCategory = typeof PATTERN_CATALOG[number]["category"];

export const PATTERN_BY_CATEGORY: Record<string, typeof PATTERN_CATALOG[number][]> = {};
for (const p of PATTERN_CATALOG) {
  (PATTERN_BY_CATEGORY[p.category] ??= []).push(p);
}
