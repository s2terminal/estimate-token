import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

const workflow = parse(readFileSync(".github/workflows/dependabot-auto-merge.yml", "utf8"));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const execute = new AsyncFunction("github", "context", "core", workflow.jobs.merge.steps[0].with.script);
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
  const merge = vi.fn().mockResolvedValue({ data: { merged: true } });
  const dispatch = vi.fn().mockResolvedValue({});
  const github = {
    rest: {
      actions: {
        getWorkflowRun: vi.fn().mockResolvedValue({ data: run }),
        listJobsForWorkflowRunAttempt: vi.fn(),
        createWorkflowDispatch: dispatch,
      },
      pulls: { get: vi.fn().mockResolvedValue({ data: pull }), merge },
    },
    paginate: vi.fn().mockResolvedValue(jobs),
  };
  const context = {
    repo: { owner: "s2terminal", repo: "estimate-token" },
    payload: { workflow_run: { id: run.id, run_attempt: run.run_attempt } },
  };
  return {
    run, pull, jobs, github, context, merge, dispatch,
    execute: () => execute(github, context, { info: vi.fn(), notice: vi.fn() }),
  };
}

describe("Dependabot auto-merge", () => {
  it("merges the tested Dependabot commit before requesting Pages deployment", async () => {
    const s = scenario();
    await s.execute();
    expect(s.merge).toHaveBeenCalledExactlyOnceWith({
      owner: "s2terminal", repo: "estimate-token", pull_number: 42,
      sha: "tested-commit", merge_method: "merge",
    });
    expect(s.dispatch).toHaveBeenCalledExactlyOnceWith({
      owner: "s2terminal", repo: "estimate-token", workflow_id: "deploy-pages.yml", ref: "main",
    });
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
    s.merge.mockResolvedValue({ data: { merged: false } });
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
