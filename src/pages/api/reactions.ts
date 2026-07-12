import type { APIRoute } from "astro";

const SITE_ID    = "c1e0ce9a-17ec-471f-b7c8-1a7feb623274";
const CLIENT_ID  = "eb06cb34-e5e1-4c04-b372-1928a615bfeb";
const COLLECTION = "Reactions";
const BLOG_BASE  = "https://blog-wix-headless.ltpu.net";

const ALLOWED_ORIGINS = [
  "https://blog.ltpu.net",
  "https://blog-wix-headless.ltpu.net",
];

const VALID_TYPES = new Set(["like", "heart"]);

function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)
    ? requestOrigin
    : ALLOWED_ORIGINS[2];
  return {
    "Access-Control-Allow-Origin":  origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export const OPTIONS: APIRoute = ({ request }) =>
  new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });

async function getToken(): Promise<string> {
  const res = await fetch("https://www.wixapis.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, grantType: "anonymous" }),
  });
  const { access_token } = await res.json() as { access_token: string };
  return access_token;
}

async function wixPost(path: string, body: unknown, token: string) {
  const res = await fetch(`https://www.wixapis.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "wix-site-id": SITE_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function getCounts(postUrl: string, token: string): Promise<{ like: number; heart: number }> {
  const { dataItems = [] } = await wixPost("/wix-data/v2/items/query", {
    dataCollectionId: COLLECTION,
    query: {
      filter: { postUrl: { $eq: postUrl } },
      paging: { limit: 1000 },
    },
  }, token) as { dataItems: { data: { type: string } }[] };

  const counts = { like: 0, heart: 0 };
  for (const { data } of dataItems) {
    if (data.type === "like") counts.like++;
    else if (data.type === "heart") counts.heart++;
  }
  return counts;
}

export const GET: APIRoute = async ({ request, url }) => {
  const origin = request.headers.get("origin");
  const cors   = corsHeaders(origin);

  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    });
  }

  const postUrl = url.searchParams.get("url")?.trim() ?? "";
  if (!postUrl) {
    return new Response(JSON.stringify({ like: 0, heart: 0 }), {
      headers: { "Content-Type": "application/json", ...cors },
    });
  }

  const token  = await getToken();
  const counts = await getCounts(postUrl, token);
  return new Response(JSON.stringify(counts), {
    headers: { "Content-Type": "application/json", ...cors },
  });
};

export const POST: APIRoute = async ({ request }) => {
  const origin = request.headers.get("origin");
  const cors   = corsHeaders(origin);

  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    });
  }

  let body: { url?: string; type?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { "Content-Type": "application/json", ...cors },
    });
  }

  const postUrl = body.url?.trim() ?? "";
  const type    = body.type?.trim() ?? "";

  if (!postUrl || !VALID_TYPES.has(type)) {
    return new Response(JSON.stringify({ error: "url and valid type (like|heart) required" }), {
      status: 400, headers: { "Content-Type": "application/json", ...cors },
    });
  }

  if (!postUrl.startsWith(BLOG_BASE)) {
    return new Response(JSON.stringify({ error: "Invalid post URL" }), {
      status: 400, headers: { "Content-Type": "application/json", ...cors },
    });
  }

  const token = await getToken();
  await wixPost("/wix-data/v2/items", {
    dataCollectionId: COLLECTION,
    dataItem: { data: { postUrl, type } },
  }, token);

  const counts = await getCounts(postUrl, token);
  return new Response(JSON.stringify(counts), {
    headers: { "Content-Type": "application/json", ...cors },
  });
};
