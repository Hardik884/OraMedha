"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { deleteTreatmentDocument } from "@/actions/treatments";
import { Trash2 } from "lucide-react";

interface DeleteTreatmentDocumentButtonProps {
  documentId: string;
}

export function DeleteTreatmentDocumentButton({ documentId }: DeleteTreatmentDocumentButtonProps) {
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    if (!confirm("Delete this document? This cannot be undone.")) return;
    startTransition(async () => {
      // The result was previously assigned and discarded, which lint flagged as
      // an unused variable and which is really a correctness bug: a refused
      // delete — RLS, a revoked session, a network failure — looked exactly
      // like a successful one. The row stayed on screen until a refresh, so the
      // dentist's reasonable conclusion was that the click had not registered,
      // and the natural next move is to click it again.
      const res = await deleteTreatmentDocument(documentId);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Document deleted.");
    });
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={isPending}
      aria-label="Delete document"
      className="shrink-0 p-2 -m-2 text-text-disabled hover:text-danger disabled:opacity-50"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}
