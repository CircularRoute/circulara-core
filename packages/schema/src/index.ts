/**
 * Meter event schema - AD4 (v1.0) + AD12 sourcing additions (v1.1).
 * Load-bearing for billing, the savings statement, ESG export, and future
 * sourcing accounting. Append-only at the DB layer; validated here at intake.
 */
import { z } from "zod";

export const INTERVENTION_TYPES = [
  // v1.0
  "observe",
  "block",
  "compress",
  "route",
  "cap",
  "tool_prune",
  "prompt_cache",
  "response_cache_exact",
  "response_cache_semantic",
  "toolcall_cache",
  "reuse_exact",
  "reuse_semantic",
  // v1.1 (AD12, sourcing)
  "reuse_commons",
  "external_free",
  "external_paid",
  "purchase_proposed",
  "purchase_approved",
  "purchase_rejected",
] as const;

const confidence = z.enum(["Measured", "Benchmarked", "Estimated"]);

export const interventionEventSchema = z
  .object({
    event_id: z.string().uuid(),
    // QA M1: correlates every event for ONE underlying call. Stacked
    // interventions on a call form an ordered chain where each stage's
    // counterfactual_usd = the previous stage's actual_usd, so per-call
    // avoided_usd telescopes with no double-counting. Observe events (n2):
    // counterfactual = actual, avoided = 0, one event per call.
    call_id: z.string().uuid(),
    schema_version: z.enum(["1.0", "1.1"]),
    ts: z.string().datetime({ offset: true }),

    // attribution (AD6)
    seat_id: z.string().uuid(),
    identity_type: z.enum(["human", "named_agent"]),
    user_id: z.string().min(1),
    team_id: z.string().nullable().default(null),
    agent_identity: z.string().nullable().default(null),

    // context
    host: z.enum(["claude_code", "cursor", "other"]),
    capture_path: z.enum(["hook", "gateway", "tool"]), // AD3 A/B/C
    session_id: z.string().nullable().default(null),
    module: z.enum(["cost_controller", "reduce", "recycle", "reuse", "meter"]),
    intervention_type: z.enum(INTERVENTION_TYPES),

    model_requested: z.string().nullable().default(null),
    model_used: z.string().nullable().default(null),

    tokens: z.object({
      input_counterfactual: z.number().int().nonnegative(),
      output_counterfactual: z.number().int().nonnegative(),
      input_actual: z.number().int().nonnegative(),
      output_actual: z.number().int().nonnegative(),
    }),

    cost: z.object({
      counterfactual_usd: z.number().nonnegative(),
      actual_usd: z.number().nonnegative(),
      avoided_usd: z.number(), // counterfactual - actual; may be 0 for observe
      currency: z.literal("USD"),
      pricing_source: z.string(),
      pricing_version: z.string().min(1), // registry snapshot ref (WS6)
      // QA MJ6 (additive): HOW the avoided figure was derived. measured =
      // provider-reported deltas; estimated = char/token estimates or
      // client-declared build costs; upper_bound = worst-case assumptions
      // (blocked calls, cap truncation). Absent = measured-or-zero legacy.
      basis: z.enum(["measured", "estimated", "upper_bound"]).optional(),
    }),

    energy: z.object({
      avoided_kwh: z.number().nonnegative(),
      method: z.string(),
      confidence,
    }),
    carbon: z.object({
      avoided_co2e_g: z.number().nonnegative(),
      grid_intensity_g_per_kwh: z.number().nonnegative(),
      pue: z.number().positive(),
      region: z.string().nullable().default(null),
      method: z.string(),
      confidence,
    }),
    methodology_version: z.string(),

    asset_ref: z
      .object({
        exact_fp: z.string().nullable(),
        asset_type: z.number().int().min(1).max(16).nullable(),
        sharing_tier: z
          .enum(["private", "team", "org", "marketable"])
          .nullable(),
      })
      .nullable()
      .default(null),

    cache_ref: z
      .object({
        cache_key: z.string().nullable(),
        layer: z.enum(["exact", "semantic"]).nullable(),
        similarity: z.number().min(0).max(1).nullable(),
      })
      .nullable()
      .default(null),

    // v1.1 sourcing block (AD12). Required iff schema_version = 1.1 and the
    // intervention is a sourcing type; always nullable otherwise.
    sourcing: z
      .object({
        rung: z.number().int().min(1).max(4),
        source: z.enum([
          "org",
          "commons",
          "hf_hub",
          "data_gov",
          "data_europa",
          "roda",
          "adx",
          "snowflake",
        ]),
        catalog_ref: z.string().nullable().default(null),
        spend_usd: z.number().nonnegative().default(0),
        billing_route: z.enum(["customer_aws", "customer_snowflake", "none"]),
        approval_ref: z.string().nullable().default(null),
        license: z.object({
          redistributable: z.boolean(),
          spdx_or_terms: z.string().nullable(),
          parent_fp: z.string().nullable(),
        }),
        commons_captured: z.boolean().default(false),
      })
      .nullable()
      .default(null),

    // reserved for the deferred supply side (D7); nullable in v1. Named
    // catalog_reserved (QA n3): customer engineers read this schema and the
    // banned v1 vocabulary stays out of it.
    catalog_reserved: z
      .object({
        asset_id: z.string().nullable(),
        license_status: z.string().nullable(),
        price_placeholder: z.number().nullable(),
      })
      .nullable()
      .default(null),
  })
  .superRefine((ev, ctx) => {
    const sourcingTypes = new Set([
      "reuse_commons",
      "external_free",
      "external_paid",
      "purchase_proposed",
      "purchase_approved",
      "purchase_rejected",
    ]);
    if (sourcingTypes.has(ev.intervention_type)) {
      if (ev.schema_version !== "1.1")
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${ev.intervention_type} requires schema_version 1.1`,
        });
      if (!ev.sourcing)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${ev.intervention_type} requires a sourcing block`,
        });
    }
    const expected = ev.cost.counterfactual_usd - ev.cost.actual_usd;
    if (Math.abs(ev.cost.avoided_usd - expected) > 1e-9)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "avoided_usd must equal counterfactual_usd - actual_usd",
      });
  });

export type InterventionEvent = z.infer<typeof interventionEventSchema>;
