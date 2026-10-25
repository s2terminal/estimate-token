import { describe, expect, it, vi } from "vitest";

import { autoMerge, createGitHubApi } from "../../scripts/dependabot-auto-merge.ts";

const repository = "s2terminal/estimate-token";

function scenario() {
  const run = {
    id: 123,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_repository: { full_name: repository },
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    head_sha: "tested-commit",
    pull_requests: [{ number: 42 }],
  };
  const pull = {
    number: 42,
    user: { login: "dependabot[bot]", type: "Bot" },
    state: "open",
    draft: false,
    base: { ref: "main", repo: { full_name: repository } },
    head: { sha: "tested-commit", repo: { full_name: repository } },
  };
  const jobs = [{ name: "check", conclusion: "success" }];
  const merge = vi.fn().mockResolvedValue({ merged: true });
  const dispatch = vi.fn().mockResolvedValue({});
  const api = {
    getWorkflowRun: vi.fn().mockResolvedValue(run),
    getJobs: vi.fn().mockResolvedValue(jobs),
    getPull: vi.fn().mockResolvedValue(pull),
    mergePull: merge,
    dispatchPages: dispatch,
  };
  const completed = { id: run.id, run_attempt: run.run_attempt };
  return {
    run, pull, jobs, merge, dispatch,
    execute: () => autoMerge({ api, repository, completed, log: vi.fn() }),
  };
}

describe("Dependabot auto-merge", () => {
  it("merges the tested Dependabot commit before requesting Pages deployment", async () => {
    const s = scenario();
    await s.execute();
    expect(s.merge).toHaveBeenCalledExactlyOnceWith(42, "tested-commit");
    expect(s.dispatch).toHaveBeenCalledExactlyOnceWith();
    expect(s.merge.mock.invocationCallOrder[0]).toBeLessThan(s.dispatch.mock.invocationCallOrder[0]);
  });

  it.each([
    ["human author", (s: ReturnType<typeof scenario>) => { s.pull.user.login = "s2terminal"; }],
    ["non-bot author", (s: ReturnType<typeof scenario>) => { s.pull.user.type = "User"; }],
    ["draft PR", (s: ReturnType<typeof scenario>) => { s.pull.draft = true; }],
    ["closed PR", (s: ReturnType<typeof scenario>) => { s.pull.state = "closed"; }],
    ["different base", (s: ReturnType<typeof scenario>) => { s.pull.base.ref = "release"; }],
    ["different base repository", (s: ReturnType<typeof scenario>) => { s.pull.base.repo.full_name = "other/repo"; }],
    ["fork PR", (s: ReturnType<typeof scenario>) => { s.pull.head.repo.full_name = "other/repo"; }],
    ["updated PR", (s: ReturnType<typeof scenario>) => { s.pull.head.sha = "new-commit"; }],
    ["failed CI", (s: ReturnType<typeof scenario>) => { s.run.conclusion = "failure"; }],
    ["running CI rerun", (s: ReturnType<typeof scenario>) => { s.run.status = "in_progress"; }],
    ["newer CI rerun", (s: ReturnType<typeof scenario>) => { s.run.run_attempt = 2; }],
    ["different workflow", (s: ReturnType<typeof scenario>) => { s.run.path = ".github/workflows/other.yml"; }],
    ["push CI", (s: ReturnType<typeof scenario>) => { s.run.event = "push"; }],
    ["fork CI", (s: ReturnType<typeof scenario>) => { s.run.head_repository.full_name = "other/repo"; }],
    ["skipped checks", (s: ReturnType<typeof scenario>) => { s.jobs[0].conclusion = "skipped"; }],
    ["missing checks", (s: ReturnType<typeof scenario>) => { s.jobs.length = 0; }],
    ["no associated PR", (s: ReturnType<typeof scenario>) => { s.run.pull_requests = []; }],
  ])("does not merge or deploy: %s", async (_name, change) => {
    const s = scenario();
    change(s);
    await s.execute();
    expect(s.merge).not.toHaveBeenCalled();
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it("does not deploy when GitHub refuses the merge", async () => {
    const s = scenario();
    s.merge.mockResolvedValue({ merged: false });
    await expect(s.execute()).rejects.toThrow("was not merged");
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it("does not deploy when the merge fails because the PR changed or protection blocks it", async () => {
    const s = scenario();
    s.merge.mockRejectedValue(new Error("Head SHA changed or branch protection failed"));
    await expect(s.execute()).rejects.toThrow("Head SHA changed or branch protection failed");
    expect(s.dispatch).not.toHaveBeenCalled();
  });
});

describe("GitHub API client", () => {
  it("sends the tested SHA on merge and dispatches Pages without dependencies", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ merged: true })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createGitHubApi(repository, "test-token", "https://api.github.com", fetcher);
    await expect(api.mergePull(42, "tested-commit")).resolves.toEqual({ merged: true });
    await expect(api.dispatchPages()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenNthCalledWith(1, `https://api.github.com/repos/${repository}/pulls/42/merge`, {
      method: "PUT",
      headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      body: JSON.stringify({ sha: "tested-commit", merge_method: "merge" }),
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, `https://api.github.com/repos/${repository}/actions/workflows/deploy-pages.yml/dispatches`, {
      method: "POST",
      headers: expect.any(Object),
      body: JSON.stringify({ ref: "main" }),
    });
  });

  it("reads every page of jobs for the specified CI attempt", async () => {
    const skipped = Array.from({ length: 100 }, () => ({ name: "other", conclusion: "skipped" }));
    const check = { name: "check", conclusion: "success" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: skipped })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [check] })));
    const api = createGitHubApi(repository, "test-token", "https://api.github.com", fetcher);
    await expect(api.getJobs(123, 2)).resolves.toEqual([...skipped, check]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `https://api.github.com/repos/${repository}/actions/runs/123/attempts/2/jobs?per_page=100&page=1`,
      `https://api.github.com/repos/${repository}/actions/runs/123/attempts/2/jobs?per_page=100&page=2`,
    ]);
  });

  it("stops on API errors without exposing the token or response body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private error details", { status: 403 }));
    const api = createGitHubApi(repository, "test-token", "https://api.github.com", fetcher);
    await expect(api.getWorkflowRun(123)).rejects.toThrow(/^GitHub API GET actions\/runs\/123 failed \(403\)\.$/);
  });
});
