#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";

const SITE_ID       = "c1e0ce9a-17ec-471f-b7c8-1a7feb623274";
const COLLECTION    = "BlogPosts";
const BLOG_BASE_URL = "https://blog-wix-headless.ltpu.net";
const BLOG_DIR      = process.env.BLOG_DIR ?? "/Users/antonkol/my_projects/blog/blog";
const HTML_DIR      = join(BLOG_DIR, "target/classes");
const DOC_DIR       = join(BLOG_DIR, "src/main/doc");

const EXCLUDED_STEMS = new Set(["home", "about", "header", "footer"]);
const EXCLUDED_DIRS  = new Set(["common", "static"]);

function findArticles(dir, baseDir = dir) {
  const articles = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry)) articles.push(...findArticles(full, baseDir));
    } else if (extname(entry) === ".adoc") {
      const stem   = basename(entry, ".adoc");
      const relDir = relative(baseDir, dir);
      if (!relDir && EXCLUDED_STEMS.has(stem)) continue;
      const urlPath = relDir ? `${relDir}/${stem}` : stem;
      articles.push({ stem, urlPath, htmlFile: join(HTML_DIR, `${stem}.html`) });
    }
  }
  return articles;
}

function extractArticle(htmlFile) {
  const html = readFileSync(htmlFile, "utf8");
  const bodyStart = html.indexOf('<div class="sect1">');
  const bodyEnd   = html.indexOf('<div id="footer">');
  const bodyHtml  = bodyStart !== -1
    ? html.slice(bodyStart, bodyEnd !== -1 ? bodyEnd : undefined)
    : html;

  const titleMatch = bodyHtml.match(/<h2[^>]*>([^<]+)<\/h2>/)
                  ?? bodyHtml.match(/<h3[^>]*>([^<]+)<\/h3>/);
  const title = titleMatch ? titleMatch[1].trim() : "";

  let summary = "";
  for (const [, raw] of bodyHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = raw
      .replace(/<[^>]+>/g, " ")
      .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s+/g, " ").trim();
    if (text.length > 40 && !/^\d/.test(text)) { summary = text.slice(0, 400); break; }
  }

  const bodyText = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, " ").replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ").trim();

  return { title, summary, bodyText };
}

function getToken() {
  return execSync(`npx @wix/cli@latest token --site "${SITE_ID}"`, {
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  }).trim();
}

async function wix(path, body, token) {
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

// ── main ─────────────────────────────────────────────────────────────────────

console.log("Getting auth token...");
const token = getToken();

async function ensureCollection(collection, token) {
  try {
    await wix("/wix-data/v2/collections", { collection }, token);
    console.log(`  '${collection.id}' created.`);
  } catch (e) {
    if (!e.message.includes("already exists") && !e.message.includes("409")) throw e;
    console.log(`  '${collection.id}' already exists.`);
  }
}

console.log("Ensuring collections exist...");
await ensureCollection({
  id: COLLECTION, displayName: "Blog Posts",
  fields: [
    { key: "title",    displayName: "Title",     type: "TEXT" },
    { key: "summary",  displayName: "Summary",   type: "TEXT" },
    { key: "url",      displayName: "URL",       type: "TEXT" },
    { key: "tags",     displayName: "Tags",      type: "TEXT" },
    { key: "bodyText", displayName: "Body Text", type: "TEXT" },
  ],
  permissions: { read: "ANYONE", insert: "ADMIN", update: "ADMIN", delete: "ADMIN", remove: "ADMIN" },
}, token);
await ensureCollection({
  id: "Comments", displayName: "Comments",
  fields: [
    { key: "postUrl",   displayName: "Post URL",  type: "TEXT" },
    { key: "author",    displayName: "Author",    type: "TEXT" },
    { key: "content",   displayName: "Content",   type: "TEXT" },
    { key: "createdAt", displayName: "Created At", type: "TEXT" },
  ],
  permissions: { read: "ANYONE", insert: "ANYONE", update: "ADMIN", delete: "ADMIN", remove: "ADMIN" },
}, token);
await ensureCollection({
  id: "Reactions", displayName: "Reactions",
  fields: [
    { key: "postUrl", displayName: "Post URL", type: "TEXT" },
    { key: "type",    displayName: "Type",     type: "TEXT" },
  ],
  permissions: { read: "ANYONE", insert: "ANYONE", update: "ADMIN", delete: "ADMIN", remove: "ADMIN" },
}, token);

console.log("Fetching existing items from BlogPosts...");
const { dataItems = [] } = await wix("/wix-data/v2/items/query", {
  dataCollectionId: COLLECTION,
  query: { paging: { limit: 50 } },
}, token);
const existingByUrl = new Map(dataItems.map(({ id, data }) => [data.url, { id, data }]));

const articles = findArticles(DOC_DIR);
console.log(`Found ${articles.length} articles in source. Syncing...\n`);

let created = 0, updated = 0, skipped = 0;

for (const { stem, urlPath, htmlFile } of articles) {
  let article;
  try {
    article = extractArticle(htmlFile);
  } catch {
    console.warn(`  [skip] ${stem} — HTML not found`);
    skipped++;
    continue;
  }

  const url      = `${BLOG_BASE_URL}/${urlPath}`;
  const existing = existingByUrl.get(url);

  if (existing) {
    // preserve curated summary/tags; refresh title and full-text body
    await wix("/wix-data/v2/items/update", {
      dataCollectionId: COLLECTION,
      dataItem: {
        id: existing.id,
        data: {
          ...existing.data,
          title:    article.title    || existing.data.title,
          summary:  existing.data.summary || article.summary,
          bodyText: article.bodyText,
        },
      },
    }, token);
    console.log(`  [updated] ${article.title}`);
    updated++;
  } else {
    await wix("/wix-data/v2/items", {
      dataCollectionId: COLLECTION,
      dataItem: { data: { title: article.title, summary: article.summary, url, bodyText: article.bodyText, tags: "" } },
    }, token);
    console.log(`  [created] ${article.title}`);
    created++;
  }
}

console.log(`\nDone: ${created} created, ${updated} updated, ${skipped} skipped.`);
