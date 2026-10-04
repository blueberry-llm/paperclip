import { useRef, useState } from "react";
import type { Company, CompanyPortabilityPreviewResult } from "@paperclipai/shared";
import { AlertTriangle, FileUp, Upload } from "lucide-react";
import { GithubIcon } from "../icons/github-icon";
import { companiesApi } from "../../api/companies";
import { waitForNextImportJobPoll } from "../../lib/import-job-watch";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * Onboarding's "bring your organization with you" path.
 *
 * Step 1 of the wizard asks for an organization name and creates an empty one.
 * A customer arriving from another Paperclip instance already has agents,
 * skills, projects, and issues, so this offers the alternative: import a
 * portability package as a new organization and continue onboarding into it.
 *
 * The import itself is the shipped company-portability pipeline
 * (`POST /companies/import` with `target.mode = new_company`), not a second
 * importer. Zip uploads travel as an async server-side job because a package
 * can be far larger than one request; a GitHub URL travels inline because it
 * is a URL and never hits the size ceiling.
 */

type SourceMode = "package" | "github";
type Phase = "idle" | "previewing" | "previewed" | "importing";

export interface ImportedOrganization {
  companyId: string;
  issuePrefix: string;
  name: string;
}

interface Props {
  onImported: (imported: ImportedOrganization) => void;
  disabled?: boolean;
}

function countFromPreview(preview: CompanyPortabilityPreviewResult | null): {
  agents: number;
  projects: number;
  issues: number;
} {
  if (!preview) return { agents: 0, projects: 0, issues: 0 };
  return {
    agents: preview.plan.agentPlans.length,
    projects: preview.plan.projectPlans.length,
    issues: preview.plan.issuePlans.length,
  };
}

/**
 * The async job reports the created company id; the board needs the issue
 * prefix too, so re-read the company once the job settles. A failed read is
 * not fatal — onboarding continues and the company list resolves the prefix.
 */
async function readImportedCompany(companyId: string): Promise<Company | null> {
  try {
    return await companiesApi.get(companyId);
  } catch {
    return null;
  }
}

export function ImportExistingOrganization({ onImported, disabled }: Props) {
  const [sourceMode, setSourceMode] = useState<SourceMode>("package");
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [newCompanyName, setNewCompanyName] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<CompanyPortabilityPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const busy = phase === "previewing" || phase === "importing";
  const counts = countFromPreview(preview);

  function importFields() {
    return {
      include: { company: true, agents: true, projects: true, issues: true },
      target: {
        mode: "new_company" as const,
        newCompanyName: newCompanyName.trim() || null,
      },
      collisionStrategy: "skip" as const,
    };
  }

  function resetPreview() {
    setPreview(null);
    setPhase("idle");
  }

  function sourceError(): string | null {
    if (sourceMode === "package") {
      return packageFile ? null : "Choose a Paperclip package to import.";
    }
    return githubUrl.trim() ? null : "Enter the GitHub URL of a Paperclip package.";
  }

  async function runPreview() {
    const missing = sourceError();
    if (missing) {
      setError(missing);
      return;
    }
    setPhase("previewing");
    setError(null);
    try {
      const fields = importFields();
      const result =
        sourceMode === "package"
          ? await companiesApi.importPreviewPackage(packageFile!, fields)
          : await companiesApi.importPreview({
              source: { type: "github", url: githubUrl.trim() },
              ...fields,
            });
      setPreview(result);
      setPhase("previewed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that package.");
      setPhase("idle");
    }
  }

  async function runImport() {
    setPhase("importing");
    setError(null);
    try {
      const fields = importFields();
      const accepted =
        sourceMode === "package"
          ? await companiesApi.importBundlePackageAsync(packageFile!, fields)
          : await companiesApi.importBundleAsync({
              source: { type: "github", url: githubUrl.trim() },
              ...fields,
            });

      let jobId = accepted.job.id;
      for (;;) {
        const status = await companiesApi.getImportJob(jobId);
        if (status.job.status === "succeeded") {
          const companyId = status.job.result?.companyId ?? status.job.importResult?.company.id;
          if (!companyId) throw new Error("Import finished without naming the organization.");
          const company = await readImportedCompany(companyId);
          onImported({
            companyId,
            issuePrefix: company?.issuePrefix ?? "",
            name: company?.name ?? status.job.importResult?.company.name ?? "Organization",
          });
          return;
        }
        if (status.job.status === "failed") {
          throw new Error(status.job.error?.message ?? "Import failed.");
        }
        jobId = status.job.id;
        await waitForNextImportJobPoll();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
      setPhase("previewed");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label>Bring an organization with you</Label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              setSourceMode("package");
              resetPreview();
            }}
            className={cn(
              "flex items-center gap-2 rounded-lg border border-transparent bg-muted px-3 py-(--sz-44px) text-left text-sm transition-colors hover:bg-muted/70 disabled:opacity-60",
              sourceMode === "package" && "ring-2 ring-ring",
            )}
          >
            <Upload className="size-4 shrink-0" />
            <span>From a package</span>
          </button>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              setSourceMode("github");
              resetPreview();
            }}
            className={cn(
              "flex items-center gap-2 rounded-lg border border-transparent bg-muted px-3 py-(--sz-44px) text-left text-sm transition-colors hover:bg-muted/70 disabled:opacity-60",
              sourceMode === "github" && "ring-2 ring-ring",
            )}
          >
            <GithubIcon className="size-4 shrink-0" />
            <span>From GitHub</span>
          </button>
        </div>
      </div>

      {sourceMode === "package" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-import-package">Package (.zip)</Label>
          <input
            id="onboarding-import-package"
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            disabled={disabled || busy}
            onChange={(e) => {
              setPackageFile(e.target.files?.[0] ?? null);
              resetPreview();
            }}
            className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-(--sz-32px) file:text-sm"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-import-github">GitHub URL</Label>
          <Input
            id="onboarding-import-github"
            className="h-(--sz-44px) rounded-lg border-transparent bg-muted shadow-none dark:bg-muted"
            placeholder="https://github.com/acme/paperclip-company"
            value={githubUrl}
            disabled={disabled || busy}
            onChange={(e) => {
              setGithubUrl(e.target.value);
              resetPreview();
            }}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="onboarding-import-name">Name (optional)</Label>
        <Input
          id="onboarding-import-name"
          className="h-(--sz-44px) rounded-lg border-transparent bg-muted shadow-none dark:bg-muted"
          placeholder="Use the name inside the package"
          value={newCompanyName}
          disabled={disabled || busy}
          onChange={(e) => setNewCompanyName(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Importing creates a new organization on this instance. Nothing is merged into an
          existing one.
        </p>
      </div>

      {preview ? (
        <div className="flex flex-col gap-1 rounded-lg bg-muted p-3 text-sm">
          <span className="font-medium">Ready to import</span>
          <span className="text-muted-foreground">
            {counts.agents} agents · {counts.projects} projects · {counts.issues} issues
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {phase === "previewed" ? (
          <Button type="button" disabled={busy} onClick={() => void runImport()}>
            <FileUp className="size-4" />
            Import organization
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || busy}
            onClick={() => void runPreview()}
          >
            {phase === "previewing" ? "Reading package…" : "Check package"}
          </Button>
        )}
      </div>
    </div>
  );
}