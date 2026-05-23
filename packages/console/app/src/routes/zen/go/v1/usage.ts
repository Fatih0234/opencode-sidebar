import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, isNull } from "@opencode-ai/console-core/drizzle/index.js"
import { KeyTable } from "@opencode-ai/console-core/schema/key.sql.js"
import { BillingTable, LiteTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import { LiteData } from "@opencode-ai/console-core/lite.js"
import { Subscription } from "@opencode-ai/console-core/subscription.js"

export async function OPTIONS(_input: APIEvent) {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  })
}

export async function GET(input: APIEvent) {
  try {
    // 1. Parse the Go API key from the Authorization header
    const authHeader = input.request.headers.get("authorization")
    if (!authHeader) {
      return authError("Missing API key. Use Authorization: Bearer <sk-opencode-...>.")
    }

    const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader
    if (!apiKey) {
      return authError("Missing API key. Use Authorization: Bearer <sk-opencode-...>.")
    }

    // 2. Authenticate and fetch lite subscription data
    //    Follows the same join pattern as authenticate() in handler.ts
    const data = await Database.use((tx) =>
      tx
        .select({
          workspaceID: KeyTable.workspaceID,
          lite: {
            id: LiteTable.id,
            rollingUsage: LiteTable.rollingUsage,
            weeklyUsage: LiteTable.weeklyUsage,
            monthlyUsage: LiteTable.monthlyUsage,
            timeRollingUpdated: LiteTable.timeRollingUpdated,
            timeWeeklyUpdated: LiteTable.timeWeeklyUpdated,
            timeMonthlyUpdated: LiteTable.timeMonthlyUpdated,
            timeCreated: LiteTable.timeCreated,
          },
          billingLite: BillingTable.lite,
        })
        .from(KeyTable)
        .innerJoin(BillingTable, eq(BillingTable.workspaceID, KeyTable.workspaceID))
        .leftJoin(
          LiteTable,
          and(
            eq(LiteTable.workspaceID, KeyTable.workspaceID),
            eq(LiteTable.userID, KeyTable.userID),
            isNull(LiteTable.timeDeleted),
          ),
        )
        .where(and(eq(KeyTable.key, apiKey), isNull(KeyTable.timeDeleted)))
        .then((rows) => rows[0]),
    )

    if (!data) {
      return authError("Invalid API key.")
    }

    // 3. Verify the workspace has an active Go (lite) subscription
    if (!data.billingLite) {
      return jsonResponse(
        {
          type: "error",
          error: { type: "Error", message: "This API key is not associated with a Go subscription." },
        },
        { status: 400 },
      )
    }

    // 4. Verify the LiteTable row exists (subscription not cancelled or soft-deleted)
    //    leftJoin produces an object with all-null fields when the row is missing,
    //    so check the primary key specifically.
    if (!data.lite?.id) {
      return jsonResponse(
        {
          type: "error",
          error: { type: "Error", message: "Go subscription is no longer active." },
        },
        { status: 400 },
      )
    }

    // 5. Read current limits and compute usage percentages
    const limits = LiteData.getLimits()

    const rollingUsage = Subscription.analyzeRollingUsage({
      limit: limits.rollingLimit,
      window: limits.rollingWindow,
      usage: data.lite?.rollingUsage ?? 0,
      timeUpdated: data.lite?.timeRollingUpdated ?? new Date(),
    })

    const weeklyUsage = Subscription.analyzeWeeklyUsage({
      limit: limits.weeklyLimit,
      usage: data.lite?.weeklyUsage ?? 0,
      timeUpdated: data.lite?.timeWeeklyUpdated ?? new Date(),
    })

    const monthlyUsage = Subscription.analyzeMonthlyUsage({
      limit: limits.monthlyLimit,
      usage: data.lite?.monthlyUsage ?? 0,
      timeUpdated: data.lite?.timeMonthlyUpdated ?? new Date(),
      timeSubscribed: data.lite?.timeCreated ?? new Date(),
    })

    // 6. Return usage data — same shape the console computes in queryLiteSubscription
    return jsonResponse({
      workspace: data.workspaceID,
      plan: "go",
      rollingUsage,
      weeklyUsage,
      monthlyUsage,
      useBalance: data.billingLite.useBalance ?? false,
    })
  } catch (error) {
    return jsonResponse(
      {
        type: "error",
        error: { type: "Error", message: "Internal server error" },
      },
      { status: 500 },
    )
  }
}

function authError(message: string) {
  return jsonResponse(
    {
      type: "error",
      error: { type: "AuthError", message },
    },
    { status: 401 },
  )
}

function jsonResponse(body: unknown, init?: { status?: number }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  })
}
