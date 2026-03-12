/**
 * fetch-patrons.js
 *
 * Fetches active members from all three CMG Patreon campaigns,
 * merges them into a single list sorted oldest → newest, and
 * writes public/patrons.json ready for the patron wall HTML.
 *
 * Expects these environment variables (set as GitHub Secrets):
 *   PATREON_TOKEN_REDWOOD
 *   PATREON_TOKEN_WILLOW
 *   PATREON_TOKEN_TWELVEFOLD
 *
 * Run locally:
 *   PATREON_TOKEN_REDWOOD=xxx PATREON_TOKEN_WILLOW=yyy \
 *   PATREON_TOKEN_TWELVEFOLD=zzz node scripts/fetch-patrons.js
 */

import fetch from "node-fetch";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Campaign tokens ────────────────────────────────────────────────────────
const CAMPAIGNS = [
  { name: "Redwood",    token: process.env.PATREON_TOKEN_REDWOOD },
  { name: "Willow",     token: process.env.PATREON_TOKEN_WILLOW },
  { name: "Twelvefold", token: process.env.PATREON_TOKEN_TWELVEFOLD },
];

// ── Patreon API helpers ────────────────────────────────────────────────────

/**
 * Fetch the campaign ID for a given creator token.
 * Each token belongs to one campaign, so we just grab the first result.
 */
async function getCampaignId(token) {
  const url = "https://www.patreon.com/api/oauth2/v2/campaigns?fields[campaign]=id";
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Campaign fetch failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (!json.data?.length) throw new Error("No campaigns found for this token");
  return json.data[0].id;
}

/**
 * Fetch all active members for a campaign, handling Patreon's cursor pagination.
 * Returns an array of { name, pledgeDate } objects.
 *
 * Fields requested:
 *   full_name                    — the patron's display name
 *   pledge_relationship_start    — ISO 8601 date string e.g. "2023-06-14T10:22:00.000+00:00"
 *   patron_status                — we only keep "active_patron"
 */
async function fetchCampaignMembers(token, campaignId) {
  const members = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({
      "fields[member]": "full_name,pledge_relationship_start,patron_status",
      "page[count]": "500",
    });
    if (cursor) params.set("page[cursor]", cursor);

    const url = `https://www.patreon.com/api/oauth2/v2/campaigns/${campaignId}/members?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) throw new Error(`Members fetch failed: ${res.status} ${res.statusText}`);
    const json = await res.json();

    for (const member of json.data ?? []) {
      const { full_name, pledge_relationship_start, patron_status } = member.attributes;

      // Skip lapsed or declined patrons
      if (patron_status !== "active_patron") continue;

      // pledge_relationship_start can be null for very old accounts
      const pledgeDate = pledge_relationship_start
        ? pledge_relationship_start.slice(0, 7)  // "YYYY-MM"
        : "0000-00";

      members.push({ name: full_name, pledgeDate });
    }

    // Patreon uses cursor-based pagination
    cursor = json.meta?.pagination?.cursors?.next ?? null;
  } while (cursor);

  return members;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const allMembers = [];
  const errors = [];

  for (const campaign of CAMPAIGNS) {
    if (!campaign.token) {
      console.warn(`⚠️  No token for ${campaign.name} — skipping`);
      continue;
    }

    try {
      console.log(`Fetching ${campaign.name}...`);
      const campaignId = await getCampaignId(campaign.token);
      const members = await fetchCampaignMembers(campaign.token, campaignId);
      console.log(`  → ${members.length} active patrons`);
      allMembers.push(...members);
    } catch (err) {
      console.error(`  ✗ ${campaign.name}: ${err.message}`);
      errors.push(campaign.name);
    }
  }

  if (allMembers.length === 0) {
    console.error("No patrons fetched — not writing file to avoid wiping the wall.");
    process.exit(1);
  }

  // Deduplicate by name+date in case a patron supports multiple campaigns
  const seen = new Set();
  const unique = allMembers.filter(({ name, pledgeDate }) => {
    const key = `${name}::${pledgeDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort oldest → newest
  unique.sort((a, b) => a.pledgeDate.localeCompare(b.pledgeDate));

  // Write output
  const outDir = join(__dirname, "..", "public");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "patrons.json");
  writeFileSync(outPath, JSON.stringify({ updatedAt: new Date().toISOString(), patrons: unique }, null, 2));

  console.log(`\n✓ Wrote ${unique.length} patrons to public/patrons.json`);
  if (errors.length) console.warn(`⚠️  Campaigns with errors: ${errors.join(", ")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
