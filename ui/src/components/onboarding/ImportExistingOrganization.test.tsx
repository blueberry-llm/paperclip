// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanyPortabilityPreviewResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImportExistingOrganization,
  type ImportedOrganization,
} from "./ImportExistingOrganization";

const mockCompaniesApi = vi.hoisted(() => ({
  importPreview: vi.fn(),
  importPreviewPackage: vi.fn(),
  importBundleAsync: vi.fn(),
  importBundlePackageAsync: vi.fn(),
  getImportJob: vi.fn(),
  get: vi.fn(),
}));

vi.mock("../../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

// The real poll loop waits 3s between job status reads. Tests drive one instant
// tick instead so a settled job resolves without a timer.
vi.mock("../../lib/import-job-watch", () => ({
  waitForNextImportJobPoll: vi.fn(async () => {}),
}));

function preview(plan: { agents: number; projects: number; issues: number }): CompanyPortabilityPreviewResult {
  return {
    include: { company: true, agents: true, projects: true, issues: true },
    targetCompanyId: null,
    targetCompanyName: "Acme",
    collisionStrategy: "skip",
    selectedAgentSlugs: [],
    plan: {
      companyAction: "create",
      agentPlans: Array.from({ length: plan.agents }, () => ({} as never)),
      projectPlans: Array.from({ length: plan.projects }, () => ({} as never)),
      issuePlans: Array.from({ length: plan.issues }, () => ({} as never)),
    },
    manifest: {} as never,
    files: {},
    envInputs: [],
    warnings: [],
    errors: [],
  } as unknown as CompanyPortabilityPreviewResult;
}

let container: HTMLDivElement;
let root: Root;
let imported: ImportedOrganization[];

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function press(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith(label),
  );
  if (!button) throw new Error(`missing button: ${label}`);
  await act(async () => {
    button.click();
  });
}

/**
 * React tracks the previous value of a controlled input, so assigning `.value`
 * and dispatching is swallowed. Go through the prototype setter to make the
 * change look like a user edit.
 */
async function typeInto(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`missing input: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  imported = [];
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ImportExistingOrganization
        onImported={(value) => {
          imported.push(value);
        }}
      />,
    );
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("ImportExistingOrganization", () => {
  it("requires a source before previewing", async () => {
    await press("Check package");
    await settle();
    expect(mockCompaniesApi.importPreviewPackage).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Choose a Paperclip package");
  });

  it("previews a zip package and reports the plan counts", async () => {
    mockCompaniesApi.importPreviewPackage.mockResolvedValue(preview({ agents: 2, projects: 1, issues: 5 }));
    const input = container.querySelector<HTMLInputElement>("#onboarding-import-package")!;
    await act(async () => {
      const file = new File(["zip"], "acme.zip", { type: "application/zip" });
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await press("Check package");
    await settle();
    expect(mockCompaniesApi.importPreviewPackage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Ready to import");
    expect(container.textContent).toContain("2 agents");
    expect(container.textContent).toContain("5 issues");
  });

  it("applies a GitHub source as a new organization and reports the created company", async () => {
    mockCompaniesApi.importPreview.mockResolvedValue(preview({ agents: 1, projects: 0, issues: 0 }));
    mockCompaniesApi.importBundleAsync.mockResolvedValue({ job: { id: "job-1", status: "running" } });
    mockCompaniesApi.getImportJob.mockResolvedValue({
      job: { id: "job-1", status: "succeeded", result: { companyId: "co-1" } },
    });
    mockCompaniesApi.get.mockResolvedValue({ id: "co-1", name: "Acme", issuePrefix: "AC" });

    await press("From GitHub");
    await typeInto("#onboarding-import-github", "https://github.com/acme/paperclip-company");
    await press("Check package");
    await settle();
    expect(mockCompaniesApi.importPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { type: "github", url: "https://github.com/acme/paperclip-company" },
        target: { mode: "new_company", newCompanyName: null },
      }),
    );

    await press("Import organization");
    await settle();

    expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { type: "github", url: "https://github.com/acme/paperclip-company" },
      }),
    );
    expect(imported).toEqual([{ companyId: "co-1", issuePrefix: "AC", name: "Acme" }]);
  });

  it("surfaces a failed import job instead of reporting an organization", async () => {
    mockCompaniesApi.importPreview.mockResolvedValue(preview({ agents: 0, projects: 0, issues: 0 }));
    mockCompaniesApi.importBundleAsync.mockResolvedValue({ job: { id: "job-2", status: "running" } });
    mockCompaniesApi.getImportJob.mockResolvedValue({
      job: { id: "job-2", status: "failed", error: { message: "package is truncated" } },
    });

    await press("From GitHub");
    await typeInto("#onboarding-import-github", "https://github.com/acme/broken");
    await press("Check package");
    await settle();
    await press("Import organization");
    await settle();

    expect(imported).toEqual([]);
    expect(container.textContent).toContain("package is truncated");
  });
});