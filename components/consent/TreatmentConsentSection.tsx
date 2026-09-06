"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Eye, PenLine, ShieldCheck, ExternalLink, FileSignature } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getConsentTemplateContent } from "@/actions/consent-templates";
import { createConsent, getConsentsForTreatment } from "@/actions/consents";
import { ConsentDetailDialog } from "@/components/consent/ConsentDetailDialog";
import type { ConsentContent } from "@/lib/consents/content";
import {
  DEFAULT_CONSENT_TEMPLATES,
  selectTemplateKeyForTreatmentType,
} from "@/lib/consents/templates";

export interface ConsentConfig {
  required: boolean;
  templateKey: string;
  sectionEdits: { key: string; body: string }[];
  /** Set once the dentist creates the consent inline — the parent form then
   *  skips its own save-time auto-create so no duplicate consent is made. */
  createdConsentId?: string | null;
}

interface TreatmentConsentSectionProps {
  treatmentType: string;
  patientId?: string;
  appointmentId?: string;
  /** Present in edit mode — enables the inline "Create Consent" button. */
  treatmentId?: string;
  mode: "create" | "edit";
  /** Reports the current consent config up to the treatment form (create mode
   *  uses it to auto-create the consent draft when the treatment is saved). */
  onChange?: (cfg: ConsentConfig) => void;
}

const TEMPLATE_OPTIONS = DEFAULT_CONSENT_TEMPLATES.map((t) => ({ key: t.key, name: t.name }));

/**
 * TreatmentConsentSection — the inline "Consent Form Required?" block rendered
 * at the end of the treatment form. Auto-selects the consent template from the
 * treatment type, previews/edits it inline (no redirect), and reports the
 * config to the parent form. In edit mode it can create the consent draft
 * directly.
 */
