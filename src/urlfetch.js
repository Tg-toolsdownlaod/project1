/**
 * Saves the URLs of a URL list into R2.
 *
 * Each item is fetched over HTTP and streamed straight into the bucket -- the
 * body never lands on disk and is never held in memory, so a list of feature
 * length videos costs the service nothing but bandwidth.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { Readable } from "node:stream";

import { config } from "./config.js";
import { db, nowIso, rows } from "./db.js";
import { recordManualUpload } from "./library.js";
import * as r2 from "./r2.js";

const running = new Set();
const MAX_REDIRECTS = 5;

/** Marks every item of a list that is not already in R2 as queued. */
export async function queueList(listId) {
  const items = rows(
    await db()
      .from("url_list_items")
      .select("id,status,r2_key")
      .eq("url_list_id", listId)
  );
  const ids = items.filter((it) => !it.r2_key && it.status !== "downloading").map((it) => it.id);
  return queueItems(ids);
}

/** Marks specific items as queued, skipping the ones already in flight. */
export async function queueItems(ids) {
  const wanted = (ids ?? []).filter(Boolean).filter((id) => !running.has(id));
  if (wanted.length === 0) return 0;
  rows(
    await db()
      .from("url_list_items")
      .update({ status: "queued", error: null, updated_at: nowIso() })
      .in("id", wanted)
      .select("id")
  );
  return wanted.length;
}

/**
 * Starts as many queued fetches as the concurrency limit allows. Safe to call
 * on every worker tick: items already running are never picked up twice.
 */
export async function processQueue() {
  const limit = config.maxConcurrentUrlFetches;
  const freeSlots = Math.max(limit - running.size, 0);
  if (freeSlots === 0) return 0;

  const queued = rows(
    await db()
      .from("url_list_items")
      .select("*")
      .eq("status", "queued")
      .order("episode_number", { ascending: true, nullsFirst: false })
      .limit(freeSlots + running.size)
  ).filter((item) => !running.has(item.id));

  let started = 0;
  for (const item of queued.slice(0, freeSlots)) {
    void saveItem(item.id);
    started += 1;
  }
  return started;
}

/** Fetches one item's URL and streams it into R2, recording the result. */
export async function saveItem(itemId) {
  if (running.has(itemId)) return;
  running.add(itemId);

  try {
    const found = rows(await db().from("url_list_items").select("*").eq("id", itemId).limit(1));
    if (found.length === 0) return;
    const item = found[0];

    const [list] = rows(
      await db().from("url_lists").select("title").eq("id", item.url_list_id).limit(1)
    );
    // The list's own title doubles as the show name, so every URL saved from
    // it lands next to the others under one readable folder instead of all
    // piling into a single flat "urls/" bucket with no way to tell them apart.
    const showTitle = (list?.title || "").trim() || config.urlFetchFolder;

    await patch(itemId, { status: "downloading", error: null });

    const response = await fetchFollowingRedirects(item.url);
    if (!response.ok || !response.body) {
      throw new Error(`The server answered ${response.status} ${response.statusText}.`);
    }

    const fileName = fileNameFor(item, response);
    const key = buildListItemKey(showTitle, item, fileName);
    const url = await r2.uploadBody(
      Readable.fromWeb(response.body),
      key,
      response.headers.get("content-type") || "video/mp4"
    );
    const size = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    const publicUrl = url === key ? null : url;

    await patch(itemId, {
      status: "completed",
      r2_key: key,
      r2_url: publicUrl,
      file_size: Number.isFinite(size) ? size : null,
      error: null,
    });

    await recordManualUpload({
      show: showTitle,
      season: "",
      episodeNumber: item.episode_number ?? null,
      label: item.label || "",
      key,
      url: publicUrl,
      size: Number.isFinite(size) ? size : 0,
      fileName,
    }).catch((err) => console.error("Filing URL-list item as an episode failed:", err?.message ?? err));
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 500);
    console.error(`Saving URL item ${itemId} to R2 failed:`, message);
    await patch(itemId, { status: "failed", error: message }).catch(() => {});
  } finally {
    running.delete(itemId);
  }
}

async function patch(id, values) {
  rows(
    await db()
      .from("url_list_items")
      .update({ ...values, updated_at: nowIso() })
      .eq("id", id)
      .select("id")
  );
}

/**
 * fetch() follows redirects on its own, but then only the first hop is ever
 * checked against the rules below -- a redirect to 169.254.169.254 would sail
 * straight through. Following them by hand keeps every hop checked.
 */
async function fetchFollowingRedirects(startUrl) {
  let target = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(target);
    const response = await fetch(target, { redirect: "manual" });
    if (response.status < 300 || response.status > 399) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    void response.body?.cancel();
    target = new URL(location, target).toString();
  }
  throw new Error("Too many redirects.");
}

/**
 * Refuses anything that is not a public HTTP address. The service holds the
 * Supabase service-role key and the R2 secret, and its own network is where a
 * cloud metadata endpoint lives -- a URL pasted into a list must not be able to
 * make it fetch either.
 */
export async function assertPublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs can be saved.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error(`Could not resolve ${url.hostname}.`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`${url.hostname} resolves to a private address (${address}).`);
    }
  }
}

/** True for loopback, link-local, private and other non-routable addresses. */
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // ::ffff:10.0.0.1 and friends are IPv4 wearing an IPv6 hat.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

/**
 * A readable, deterministic key for a saved URL-list item: the show
 * (the list's own title) plus an episode number or a slugged label -- so the
 * key and the public URL say on their own which show and which episode it
 * is, and re-saving the same item overwrites it instead of piling up copies.
 */
function buildListItemKey(showTitle, item, fileName) {
  const dir = r2.slugPath(showTitle) || "urls";
  const dot = fileName.lastIndexOf(".");
  const ext = (dot > 0 ? fileName.slice(dot + 1) : "").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
  const hasEp = item.episode_number !== null && item.episode_number !== undefined;
  const namePart = hasEp
    ? `EP${String(item.episode_number).padStart(3, "0")}`
    : r2.slugPath(item.label || (dot > 0 ? fileName.slice(0, dot) : fileName)) || "video";
  return `${dir}/${namePart}.${ext}`;
}

/** A readable file name for an item: its label, its episode number, or the URL. */
function fileNameFor(item, response) {
  const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(
    response.headers.get("content-disposition") || ""
  );
  const candidates = [
    item.label,
    item.episode_number !== null && item.episode_number !== undefined
      ? `EP${String(item.episode_number).padStart(3, "0")}`
      : "",
    fromHeader ? decodeURIComponent(fromHeader[1]) : "",
    decodeURIComponent(new URL(item.url).pathname.split("/").filter(Boolean).pop() || ""),
  ].filter(Boolean);

  const name = candidates[0] || "video";
  const extension =
    extensionOf(fromHeader ? decodeURIComponent(fromHeader[1]) : "") ||
    extensionOf(new URL(item.url).pathname) ||
    extensionFromType(response.headers.get("content-type")) ||
    "mp4";
  return extensionOf(name) ? name : `${name}.${extension}`;
}

const extensionOf = (name) => {
  const match = /\.([a-z0-9]{2,5})$/i.exec(name || "");
  return match ? match[1].toLowerCase() : "";
};

const extensionFromType = (contentType) => {
  const type = (contentType || "").split(";")[0].trim().toLowerCase();
  return { "video/mp4": "mp4", "video/x-matroska": "mkv", "video/webm": "webm", "video/quicktime": "mov" }[type] || "";
};
