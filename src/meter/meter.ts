/**
 * Meter intake + summary (WS0 slice of WS4).
 * Intake validates against the AD4/AD12 schema and appends; the store's
 * trigger makes mutation impossible after that.
 */
import type { TenantContext } from "../db/tenancy.js";
import {
  interventionEventSchema,
  type InterventionEvent,
} from "../events/schema.js";

export async function ingestEvent(
  ctx: TenantContext,
  raw: unknown,
): Promise<{ event_id: string }> {
  const ev: InterventionEvent = interventionEventSchema.parse(raw);

  // seat must exist (attribution is load-bearing, AD6)
  const seat = await ctx.db.query(
    `SELECT seat_id FROM seats WHERE seat_id = $1 AND active`,
    [ev.seat_id],
  );
  if (seat.rows.length === 0)
    throw Object.assign(new Error(`unknown or inactive seat ${ev.seat_id}`), {
      statusCode: 422,
    });

  await ctx.db.query(
    `INSERT INTO meter_events
       (event_id, call_id, schema_version, ts, seat_id, module, intervention_type,
        host, capture_path, avoided_usd, actual_usd, pricing_version,
        sourcing_rung, sourcing_spend_usd, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      ev.event_id,
      ev.call_id,
      ev.schema_version,
      ev.ts,
      ev.seat_id,
      ev.module,
      ev.intervention_type,
      ev.host,
      ev.capture_path,
      ev.cost.avoided_usd,
      ev.cost.actual_usd,
      ev.cost.pricing_version,
      ev.sourcing?.rung ?? null,
      ev.sourcing?.spend_usd ?? null,
      JSON.stringify(ev),
    ],
  );
  return { event_id: ev.event_id };
}

export interface MeterSummary {
  events: number;
  observed_usd: number; // actual spend seen (Observe baseline)
  avoided_usd: number; // interventions (0 in pure Observe)
  external_spend_usd: number; // rung-4 purchases, reported separately (AD12)
  by_seat: { seat_id: string; events: number; observed_usd: number }[];
}

export async function meterSummary(ctx: TenantContext): Promise<MeterSummary> {
  const totals = await ctx.db.query<{
    events: number;
    observed_usd: string;
    avoided_usd: string;
    external_spend_usd: string;
  }>(
    `SELECT count(*)::int AS events,
            coalesce(sum(actual_usd),0)::text AS observed_usd,
            coalesce(sum(avoided_usd),0)::text AS avoided_usd,
            coalesce(sum(sourcing_spend_usd),0)::text AS external_spend_usd
       FROM meter_events`,
  );
  const bySeat = await ctx.db.query<{
    seat_id: string;
    events: number;
    observed_usd: string;
  }>(
    `SELECT seat_id, count(*)::int AS events,
            coalesce(sum(actual_usd),0)::text AS observed_usd
       FROM meter_events GROUP BY seat_id ORDER BY 3 DESC`,
  );
  const t = totals.rows[0];
  return {
    events: t.events,
    observed_usd: Number(t.observed_usd),
    avoided_usd: Number(t.avoided_usd),
    external_spend_usd: Number(t.external_spend_usd),
    by_seat: bySeat.rows.map((r) => ({
      seat_id: r.seat_id,
      events: r.events,
      observed_usd: Number(r.observed_usd),
    })),
  };
}
