import { randomUUID } from "node:crypto";
import { Archil, type Disk } from "disk";
import { defineEval } from "eve/evals";
import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

const seedText = "archil account review seed\n";
const inventoryCsv = `item,quantity,unit_price
notebook,2,7.50
pen,5,1.20
folder,3,2.00
`;
const adjustmentsCsv = `label,amount
promo_credit,-1.50
shipping,4.25
`;
const runbookConfig = "currency=USD\nrunbook=archil-account-review\n";
const reviewMarker = "ARCHIL_REVIEW_READY";
const followUpMarker = "ARCHIL_FOLLOWUP_READY";
const freshMarker = "ARCHIL_FRESH_READY";
const packetId = `account-review-${process.env.VERCEL_DEPLOYMENT_ID ?? randomUUID()}`;
const rootPrefix = normalizePrefix(`${process.env.ARCHIL_E2E_ROOT_PREFIX ?? "archil-e2e/reviews"}/${packetId}`);

const client = new Archil({
  apiKey: requireEnv("ARCHIL_API_KEY"),
  region: requireEnv("ARCHIL_REGION"),
  baseUrl: process.env.ARCHIL_BASE_URL,
  s3BaseUrl: process.env.ARCHIL_S3_BASE_URL,
});
const disk = await client.disks.get(requireEnv("ARCHIL_E2E_DISK_ID"));

const firstTask = `
Please review the small accounting packet named ${packetId}.

Find the packet yourself by searching for ${packetId}. The packet has a seed note, a runbook config file, an inventory CSV, and an adjustments CSV.

Compute the gross total as the sum of quantity * unit_price from the inventory CSV. Compute the adjusted total as the gross total plus every amount in the adjustments CSV. Format currency values to cents.

Write both of these artifacts in the reports/ directory inside the packet root:
- reports/review.md: a concise report that includes the seed note text, the runbook id, the gross total, the adjusted total, and ${reviewMarker}
- reports/review.json: valid JSON with the packet id, runbook id, currency, gross total, adjusted total, and ${reviewMarker}
Use paths relative to the discovered packet root; do not write the report artifacts elsewhere.

Read both artifacts back and verify their contents before replying.

When you are done, reply in one short sentence containing ARCHIL_REVIEW_DONE.
`;

const secondTask = `
Please continue the accounting packet review for ${packetId}.

Find the packet yourself by searching for ${packetId}. Then find the existing report material in its reports/ directory.

Write a separate follow-up artifact at reports/follow-up.md. It should clearly refer back to ${reviewMarker}, summarize that the original review artifacts are present, and include ${followUpMarker}.
Use the path relative to the discovered packet root; do not write the follow-up artifact elsewhere.

Read the follow-up artifact back and verify its contents before replying.

When you are done, reply in one short sentence containing ARCHIL_FOLLOWUP_DONE.
`;

const freshTask = `
Please do an independent continuity check for ${packetId}.

Find the packet yourself by searching for ${packetId}. Then find the earlier review and follow-up artifacts in its reports/ directory.

Write a separate continuity note at reports/continuity.md. It should confirm that the earlier artifacts are visible, include both ${reviewMarker} and ${followUpMarker}, and include ${freshMarker}.
Use the path relative to the discovered packet root; do not write the continuity note elsewhere.

Read the continuity note back and verify its contents before replying.

When you are done, reply in one short sentence containing ARCHIL_CONTINUITY_DONE.
`;

export default defineEval({
  description: "Exercises createDiskTools for Eve through a real model-driven Archil disk task.",
  tags: ["archil", "e2e"],
  async test(t) {
    await seedDisk(disk, rootPrefix);
    t.log(`Seeded accounting packet: ${packetId}`);

    const first = await t.send(firstTask);
    first.expectOk();
    printTurnTrace(t, "review", first);
    t.check(first.message, includes("ARCHIL_REVIEW_DONE"));
    first.calledTool("glob").soft();
    first.calledTool("read_file").soft();
    first.calledTool("write_file").soft();
    await checkStep1Reports(t, disk, rootPrefix);

    const second = await t.send(secondTask);
    second.expectOk();
    printTurnTrace(t, "follow-up", second);
    t.check(second.message, includes("ARCHIL_FOLLOWUP_DONE"));
    second.calledTool("write_file").soft();
    await checkStep2Reports(t, disk, rootPrefix);

    const freshSession = t.newSession();
    const fresh = await freshSession.send(freshTask);
    fresh.expectOk();
    printTurnTrace(t, "continuity", fresh);
    t.check(fresh.message, includes("ARCHIL_CONTINUITY_DONE"));
    fresh.calledTool("read_file").soft();
    fresh.calledTool("write_file").soft();
    await checkFreshSessionReport(t, disk, rootPrefix);

    t.succeeded();
  },
});

