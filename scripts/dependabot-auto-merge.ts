import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface Pull {
  number: number;
  user: { login: string; type: string };
  state: string;
  draft: boolean;
  base: { ref: string; repo: { full_name: string } };
  head: { sha: string; repo: { full_name: string } | null };
}

interface Run {
  id: number;
  path: string;
  event: string;
  head_sha: string;
  head_repository: { full_name: string } | null;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  pull_requests: { number: number }[];
}

interface Job { name: string; conclusion: string | null }

export interface Receipt {
  headSha: string;
  runId: number;
  attempt: number;
}

export interface ReadApi {
  getPull(number: number): Promise<Pull>;
  listCiRuns(sha: string): Promise<Run[]>;
  getRun(id: number): Promise<Run>;
  getJobs(id: number, attempt: number): Promise<Job[]>;
  getFiles(number: number): Promise<string[]>;
}

export function createApi(repository: string, token: string, baseUrl = "https://api.github.com", fetcher = fetch) {
  const root = `${baseUrl}/repos/${repository}`;
  async function request<T>(method: string, path: string, body?: object): Promise<T> {
    const response = await fetcher(`${root}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed (${response.status}).`);
    return await response.json() as T;
  }
  async function pages<T>(path: string, items: (data: unknown) => T[]): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page++) {
      const batch = items(await request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }
  return {
    getPull: (number: number) => request<Pull>("GET", `pulls/${number}`),
    listCiRuns: (sha: string) => pages<Run>(
      `actions/workflows/ci.yml/runs?event=pull_request&head_sha=${encodeURIComponent(sha)}`,
      data => (data as { workflow_runs: Run[] }).workflow_runs,
    ),
    getRun: (id: number) => request<Run>("GET", `actions/runs/${id}`),
    getJobs: (id: number, attempt: number) => pages<Job>(
      `actions/runs/${id}/attempts/${attempt}/jobs`, data => (data as { jobs: Job[] }).jobs,
    ),
    getFiles: async (number: number) => (await pages<{ filename: string }>(
      `pulls/${number}/files`, data => data as { filename: string }[],
    )).map(file => file.filename),
    mergePull: (number: number, sha: string) => request<{ merged: boolean }>(
      "PUT", `pulls/${number}/merge`, { sha, merge_method: "merge" },
    ),
  };
}

function assertPull(pull: Pull, repository: string, headSha: string) {
  if (pull.user.login !== "dependabot[bot]" || pull.user.type !== "Bot" ||
      pull.state !== "open" || pull.draft || pull.base.ref !== "main" ||
      pull.base.repo.full_name !== repository || pull.head.repo?.full_name !== repository ||
      pull.head.sha !== headSha) {
    throw new Error("PR author, state, base, repository or head SHA changed; refusing to merge.");
  }
}

function matchesRun(run: Run, repository: string, number: number, headSha: string) {
  return run.path === ".github/workflows/ci.yml" && run.event === "pull_request" &&
    run.head_repository?.full_name === repository && run.head_sha === headSha &&
    run.pull_requests.some(pull => pull.number === number);
}

function latestRun(runs: Run[], repository: string, number: number, headSha: string) {
  const latest = runs.filter(run => run.path === ".github/workflows/ci.yml" && run.event === "pull_request" &&
    run.head_repository?.full_name === repository && run.head_sha === headSha).sort((a, b) => b.id - a.id)[0];
  return latest && matchesRun(latest, repository, number, headSha) ? latest : undefined;
}

async function assertSuccessfulCi(api: ReadApi, run: Run) {
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("Current CI run has not succeeded; refusing to merge.");
  }
  const jobs = await api.getJobs(run.id, run.run_attempt);
  if (!jobs.some(job => job.name === "check" && job.conclusion === "success")) {
    throw new Error("CI check job is missing, failed or skipped; refusing to merge.");
  }
}

