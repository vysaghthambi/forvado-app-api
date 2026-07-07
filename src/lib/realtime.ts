/**
 * Server-side Supabase Realtime broadcast helper.
 * Uses the Realtime REST broadcast endpoint so we don't need a WebSocket from the server.
 * Clients subscribed to the channel via postgres_changes already get DB-level events;
 * this broadcast provides an additional low-latency push for phase changes and score updates.
 */
export async function broadcastMatchEvent(
  matchId: string,
  event: string,
  payload: Record<string, unknown>
) {
  const url = `${process.env.SUPABASE_URL}/realtime/v1/api/broadcast`
  const key = process.env.SUPABASE_SECRET_KEY

  if (!url || !key) return

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
      body: JSON.stringify({
        messages: [
          {
            topic: `match:${matchId}`,
            event,
            payload,
          },
        ],
      }),
    })
  } catch {
    // Non-critical — postgres_changes will still deliver the update
  }
}