async function seedDisk(disk: Disk, root: string): Promise<void> {
  const existingReports = await disk.listObjects(`${root}/reports/`, { recursive: true });
  await Promise.all([
    ...existingReports.objects.map((object) => disk.deleteObject(object.key)),
    disk.putObject(key(root, `${packetId}-seed.txt`), seedText, "text/plain"),
    disk.putObject(key(root, `config/${packetId}-runbook.env`), runbookConfig, "text/plain"),
    disk.putObject(key(root, `data/${packetId}-inventory.csv`), inventoryCsv, "text/csv"),
    disk.putObject(key(root, `data/${packetId}-adjustments.csv`), adjustmentsCsv, "text/csv"),
  ]);
}

type EvalChecks = Pick<EveEvalContext, "check">;
type EvalLog = Pick<EveEvalContext, "log">;

function printTurnTrace(t: EvalLog, label: string, turn: EveEvalTurn): void {
  const lines = [`[eve-e2e:${label}] tool calls:`];

  if (turn.toolCalls.length === 0) {
    lines.push("  (none)");
  }

  for (const call of turn.toolCalls) {
    lines.push(`  - ${call.name} (${call.status})`);
  }

  const reasoning = collectReasoning(turn);
  if (reasoning.length > 0) {
    lines.push(`[eve-e2e:${label}] reasoning:`);
    for (const text of reasoning) {
      lines.push(indent(text.trim()));
    }
  }

  const output = lines.join("\n");
  console.log(output);
  t.log(output);
}

function collectReasoning(turn: EveEvalTurn): string[] {
  const completed = turn.events.flatMap((event) =>
    event.type === "reasoning.completed" && event.data.reasoning.length > 0 ? [event.data.reasoning] : [],
  );
  if (completed.length > 0) {
    return completed;
  }

  const appendedByStep = new Map<number, string>();
  for (const event of turn.events) {
    if (event.type === "reasoning.appended" && event.data.reasoningSoFar.length > 0) {
      appendedByStep.set(event.data.stepIndex, event.data.reasoningSoFar);
    }
  }
  return [...appendedByStep.values()];
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

async function checkStep1Reports(t: EvalChecks, disk: Disk, root: string): Promise<void> {
  const reports = await readReports(disk, root);
  t.check(reports.keys, satisfies<string[]>((keys) => keys.some((reportKey) => reportKey.endsWith(".md")), "markdown report exists"));
  t.check(reports.keys, satisfies<string[]>((keys) => keys.some((reportKey) => reportKey.endsWith(".json")), "json report exists"));
  t.check(reports.text, includes("archil account review seed"));
  t.check(reports.text, includes("archil-account-review"));
  t.check(reports.text, includes("27.00"));
  t.check(reports.text, includes("29.75"));
  t.check(reports.text, includes(reviewMarker));
  t.check(reports.jsonText, includes(reviewMarker));
}

async function checkStep2Reports(t: EvalChecks, disk: Disk, root: string): Promise<void> {
  const reports = await readReports(disk, root);
  t.check(reports.text, includes(reviewMarker));
  t.check(reports.text, includes(followUpMarker));
  t.check(reports.keys, satisfies<string[]>((keys) => keys.length >= 3, "follow-up adds another report artifact"));
}

async function checkFreshSessionReport(t: EvalChecks, disk: Disk, root: string): Promise<void> {
  const reports = await readReports(disk, root);
  t.check(reports.text, includes(reviewMarker));
  t.check(reports.text, includes(followUpMarker));
  t.check(reports.text, includes(freshMarker));
}

async function readText(disk: Disk, objectKey: string): Promise<string> {
  return new TextDecoder().decode(await disk.getObject(objectKey));
}

async function readReports(disk: Disk, root: string): Promise<{ keys: string[]; text: string; jsonText: string }> {
  const listing = await disk.listObjects(`${root}/reports/`, { recursive: true });
  const entries = await Promise.all(
    listing.objects.map(async (object) => ({
      key: object.key,
      text: await readText(disk, object.key),
    })),
  );
  const jsonText = entries
    .filter((entry) => entry.key.endsWith(".json"))
    .map((entry) => JSON.stringify(JSON.parse(entry.text)))
    .join("\n");
  return {
    keys: entries.map((entry) => entry.key),
    text: entries.map((entry) => entry.text).join("\n"),
    jsonText,
  };
}

function key(root: string, path: string): string {
  return `${root}/${path.replace(/^\/+/, "")}`;
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}; @archildata/eve-e2e requires an Archil test disk.`);
  }
  return value;
}
