import { describe, expect, it, vi } from "vitest";
import { createApi, mergeAfterCi, waitForCi } from "../../scripts/dependabot-auto-merge.ts";

const repository = "s2terminal/estimate-token";
const receipt = { headSha: "tested-commit", runId: 123, attempt: 1 };

function scenario() {
  const pull = {
    number: 42,
    user: { login: "dependabot[bot]", type: "Bot" },
    state: "open", draft: false,
    base: { ref: "main", repo: { full_name: repository } },
    head: { sha: receipt.headSha, repo: { full_name: repository } },
  };
  const run = {
    id: 123, path: ".github/workflows/ci.yml", event: "pull_request",
    head_sha: receipt.headSha, head_repository: { full_name: repository },
    status: "completed", conclusion: "success", run_attempt: 1,
    pull_requests: [{ number: 42 }],
  };
  const jobs = [{ name: "check", conclusion: "success" }];
  const files = ["package.json", "package-lock.json"];
  const api = {
    getPull: vi.fn().mockResolvedValue(pull),
    listCiRuns: vi.fn().mockResolvedValue([run]),
    getRun: vi.fn().mockResolvedValue(run),
    getJobs: vi.fn().mockResolvedValue(jobs),
    getFiles: vi.fn().mockResolvedValue(files),
  };
  const merge = vi.fn().mockResolvedValue({ merged: true });
  return { pull, run, jobs, files, api, merge };
}

describe("read-only CI verification", () => {
  it("returns the successful CI run and attempt for the exact Dependabot commit", async () => {
    const s = scenario();
    await expect(waitForCi(s.api, repository, 42, receipt.headSha)).resolves.toEqual(receipt);
    expect(s.api.getJobs).toHaveBeenCalledExactlyOnceWith(123, 1);
    expect(s.merge).not.toHaveBeenCalled();
  });

  it("waits for CI to appear and finish without merging", async () => {
    const s = scenario();
    s.api.listCiRuns.mockResolvedValueOnce([]);
    s.run.status = "in_progress";
    s.run.conclusion = "";
    let polls = 0;
    const sleep = vi.fn(async () => {
      if (++polls === 2) { s.run.status = "completed"; s.run.conclusion = "success"; }
    });
    await expect(waitForCi(s.api, repository, 42, receipt.headSha, { sleep, log: vi.fn() })).resolves.toEqual(receipt);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(s.merge).not.toHaveBeenCalled();
  });

  it.each(["failure", "cancelled", "skipped", "neutral", "timed_out"])("rejects CI conclusion %s", async conclusion => {
    const s = scenario();
    s.run.conclusion = conclusion;
    await expect(waitForCi(s.api, repository, 42, receipt.headSha)).rejects.toThrow("has not succeeded");
  });

  it.each(["skipped", "failure"])("rejects a %s check job even if the workflow reports success", async conclusion => {
    const s = scenario();
    s.jobs[0].conclusion = conclusion;
    await expect(waitForCi(s.api, repository, 42, receipt.headSha)).rejects.toThrow("check job");
  });

  it.each([
    ["unrelated SHA", (s: ReturnType<typeof scenario>) => { s.run.head_sha = "other-commit"; }],
    ["unrelated workflow", (s: ReturnType<typeof scenario>) => { s.run.path = ".github/workflows/other.yml"; }],
    ["push run", (s: ReturnType<typeof scenario>) => { s.run.event = "push"; }],
    ["fork run", (s: ReturnType<typeof scenario>) => { s.run.head_repository.full_name = "other/repo"; }],
    ["unrelated PR", (s: ReturnType<typeof scenario>) => { s.run.pull_requests = [{ number: 43 }]; }],
  ])("does not accept %s as evidence of CI success", async (_label, change) => {
    const s = scenario();
    change(s);
    await expect(waitForCi(s.api, repository, 42, receipt.headSha, { timeoutMs: 0 })).rejects.toThrow("Timed out");
  });

  it("does not use an older green run while a newer run is still running", async () => {
    const s = scenario();
    s.api.listCiRuns.mockResolvedValue([s.run, { ...s.run, id: 124, status: "in_progress" }]);
    await expect(waitForCi(s.api, repository, 42, receipt.headSha, { timeoutMs: 0 })).rejects.toThrow("Timed out");
  });

  it("does not fall back to old success while the latest run has no PR association", async () => {
    const s = scenario();
    s.api.listCiRuns.mockResolvedValue([s.run, { ...s.run, id: 124, pull_requests: [] }]);
    await expect(waitForCi(s.api, repository, 42, receipt.headSha, { timeoutMs: 0 })).rejects.toThrow("Timed out");
  });

  it("stops if the PR changes while CI is running", async () => {
    const s = scenario();
    s.run.status = "in_progress";
    const sleep = vi.fn(async () => { s.pull.head.sha = "new-commit"; });
    await expect(waitForCi(s.api, repository, 42, receipt.headSha, { sleep, log: vi.fn() })).rejects.toThrow("head SHA changed");
  });
});

