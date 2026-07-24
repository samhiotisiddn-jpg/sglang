"use server";

import { z } from "zod";

const dashboardMutationSchema = z.object({
  workspaceId: z.string().uuid(),
  widgetId: z.string().min(1).max(128),
  operation: z.enum(["pin", "unpin", "archive", "restore"]),
});

export type DashboardActionState = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

export const initialDashboardActionState: DashboardActionState = {
  ok: false,
  message: "Idle",
};

export async function mutateDashboard(
  _previousState: DashboardActionState,
  formData: FormData,
): Promise<DashboardActionState> {
  const parsed = dashboardMutationSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
    widgetId: formData.get("widgetId"),
    operation: formData.get("operation"),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: "Validation failed",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const endpoint = process.env.FRACTALMESH_DASHBOARD_API_URL;
  const authToken = process.env.FRACTALMESH_DASHBOARD_API_TOKEN;

  if (!endpoint || !authToken) {
    return {
      ok: false,
      message: "Dashboard API credentials are not configured",
    };
  }

  const response = await fetch(`${endpoint.replace(/\/$/, "")}/dashboard/mutate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(parsed.data),
    cache: "no-store",
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `Mutation failed (${response.status})`,
    };
  }

  return {
    ok: true,
    message: "Dashboard mutation accepted",
  };
}
