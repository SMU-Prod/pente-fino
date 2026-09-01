export type FeedbackAction = "dismiss" | "confirm";

/**
 * The client half of `POST /api/findings/:id/feedback` (§8.2). Never
 * throws: a network failure and a rejected request both resolve to
 * `false`, so the caller (`FindingsList`) always has a plain boolean to
 * branch its named-step UI on instead of a try/catch around a render.
 */
export async function sendFeedback(findingId: string, action: FeedbackAction, answer?: string): Promise<boolean> {
  const body = answer === undefined ? { action } : { action, answer };
  try {
    const response = await fetch(`/api/findings/${findingId}/feedback`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}
