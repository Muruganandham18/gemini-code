import type { ToolDefinition } from "../types.js";

const MAX_RESULTS = 10;
const TIMEOUT_MS = 20_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * DuckDuckGo's HTML endpoint: no API key, no JavaScript, stable markup.
 *
 * Chosen over scraping Google, which blocks automated requests outright and
 * would mean fighting a bot check on every search.
 */
const ENDPOINT = "https://html.duckduckgo.com/html/";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** DDG wraps every result in a redirect; the real URL is the uddg parameter. */
function unwrapUrl(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      /* fall through to the raw href */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

export function parseResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Each hit is an <a class="result__a" href=...>title</a>, with the snippet
  // in a following result__snippet block.
  const blocks = html.split('class="result__a"').slice(1);

  for (const block of blocks) {
    if (results.length >= limit) break;
    const hrefMatch = block.match(/href="([^"]+)"/);
    const titleMatch = block.match(/>([\s\S]*?)<\/a>/);
    if (!hrefMatch || !titleMatch) continue;

    const url = unwrapUrl(decodeEntities(hrefMatch[1]));
    const title = stripTags(titleMatch[1]);
    if (!title || !/^https?:/.test(url)) continue;

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]).slice(0, 300) : "";

    results.push({ title, url, snippet });
  }
  return results;
}

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    `web_search(args: {query: string, maxResults?: number}) -> searches the web and returns titles, URLs and ` +
    `snippets. Use it when you need current information you don't have — a library's latest version, an error ` +
    `message, how an API works — then read_page or fetch_url the most promising result for the detail. ` +
    `For a package's current version, fetching the registry directly is more reliable: ` +
    `https://pypi.org/pypi/<name>/json or https://registry.npmjs.org/<name>/latest.`,
  async run(args) {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, output: "Error: 'query' is required." };
    const limit = Math.min(Math.max(Number(args.maxResults) || 5, 1), MAX_RESULTS);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${ENDPOINT}?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
        headers: {
          // Without a normal UA the endpoint returns an empty result page.
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        },
      });
      if (!res.ok) return { ok: false, output: `Search failed: HTTP ${res.status}` };

      const results = parseResults(await res.text(), limit);
      if (results.length === 0) {
        return { ok: true, output: `No results for "${query}".` };
      }

      const body = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
        .join("\n\n");
      return { ok: true, output: `Results for "${query}":\n\n${body}` };
    } catch (err) {
      const e = err as Error;
      return {
        ok: false,
        output:
          e.name === "AbortError"
            ? `Search timed out after ${TIMEOUT_MS / 1000}s.`
            : `Search failed: ${e.message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
