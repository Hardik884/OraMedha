"use server";

import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import {
  type ActionResult,
  type PortalLinkStatus,
  type PortalUser,
  type Patient,
} from "@/types";

/**
 * Portal Link Server Actions
 *
 * READS the link between a Supabase Auth account and a patient record, and
 * lets a linked patient edit their own contact details. It no longer CREATES
 * that link, and it can no longer create a patient record at all.
 *
 * See CLAUDE.md §5.8 for the portal linking architecture. The short version:
 *
 *   - a patient record and an auth account are independent. Most patients
 *     never have an account;
 *   - the link is written in ONE place, actions/portal-activation.ts, at the
 *     moment the patient proves control of the address their clinic put on
 *     their record and chooses a password;
 *   - nothing in either file accepts a clinic from the browser.
 *
 * WHAT USED TO BE HERE
 *   linkPortalAccount and _createAndLinkNewPatient — the self-registration
 *   path, where a visitor picked a clinic, was matched to a patient by phone
 *   number, and had a record created for them if no match was found. Removed;
 *   the section header below records why. normalizePhone went with them: phone
 *   is not unique even within one clinic
 *   (20260822000000_drop_patient_phone_uniqueness.sql), which is precisely why
 *   matching on it was the wrong idea.
 *
 * Key invariants, unchanged:
 *   - patient_portal_links.user_id UNIQUE    (one patient per portal account)
 *   - patient_portal_links.patient_id UNIQUE (one account per patient record)
 *   - clinic_id is never stored in portal_links — always derived via
 *     patients.clinic_id
 */

// =============================================================================
// linkPortalAccount — REMOVED
//
// This was the self-service portal linking flow: it took a clinicId and a phone
// number FROM THE BROWSER, searched that clinic for a matching patient, and —
// when it found none — CREATED a new patient record from whatever name was
// typed in (_createAndLinkNewPatient, deleted with it).
//
// Both halves are incompatible with how portal access works after 853e188:
//
//   - the clinic picker was the last place a visitor could assert which tenant
//     they belong to. Eligibility is now decided by an address the CLINIC put
//     on a record, and the clinic is read from that record;
//   - creating a patient record from the portal is what produced the duplicate
//     records clinics then had to merge. The person already existed, matched on
//     a phone number that is not unique even within one clinic
//     (20260822000000_drop_patient_phone_uniqueness.sql).
//
// /portal/setup stopped rendering the form that called this, but the action
// itself stayed exported — and an exported "use server" function is a live
// endpoint, not dead code. It is deleted here rather than left for the next
// person to find, along with components/patient/PortalLinkForm.tsx.
//
// The replacement is actions/portal-activation.ts. Nothing in it accepts a
// clinic from the browser, and it never creates a patient record.
// =============================================================================

// =============================================================================
// getLinkedPatient — resolves authenticated portal user's patient_id + clinic_id
// =============================================================================

