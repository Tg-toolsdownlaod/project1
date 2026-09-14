/**
 * One-off CLI: migrate every object in the source S3-compatible bucket
 * (S3_* env vars -- see .env.example) into R2, deleting each object from the
 * source once it is confirmed safely in R2. Streams straight through; never
 * writes a video to disk.
 *
 *   node src/migrate-s3-to-r2.js                        # dry run (default, nothing changes)
 *   node src/migrate-s3-to-r2.js --apply                # migrate + delete from source
 *   node src/migrate-s3-to-r2.js --apply --keep-source   # migrate, keep source objects
 *   node src/migrate-s3-to-r2.js --prefix episodes/      # limit to one prefix
 *   node src/migrate-s3-to-r2.js --apply --concurrency 4
 *
 * Safe to re-run: objects already in R2 with a matching size are skipped, so
 * an interrupted run (or a retry after --apply reports failures) just picks
 * up where it left off.
 */
import { run, status } from "./s3migrate.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const keepSource = args.includes("--keep-source");
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const prefix = flagValue("--prefix", "");
const concurrency = Number(flagValue("--concurrency", "2")) || 2;

console.log(`Mode: ${apply ? `APPLY (migrate${keepSource ? "" : " + delete from source"})` : "DRY RUN (list only, nothing changes)"}`);
console.log(`Prefix: ${prefix || "(all)"}   Concurrency: ${concurrency}\n`);

const ticker = setInterval(() => {
  const s = status();
  process.stdout.write(
    `  scanned ${s.scanned}/${s.total}  migrated ${s.migrated}  skipped ${s.skipped}  failed ${s.failed}\r`
  );
}, 1000);

try {
  await run({ prefix, dryRun: !apply, deleteSource: apply && !keepSource, concurrency });
} finally {
  clearInterval(ticker);
}

const final = status();
console.log("\n\n=== Migration summary ===");
console.log(JSON.stringify(final, null, 2));

if (!apply) {
  console.log("\nThis was a DRY RUN. Nothing was uploaded, deleted, or otherwise changed.");
  console.log("Re-run with --apply to actually migrate. Add --keep-source to skip deleting from S3.");
} else if (final.failed > 0) {
  console.log(`\n${final.failed} object(s) failed -- see "errors" above.`);
  console.log("Re-run the same command: objects already migrated are skipped automatically.");
  process.exitCode = 1;
} else {
  console.log(
    "\nDone. Every scanned object is now in R2" +
      (keepSource ? ", source objects were kept." : " and removed from the source bucket.")
  );
}

process.exit(process.exitCode ?? 0);