// This runs with a read-only token and never checks out or executes PR code.
export async function waitForCi(api: ReadApi, repository: string, number: number, headSha: string, {
  now = Date.now,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  timeoutMs = 20 * 60 * 1000,
  log = console.log,
} = {}): Promise<Receipt> {
  const deadline = now() + timeoutMs;
  while (true) {
    assertPull(await api.getPull(number), repository, headSha);
    const run = latestRun(await api.listCiRuns(headSha), repository, number, headSha);
    if (run?.status === "completed") {
      await assertSuccessfulCi(api, run);
      return { headSha, runId: run.id, attempt: run.run_attempt };
    }
    if (now() >= deadline) throw new Error("Timed out waiting for the matching CI run; refusing to merge.");
    log(`Waiting for CI of PR #${number} at ${headSha}.`);
    await sleep(15_000);
  }
}

// Called in a separate job. Only the final merge request uses a write token.
export async function mergeAfterCi(api: ReadApi, repository: string, number: number, receipt: Receipt,
  merge: (number: number, sha: string) => Promise<{ merged: boolean }>,
) {
  assertPull(await api.getPull(number), repository, receipt.headSha);
  const files = await api.getFiles(number);
  if (files.length === 0 || files.some(file => !["package.json", "package-lock.json"].includes(file))) {
    throw new Error("PR changes files outside the root npm manifests; refusing to merge.");
  }
  const latest = latestRun(await api.listCiRuns(receipt.headSha), repository, number, receipt.headSha);
  const run = await api.getRun(receipt.runId);
  if (!latest || latest.id !== receipt.runId || latest.run_attempt !== receipt.attempt ||
      latest.status !== "completed" || latest.conclusion !== "success" ||
      !matchesRun(run, repository, number, receipt.headSha) ||
      run.run_attempt !== receipt.attempt) {
    throw new Error("CI run or attempt changed after verification; refusing to merge.");
  }
  await assertSuccessfulCi(api, run);
  const result = await merge(number, receipt.headSha);
  if (!result.merged) throw new Error("GitHub refused to merge the verified commit.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL, GH_TOKEN, MERGE_TOKEN, GITHUB_OUTPUT } = process.env;
    if (!GITHUB_REPOSITORY || !GITHUB_EVENT_PATH || !GH_TOKEN) {
      throw new Error("GITHUB_REPOSITORY, GITHUB_EVENT_PATH and GH_TOKEN are required.");
    }
    const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8"));
    const pull = event.pull_request as Pull;
    const api = createApi(GITHUB_REPOSITORY, GH_TOKEN, GITHUB_API_URL);
    if (process.argv[2] === "wait") {
      if (!GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
      const receipt = await waitForCi(api, GITHUB_REPOSITORY, pull.number, pull.head.sha);
      appendFileSync(GITHUB_OUTPUT, `head-sha=${receipt.headSha}\nci-run-id=${receipt.runId}\nci-run-attempt=${receipt.attempt}\n`);
    } else if (process.argv[2] === "merge") {
      if (!MERGE_TOKEN) throw new Error("MERGE_TOKEN is required.");
      const receipt = {
        headSha: process.env.TESTED_HEAD_SHA ?? "",
        runId: Number(process.env.CI_RUN_ID),
        attempt: Number(process.env.CI_RUN_ATTEMPT),
      };
      if (receipt.headSha !== pull.head.sha || !Number.isSafeInteger(receipt.runId) || receipt.runId <= 0 ||
          !Number.isSafeInteger(receipt.attempt) || receipt.attempt <= 0) {
        throw new Error("Missing or inconsistent CI verification receipt.");
      }
      await mergeAfterCi(api, GITHUB_REPOSITORY, pull.number, receipt,
        createApi(GITHUB_REPOSITORY, MERGE_TOKEN, GITHUB_API_URL).mergePull);
      console.log(`Merged Dependabot PR #${pull.number} at ${receipt.headSha}.`);
    } else {
      throw new Error("Usage: node scripts/dependabot-auto-merge.ts wait|merge");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Dependabot merge failed.");
    process.exitCode = 1;
  }
}