export async function getLinkedPatient(): Promise<ActionResult<PortalUser>> {
  try {
    const supabase = await createServerClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { data: null, error: "Unauthorized" };

    const { data, error } = await supabase
      .from("patient_portal_links")
      .select("patient_id, patients!inner(clinic_id)")
      .eq("user_id", user.id)
      .single();

    if (error || !data) {
      return { data: null, error: "Portal account not linked." };
    }

    const row = data as {
      patient_id: string;
      patients: { clinic_id: string };
    };

    return {
      data: {
        id: user.id,
        patientId: row.patient_id,
        clinicId: row.patients.clinic_id,
      },
      error: null,
    };
  } catch (err) {
    console.error("[getLinkedPatient] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// checkPortalLinkStatus — for /portal/setup page state
// =============================================================================

export async function checkPortalLinkStatus(): Promise<
  ActionResult<PortalLinkStatus>
> {
  try {
    const supabase = await createServerClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { data: "unlinked", error: null };

    const { data } = await supabase
      .from("patient_portal_links")
      .select("patient_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (data) {
      return { data: "linked", error: null };
    }

    return { data: "unlinked", error: null };
  } catch (err) {
    console.error("[checkPortalLinkStatus] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPortalProfile — get the authenticated patient's own profile
// Only patient-visible, non-clinical fields returned.
// =============================================================================

export type PortalPatientProfile = {
  id: string;
  name: string;
  phone: string | null;
  date_of_birth: string | null;
  gender: "male" | "female" | "other" | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  total_visits: number;
  last_visit: string | null;
  created_at: string;
};

export async function getPortalProfile(): Promise<
  ActionResult<PortalPatientProfile>
> {
  try {
    const supabase = await createServerClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = supabase;

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { data: null, error: "Unauthorized" };

    // Resolve patient via portal link
    const { data: link } = await db
      .from("patient_portal_links")
      .select("patient_id")
      .eq("user_id", user.id)
      .single();

    if (!link?.patient_id) {
      return { data: null, error: "Portal account not linked." };
    }

    const { data, error } = await db
      .from("patients")
      .select(
        "id, name, phone, date_of_birth, gender, address, emergency_contact_name, emergency_contact_phone, total_visits, last_visit, created_at"
      )
      .eq("id", link.patient_id)
      .is("deleted_at", null)
      .single();

    if (error || !data) {
      return { data: null, error: "Patient record not found." };
    }

    return { data: data as PortalPatientProfile, error: null };
  } catch (err) {
    console.error("[getPortalProfile] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// updatePortalProfile — patient can update allowed demographic fields only.
// Clinical fields (notes) and system fields (total_visits, last_visit) are
// never exposed or updatable from this action.
//
// Note: this file uses "use server" so only async functions may be exported.
// The PORTAL_UPDATABLE_FIELDS constant and UpdatePortalProfileSchema/Input
// type live in lib/portal-profile.ts so they can be imported by consumers.
// =============================================================================

import {
  UpdatePortalProfileSchema,
} from "@/lib/portal-profile";
import type { PatientUpdate } from "@/types";

export async function updatePortalProfile(
  input: unknown
): Promise<ActionResult<PortalPatientProfile>> {
  try {
    const parsed = UpdatePortalProfileSchema.safeParse(input);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      const fieldName = firstError?.path[0] || "field";
      const message = firstError?.message || "Invalid input";
      return {
        data: null,
        error: `${String(fieldName)}: ${message}`,
      };
    }

    const supabase = await createServerClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = supabase;

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { data: null, error: "Unauthorized" };

    // Resolve patient via portal link
    const { data: link, error: linkError } = await db
      .from("patient_portal_links")
      .select("patient_id")
      .eq("user_id", user.id)
      .single();

    if (linkError || !link?.patient_id) {
      console.error("[updatePortalProfile] portal link lookup:", linkError);
      return { data: null, error: "Portal account not linked." };
    }

    // Build a typed update payload — only the fields patients are allowed to edit.
    const updates: PatientUpdate = {
      updated_at: new Date().toISOString(),
      ...(parsed.data.phone !== undefined && { phone: parsed.data.phone || null }),
      ...(parsed.data.address !== undefined && { address: parsed.data.address || null }),
      ...(parsed.data.emergency_contact_name !== undefined && {
        emergency_contact_name: parsed.data.emergency_contact_name || null,
      }),
      ...(parsed.data.emergency_contact_phone !== undefined && {
        emergency_contact_phone: parsed.data.emergency_contact_phone || null,
      }),
    };

    const { data, error } = await db
      .from("patients")
      .update(updates)
      .eq("id", link.patient_id)
      .is("deleted_at", null)
      .select(
        "id, name, phone, date_of_birth, gender, address, emergency_contact_name, emergency_contact_phone, total_visits, last_visit, created_at"
      )
      .single();

    if (error) {
      console.error("[updatePortalProfile] update error:", error);
      
      // Provide more specific error messages based on the error code
      if (error.code === "PGRST116") {
        return { data: null, error: "Profile not found or access denied." };
      }
      if (error.code === "42501") {
        return { data: null, error: "Permission denied. Unable to update profile." };
      }
      if (error.message) {
        return { data: null, error: `Unable to update profile: ${error.message}` };
      }
      
      return { data: null, error: "Unable to update profile. Please try again." };
    }

    if (!data) {
      console.error("[updatePortalProfile] no data returned after update");
      return { data: null, error: "Profile update failed. Please try again." };
    }

    revalidatePath("/portal/profile");
    // Also revalidate dentist and receptionist patient views so changes appear instantly
    revalidatePath("/dentist/patients");
    revalidatePath("/receptionist/patients");

    return { data: data as PortalPatientProfile, error: null };
  } catch (err) {
    console.error("[updatePortalProfile] unexpected error:", err);
    
    // In development, expose the actual error for debugging
    if (process.env.NODE_ENV === "development" && err instanceof Error) {
      return { data: null, error: `Development error: ${err.message}` };
    }
    
    return { data: null, error: "An unexpected error occurred. Please try again." };
  }
}