describe("merge after CI", () => {
  it("rechecks the PR, files and current CI before submitting a SHA-guarded merge", async () => {
    const s = scenario();
    await mergeAfterCi(s.api, repository, 42, receipt, s.merge);
    expect(s.merge).toHaveBeenCalledExactlyOnceWith(42, receipt.headSha);
    expect(s.api.getJobs.mock.invocationCallOrder[0]).toBeLessThan(s.merge.mock.invocationCallOrder[0]);
  });

  it.each([
    ["human PR", (s: ReturnType<typeof scenario>) => { s.pull.user.login = "s2terminal"; }],
    ["daily update PR", (s: ReturnType<typeof scenario>) => { s.pull.user.login = "github-actions[bot]"; }],
    ["non-bot author", (s: ReturnType<typeof scenario>) => { s.pull.user.type = "User"; }],
    ["draft PR", (s: ReturnType<typeof scenario>) => { s.pull.draft = true; }],
    ["closed PR", (s: ReturnType<typeof scenario>) => { s.pull.state = "closed"; }],
    ["different base branch", (s: ReturnType<typeof scenario>) => { s.pull.base.ref = "release"; }],
    ["different base repository", (s: ReturnType<typeof scenario>) => { s.pull.base.repo.full_name = "other/repo"; }],
    ["fork PR", (s: ReturnType<typeof scenario>) => { s.pull.head.repo.full_name = "other/repo"; }],
    ["changed PR SHA", (s: ReturnType<typeof scenario>) => { s.pull.head.sha = "new-commit"; }],
    ["workflow file changes", (s: ReturnType<typeof scenario>) => { s.files.push(".github/workflows/ci.yml"); }],
    ["application code changes", (s: ReturnType<typeof scenario>) => { s.files.push("src/main.ts"); }],
    ["no changed files", (s: ReturnType<typeof scenario>) => { s.files.length = 0; }],
    ["failed CI", (s: ReturnType<typeof scenario>) => { s.run.conclusion = "failure"; }],
    ["running CI", (s: ReturnType<typeof scenario>) => { s.run.status = "in_progress"; }],
    ["new CI attempt", (s: ReturnType<typeof scenario>) => { s.run.run_attempt = 2; }],
    ["new CI run", (s: ReturnType<typeof scenario>) => { s.api.listCiRuns.mockResolvedValue([{ ...s.run, id: 124 }]); }],
    ["new attempt reported by the run list", (s: ReturnType<typeof scenario>) => { s.api.listCiRuns.mockResolvedValue([{ ...s.run, run_attempt: 2 }]); }],
    ["running rerun reported by the run list", (s: ReturnType<typeof scenario>) => { s.api.listCiRuns.mockResolvedValue([{ ...s.run, status: "in_progress" }]); }],
    ["failed rerun reported by the run list", (s: ReturnType<typeof scenario>) => { s.api.listCiRuns.mockResolvedValue([{ ...s.run, conclusion: "failure" }]); }],
    ["unrelated CI SHA", (s: ReturnType<typeof scenario>) => { s.run.head_sha = "other-commit"; }],
    ["skipped check job", (s: ReturnType<typeof scenario>) => { s.jobs[0].conclusion = "skipped"; }],
    ["missing check job", (s: ReturnType<typeof scenario>) => { s.jobs.length = 0; }],
  ])("never merges: %s", async (_label, change) => {
    const s = scenario();
    change(s);
    await expect(mergeAfterCi(s.api, repository, 42, receipt, s.merge)).rejects.toThrow();
    expect(s.merge).not.toHaveBeenCalled();
  });

  it("propagates an API refusal if the SHA changes during the merge request", async () => {
    const s = scenario();
    s.merge.mockRejectedValue(new Error("Head SHA changed"));
    await expect(mergeAfterCi(s.api, repository, 42, receipt, s.merge)).rejects.toThrow("Head SHA changed");
  });

  it("does not report a refused merge as successful", async () => {
    const s = scenario();
    s.merge.mockResolvedValue({ merged: false });
    await expect(mergeAfterCi(s.api, repository, 42, receipt, s.merge)).rejects.toThrow("GitHub refused");
  });
});

describe("GitHub API client", () => {
  it("submits the tested SHA to the direct merge endpoint without auto-merge", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ merged: true })));
    await createApi(repository, "write-token", undefined, fetcher).mergePull(42, receipt.headSha);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://api.github.com/repos/${repository}/pulls/42/merge`, {
      method: "PUT", headers: expect.objectContaining({ Authorization: "Bearer write-token" }),
      body: JSON.stringify({ sha: receipt.headSha, merge_method: "merge" }),
    });
  });

  it("paginates jobs for the exact CI attempt", async () => {
    const first = Array.from({ length: 100 }, () => ({ name: "other", conclusion: "skipped" }));
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: first })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{ name: "check", conclusion: "success" }] })));
    await expect(createApi(repository, "read-token", undefined, fetcher).getJobs(123, 2)).resolves.toHaveLength(101);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `https://api.github.com/repos/${repository}/actions/runs/123/attempts/2/jobs?per_page=100&page=1`,
      `https://api.github.com/repos/${repository}/actions/runs/123/attempts/2/jobs?per_page=100&page=2`,
    ]);
  });

  it("does not expose credentials or response bodies on API failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive error details", { status: 403 }));
    await expect(createApi(repository, "read-token", undefined, fetcher).getPull(42))
      .rejects.toThrow(/^GitHub API GET pulls\/42 failed \(403\)\.$/);
  });

  it("includes file changes beyond the first page so they cannot bypass the manifest allowlist", async () => {
    const first = Array.from({ length: 100 }, () => ({ filename: "package-lock.json" }));
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(first)))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ filename: ".github/workflows/ci.yml" }])));
    const files = await createApi(repository, "read-token", undefined, fetcher).getFiles(42);
    expect(files).toHaveLength(101);
    expect(files.at(-1)).toBe(".github/workflows/ci.yml");
    expect(fetcher.mock.calls[1][0]).toBe(`https://api.github.com/repos/${repository}/pulls/42/files?per_page=100&page=2`);
  });
});