export function TreatmentConsentSection({
  treatmentType,
  patientId,
  appointmentId,
  treatmentId,
  mode,
  onChange,
}: TreatmentConsentSectionProps) {
  const autoKey = selectTemplateKeyForTreatmentType(treatmentType);
  const [required, setRequired] = useState<boolean | null>(null); // null until template loads
  const [templateKey, setTemplateKey] = useState<string>(autoKey);
  const [content, setContent] = useState<ConsentContent | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [view, setView] = useState<"none" | "preview" | "edit">("none");
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Inline consent dialog (View / Sign / Download / Print) — opened right after
  // the consent is created, without leaving the treatment form.
  const [openDetail, setOpenDetail] = useState(false);

  // Load the selected template's content (and, on first load, the sensible
  // default for the Required toggle from the template metadata).
  useEffect(() => {
    let active = true;
    setLoading(true);
    getConsentTemplateContent({ templateKey })
      .then((res) => {
        if (!active) return;
        if (res.data) {
          setContent(res.data.content);
          setRequired((prev) => (prev === null ? res.data!.consent_required : prev));
          setEdits({});
        }
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [templateKey]);

  // Re-auto-select the template when the treatment type changes (until the
  // dentist overrides it manually — tracked by `overridden`).
  const [overridden, setOverridden] = useState(false);
  useEffect(() => {
    if (!overridden) setTemplateKey(selectTemplateKeyForTreatmentType(treatmentType));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treatmentType]);

  // In edit mode, restore any consent that already exists for this treatment so
  // opening a treatment shows its consent (View / Sign / Download / Print)
  // instead of offering to create a new one — the consent's state is preserved.
  useEffect(() => {
    if (mode !== "edit" || !treatmentId) return;
    let active = true;
    getConsentsForTreatment(treatmentId).then((res) => {
      if (!active || !res.data) return;
      const existing = res.data.find((c) => c.status !== "cancelled");
      if (existing) {
        setRequired(true);
        setTemplateKey(existing.template_key);
        setOverridden(true); // keep the existing consent's template, don't re-auto-select
        setCreated(existing.id);
      }
    });
    return () => {
      active = false;
    };
  }, [treatmentId, mode]);

  // Report config upward (including whether a consent was already created
  // inline, so the parent form doesn't create a duplicate on save).
  useEffect(() => {
    onChange?.({
      required: required ?? false,
      templateKey,
      sectionEdits: Object.entries(edits).map(([key, body]) => ({ key, body })),
      createdConsentId: created,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [required, templateKey, edits, created]);

  const templateName = TEMPLATE_OPTIONS.find((t) => t.key === templateKey)?.name ?? "Consent";

  function beginEdit() {
    if (!content) return;
    const seed: Record<string, string> = {};
    for (const s of content.sections) if (s.editablePerConsent) seed[s.key] = s.body;
    setEdits(seed);
    setView("edit");
  }

  async function createNow() {
    if (!patientId) return;
    setCreating(true);
    const res = await createConsent({
      patient_id: patientId,
      // treatment_id is optional — in create mode the treatment isn't saved yet,
      // so the consent is created unlinked; in edit mode it links to the treatment.
      treatment_id: treatmentId ?? "",
      appointment_id: appointmentId ?? "",
      template_key: templateKey,
      section_edits: Object.entries(edits).map(([key, body]) => ({ key, body })),
    });
    setCreating(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    if (res.data) {
      toast.success("Consent created — you can now sign, download, or print it.");
      setCreated(res.data.id);
      setOpenDetail(true); // open the full dialog immediately
    }
  }

  const displayContent: ConsentContent | null = content
    ? {
        disclaimer: content.disclaimer,
        sections: content.sections.map((s) =>
          s.editablePerConsent && edits[s.key] !== undefined ? { ...s, body: edits[s.key] } : s
        ),
      }
    : null;

  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-text-secondary" aria-hidden />
          <span className="text-sm font-medium text-text-primary">Consent Form Required?</span>
        </div>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          <button
            type="button"
            onClick={() => setRequired(true)}
            className={cn(
              "px-4 py-1 text-sm rounded-md transition-colors",
              required ? "bg-accent text-accent-foreground" : "text-text-secondary hover:text-text-primary"
            )}
          >
            Yes
          </button>
          <button
            type="button"
            onClick={() => {
              setRequired(false);
              setView("none");
            }}
            className={cn(
              "px-4 py-1 text-sm rounded-md transition-colors",
              required === false ? "bg-accent text-accent-foreground" : "text-text-secondary hover:text-text-primary"
            )}
          >
            No
          </button>
        </div>
      </div>

      {required && (
        <div className="rounded-lg border border-border bg-background p-4 space-y-3">
          {/* Template picker + preview/edit — only while no consent exists yet.
              Once a consent is created (or restored in edit mode) it is frozen
              to its own template, so these controls are replaced by the actions. */}
          {!created && (
            <>
              <Field label="Consent Template" htmlFor="consent-template"
                hint="Auto-selected from the treatment type. You can change it.">
                <Select
                  id="consent-template"
                  value={templateKey}
                  onChange={(e) => {
                    setOverridden(true);
                    setTemplateKey(e.target.value);
                  }}
                >
                  {TEMPLATE_OPTIONS.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-text-secondary">{templateName}</span>
                <div className="flex-1" />
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setView(view === "preview" ? "none" : "preview")}
                  disabled={loading || !content}
                >
                  <Eye className="h-3 w-3" aria-hidden /> Preview
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => (view === "edit" ? setView("none") : beginEdit())}
                  disabled={loading || !content}
                >
                  <PenLine className="h-3 w-3" aria-hidden /> Edit
                </Button>
              </div>

              {view === "edit" && displayContent && (
                <div className="space-y-3 border-t border-border pt-3">
                  <p className="text-[11px] text-text-secondary">
                    Edits here affect <strong>this consent document only</strong>, not the master
                    template.
                  </p>
                  {displayContent.sections
                    .filter((s) => s.editablePerConsent)
                    .map((s) => (
                      <Field key={s.key} label={s.title} htmlFor={`csec-${s.key}`}>
                        <Textarea
                          id={`csec-${s.key}`}
                          rows={2}
                          value={edits[s.key] ?? s.body}
                          onChange={(e) => setEdits((p) => ({ ...p, [s.key]: e.target.value }))}
                        />
                      </Field>
                    ))}
                </div>
              )}

              {view === "preview" && displayContent && (
                <div className="space-y-2 border-t border-border pt-3 max-h-72 overflow-y-auto">
                  {displayContent.sections
                    .filter((s) => s.body.trim().length > 0)
                    .map((s) => (
                      <div key={s.key}>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-text-strong">
                          {s.title}
                        </p>
                        <p className="text-xs text-text-body whitespace-pre-wrap">{s.body}</p>
                      </div>
                    ))}
                  <div className="rounded border border-border bg-surface px-3 py-2">
                    <p className="text-[10px] text-text-secondary">{displayContent.disclaimer}</p>
                  </div>
                </div>
              )}
            </>
          )}

          {created ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-success-border bg-success-bg px-3 py-2">
              <span className="text-xs font-medium text-success">
                This treatment has a consent form.
              </span>
              <Button type="button" variant="secondary" size="xs" onClick={() => setOpenDetail(true)}>
                <FileSignature className="h-3 w-3" aria-hidden /> Open — View / Sign / Download / Print
              </Button>
              {patientId && (
                <a
                  href={`/dentist/patients/${patientId}?tab=consent-forms`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-info underline"
                >
                  Consent Forms tab <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              )}
            </div>
          ) : patientId ? (
            <div className="space-y-1.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={createNow}
                isLoading={creating}
              >
                <FileSignature className="h-3.5 w-3.5" aria-hidden /> Create Consent Now
              </Button>
              <p className="text-[11px] text-text-secondary">
                {mode === "create"
                  ? "Create it now to sign, download, or print immediately — or just save the treatment and a draft will be created automatically."
                  : "Create the consent to sign, download, or print it right here."}
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-text-secondary">
              A consent draft will be created for this treatment when you save. You can then sign,
              download, or print it from the Consent Forms tab.
            </p>
          )}
        </div>
      )}

      {/* Full consent dialog (View / Sign / Download / Print). Rendered to
          document.body via a portal so its buttons never live inside the
          surrounding treatment <form> (which would make them submit it). */}
      {openDetail &&
        created &&
        typeof document !== "undefined" &&
        createPortal(
          <ConsentDetailDialog
            consentId={created}
            role="dentist"
            baseHref="/dentist"
            onClose={() => setOpenDetail(false)}
            onChanged={() => {}}
          />,
          document.body
        )}
    </div>
  );
}
