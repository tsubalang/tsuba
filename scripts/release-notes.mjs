#!/usr/bin/env node
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function runGit(root, args) {
  return execSync(`git ${args}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" }).trim();
}

function tryRunGit(root, args) {
  try {
    return runGit(root, args);
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const out = {
    from: undefined,
    to: "HEAD",
    repo: undefined,
    outPath: undefined,
    format: "markdown",
    offline: false,
    autoRange: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from") {
      out.from = argv[++i];
      continue;
    }
    if (arg === "--to") {
      out.to = argv[++i];
      continue;
    }
    if (arg === "--repo") {
      out.repo = argv[++i];
      continue;
    }
    if (arg === "--out") {
      out.outPath = argv[++i];
      continue;
    }
    if (arg === "--format") {
      out.format = argv[++i];
      continue;
    }
    if (arg === "--offline") {
      out.offline = true;
      continue;
    }
    if (arg === "--auto-range") {
      out.autoRange = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "Usage: node scripts/release-notes.mjs [--from <ref> | --auto-range] [--to <ref>] [--repo <owner/repo>] [--format markdown|json] [--out <path>] [--offline]",
          "",
          "Builds release notes from merged PRs in a commit range.",
          "- Uses merge commits to discover PR numbers.",
          "- Uses GitHub API labels when GITHUB_TOKEN is set and --offline is not used.",
          "- --auto-range resolves --from to the latest tag, or the root commit when no tags exist.",
          "",
        ].join("\n")
      );
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }
  if (out.from && out.autoRange) {
    throw new Error("--from and --auto-range cannot be used together");
  }
  if (out.format !== "markdown" && out.format !== "json") {
    throw new Error("--format must be markdown or json");
  }
  return out;
}

function inferAutoFromRef(root) {
  const tag = tryRunGit(root, "describe --tags --abbrev=0");
  if (tag && tag.length > 0) return tag;
  const roots = runGit(root, "rev-list --max-parents=0 HEAD")
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  if (roots.length === 0) {
    throw new Error("Unable to infer --from via --auto-range.");
  }
  return roots[0];
}

function inferRepoFromOrigin(root) {
  const remote = tryRunGit(root, "remote get-url origin");
  if (!remote) return undefined;
  const trimmed = remote.trim();
  const sshMatch = /^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/.exec(trimmed);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = /^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/.exec(trimmed);
  if (httpsMatch) return httpsMatch[1];
  return undefined;
}

function extractMergedPrRefs(root, fromRef, toRef) {
  const text = runGit(root, `log --merges --pretty=%H%x09%s ${fromRef}..${toRef}`);
  if (text.length === 0) return [];
  const out = [];
  for (const line of text.split(/\r?\n/g)) {
    if (!line.trim()) continue;
    const [sha, subject] = line.split("\t");
    if (!sha || !subject) continue;
    const match = /#([0-9]+)/.exec(subject);
    if (!match) continue;
    out.push({ sha, pr: Number.parseInt(match[1], 10), subject });
  }
  return out;
}

async function fetchPull(repo, prNumber, token) {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tsuba-release-notes-script",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for PR #${prNumber}`);
  }
  const body = await response.json();
  const labels = Array.isArray(body.labels)
    ? body.labels
        .map((x) => (typeof x?.name === "string" ? x.name.trim() : ""))
        .filter((x) => x.length > 0)
        .sort((a, b) => a.localeCompare(b))
    : [];
  return {
    number: prNumber,
    title: typeof body.title === "string" ? body.title : `PR #${prNumber}`,
    url: typeof body.html_url === "string" ? body.html_url : undefined,
    labels,
  };
}

function labelKey(pr) {
  if (!pr.labels || pr.labels.length === 0) return "unlabeled";
  return pr.labels[0];
}

function toMarkdown(report) {
  const lines = [];
  lines.push(`# Release Notes (${report.from}..${report.to})`);
  lines.push("");
  if (report.pulls.length === 0) {
    lines.push("_No merged pull requests found in this range._");
    lines.push("");
    return lines.join("\n");
  }
  for (const section of report.sections) {
    lines.push(`## ${section.label}`);
    for (const pr of section.items) {
      const suffix = pr.url ? ` (${pr.url})` : "";
      lines.push(`- #${pr.number} ${pr.title}${suffix}`);
    }
    lines.push("");
  }
  if (report.warnings.length > 0) {
    lines.push("## Warnings");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const here = fileURLToPath(import.meta.url);
  const root = resolve(join(dirname(here), ".."));
  const args = parseArgs(process.argv.slice(2));
  const fromRef = args.from ?? (args.autoRange ? inferAutoFromRef(root) : undefined);
  if (!fromRef) {
    throw new Error("--from is required (or pass --auto-range)");
  }

  const repo = args.repo ?? inferRepoFromOrigin(root);
  const refs = extractMergedPrRefs(root, fromRef, args.to);
  const warnings = [];
  const token = process.env.GITHUB_TOKEN;

  const pulls = [];
  if (!args.offline && token && repo) {
    for (const ref of refs) {
      try {
        const pr = await fetchPull(repo, ref.pr, token);
        pulls.push(pr);
      } catch (error) {
        warnings.push(`Failed to fetch PR #${ref.pr} labels: ${String(error)}`);
        pulls.push({
          number: ref.pr,
          title: ref.subject,
          url: undefined,
          labels: [],
        });
      }
    }
  } else {
    if (!args.offline && !token) warnings.push("GITHUB_TOKEN is not set; falling back to merge subjects without labels.");
    if (!args.offline && !repo) warnings.push("Could not infer GitHub repo; falling back to merge subjects without labels.");
    for (const ref of refs) {
      pulls.push({
        number: ref.pr,
        title: ref.subject,
        url: undefined,
        labels: [],
      });
    }
  }

  const sectionMap = new Map();
  for (const pr of pulls) {
    const key = labelKey(pr);
    const list = sectionMap.get(key) ?? [];
    list.push(pr);
    sectionMap.set(key, list);
  }
  const sections = [...sectionMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, items]) => ({
      label,
      items: items.sort((x, y) => x.number - y.number),
    }));

  const report = {
    schema: 1,
    kind: "release-notes",
    from: fromRef,
    to: args.to,
    repo,
    pulls,
    sections,
    warnings,
  };

  const output =
    args.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${toMarkdown(report)}${args.format === "markdown" ? "\n" : ""}`;

  if (args.outPath) {
    writeFileSync(resolve(args.outPath), output, "utf-8");
  } else {
    process.stdout.write(output);
  }
}

main().catch((error) => {
  process.stderr.write(`release-notes: ${String(error)}\n`);
  process.exit(1);
});
