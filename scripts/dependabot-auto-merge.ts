import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface WorkflowRun {
  id: number;
  path: string;
  event: string;
  head_repository: { full_name: string } | null;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  head_sha: string;
  pull_requests: { number: number }[] | null;
}

interface PullRequest {
  number: number;
  user: { login: string; type: string };
  state: string;
  draft: boolean;
  base: { ref: string; repo: { full_name: string } };
  head: { sha: string; repo: { full_name: string } | null };
}

interface Job { name: string; conclusion: string | null }

interface GitHubApi {
  getWorkflowRun(id: number): Promise<WorkflowRun>;
  getJobs(id: number, attempt: number): Promise<Job[]>;
  getPull(number: number): Promise<PullRequest>;
  mergePull(number: number, sha: string): Promise<{ merged: boolean }>;
  dispatchPages(): Promise<void>;
}

export function createGitHubApi(repository: string, token: string, baseUrl = "https://api.github.com", fetcher = fetch): GitHubApi {
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
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  return {
    getWorkflowRun: id => request("GET", `actions/runs/${id}`),
    async getJobs(id, attempt) {
      const jobs: Job[] = [];
      for (let page = 1; ; page++) {
        const data = await request<{ jobs: Job[] }>("GET", `actions/runs/${id}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
        jobs.push(...data.jobs);
        if (data.jobs.length < 100) return jobs;
      }
    },
    getPull: number => request("GET", `pulls/${number}`),
    mergePull: (number, sha) => request("PUT", `pulls/${number}/merge`, { sha, merge_method: "merge" }),
    dispatchPages: () => request("POST", "actions/workflows/deploy-pages.yml/dispatches", { ref: "main" }),
  };
}

export async function autoMerge({ api, repository, completed, log = console.log }: {
  api: GitHubApi;
  repository: string;
  completed: { id: number; run_attempt: number };
  log?: (message: string) => void;
}) {
  const run = await api.getWorkflowRun(completed.id);
  // 古い成功イベントや、CIと同名の別ワークフローではマージしない。
  if (run.path !== ".github/workflows/ci.yml" || run.event !== "pull_request" ||
      run.head_repository?.full_name !== repository ||
      run.status !== "completed" || run.conclusion !== "success" ||
      run.run_attempt !== completed.run_attempt) {
    log("Current CI run is not eligible for auto-merge.");
    return;
  }
  const jobs = await api.getJobs(run.id, run.run_attempt);
  if (!jobs.some(job => job.name === "check" && job.conclusion === "success")) {
    log("CI check job did not succeed.");
    return;
  }
  for (const candidate of run.pull_requests ?? []) {
    const pull = await api.getPull(candidate.number);
    if (pull.user.login !== "dependabot[bot]" || pull.user.type !== "Bot" ||
        pull.state !== "open" || pull.draft || pull.base.ref !== "main" ||
        pull.base.repo.full_name !== repository ||
        pull.head.repo?.full_name !== repository || pull.head.sha !== run.head_sha) {
      log(`PR #${pull.number} is not eligible for auto-merge.`);
      continue;
    }
    // 検証後のPR更新はSHA指定で拒否し、ブランチ保護もGitHub側で適用する。
    const result = await api.mergePull(pull.number, pull.head.sha);
    if (!result.merged) throw new Error(`PR #${pull.number} was not merged.`);
    // GITHUB_TOKENによるマージではpushワークフローが起動しない。
    await api.dispatchPages();
    log(`Merged Dependabot PR #${pull.number} and requested Pages deployment.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GH_TOKEN, GITHUB_API_URL } = process.env;
    if (!GITHUB_REPOSITORY || !GITHUB_EVENT_PATH || !GH_TOKEN) {
      throw new Error("GITHUB_REPOSITORY, GITHUB_EVENT_PATH and GH_TOKEN are required.");
    }
    const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8"));
    await autoMerge({
      api: createGitHubApi(GITHUB_REPOSITORY, GH_TOKEN, GITHUB_API_URL),
      repository: GITHUB_REPOSITORY,
      completed: event.workflow_run,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Dependabot auto-merge failed.");
    process.exitCode = 1;
  }
}
