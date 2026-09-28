import type { Endpoint, Entity, StackConfig } from "../types";
import { authProviderSpec } from "../auth/providers";

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

// ── Self-issued auth storage ─────────────────────────────────────────────────
// With auth "none", register/login/change_password keep bcrypt hashes in a
// generated auth_credentials table keyed by the User's primary key — never on
// the user's own entity. That works whatever fields User declares, and the hash
// can't leak through (or be overwritten by) the User CRUD routes.

/** The User entity self-issued auth registers into: needs `email` and a string/uuid PK (the handler mints ids). */
export function selfAuthUser(entities: Entity[]) {
  const entity = entities.find((e) => e.name.toLowerCase() === "user");
  const pk = entity?.fields.find((f) => f.primaryKey);
  const email = entity?.fields.find((f) => f.name === "email");
  if (!entity || !pk || !email || !["uuid", "string", "text"].includes(pk.type)) return undefined;
  const rest = entity.fields.filter((f) => f !== pk && f !== email);
  // ponytail: register stamps required date columns with "now" instead of parsing client timestamps.
  const settable = rest.filter((f) => f.type !== "date");
  return {
    entity, pk, email,
    settable,                                     // columns the register body may set
    required: settable.filter((f) => f.required), // register answers 400 naming any the body omits
    dates: rest.filter((f) => f.type === "date" && f.required),
  };
}
export type SelfAuthUser = NonNullable<ReturnType<typeof selfAuthUser>>;

/** Entity id of the generated credentials table; its user_id is a FK to the User PK, ON DELETE CASCADE. */
export const AUTH_CREDENTIAL_ID = "auth_credential";

const HASH_PATTERNS = new Set(["auth_login", "auth_register", "auth_change_password"]);

/** The auth_credentials entity to model + migrate when self-issued auth stores hashes; [] otherwise. */
export function authCredentialEntities(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): Entity[] {
  const user = selfAuthUser(entities);
  if (authProviderSpec(config) || !user || !endpoints.some((e) => HASH_PATTERNS.has(e.pattern ?? ""))) return [];
  return [{
    id: AUTH_CREDENTIAL_ID,
    name: "AuthCredential", // table auth_credentials
    fields: [
      { id: "user_id", name: "user_id", type: user.pk.type, required: true, unique: true, primaryKey: true },
      { id: "password_hash", name: "password_hash", type: "string", required: true, unique: false },
    ],
  }];
}
