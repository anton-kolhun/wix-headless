import type { APIRoute } from "astro";
import { contacts } from "@wix/crm";
import { auth } from "@wix/essentials";

const ALLOWED_ORIGINS = [
  "https://blog.ltpu.net",
];

function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)
    ? requestOrigin
    : ALLOWED_ORIGINS[1];
  return {
    "Access-Control-Allow-Origin":  origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export const OPTIONS: APIRoute = ({ request }) =>
  new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });

export const POST: APIRoute = async ({ request }) => {
  const origin = request.headers.get("origin");
  const cors   = corsHeaders(origin);

  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    });
  }

  let body: { name?: string; email?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { "Content-Type": "application/json", ...cors },
    });
  }

  const name  = body.name?.trim().slice(0, 100) ?? "";
  const email = body.email?.trim().toLowerCase() ?? "";

  if (!email || !email.includes("@") || !email.includes(".")) {
    return new Response(JSON.stringify({ error: "Valid email required" }), {
      status: 400, headers: { "Content-Type": "application/json", ...cors },
    });
  }

  try {
    const elevatedCreate = auth.elevate(contacts.createContact);
    await elevatedCreate({
      name:   { first: name || email.split("@")[0] },
      emails: { items: [{ tag: "MAIN" as const, email }] },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("already exists") && !msg.includes("409")) {
      console.error("Failed to create Wix Contact:", msg);
      return new Response(JSON.stringify({ error: "Subscription failed, please try again" }), {
        status: 502, headers: { "Content-Type": "application/json", ...cors },
      });
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", ...cors },
  });
};
